import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { T3RpcClient, T3RpcError } from "../src/rpc.js";

/**
 * A fake T3 socket speaking the Effect RPC JSON envelope: unary requests get
 * an Exit, streaming requests get Chunks gated on client Acks.
 */
describe("T3RpcClient", () => {
  let http: Server;
  let wss: WebSocketServer;
  let origin: string;
  let seen: Array<{ auth: string | undefined; path: string }>;
  let inbound: unknown[];
  let interrupted: Promise<void>;
  let onInterrupt: () => void;
  let rejectUpgradeWith: number | null;

  beforeEach(async () => {
    seen = [];
    inbound = [];
    rejectUpgradeWith = null;
    interrupted = new Promise<void>((resolve) => (onInterrupt = resolve));
    http = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    wss = new WebSocketServer({ noServer: true });
    http.on("upgrade", (request, socket, head) => {
      if (rejectUpgradeWith) {
        socket.write(`HTTP/1.1 ${rejectUpgradeWith} Nope\r\nContent-Length: 0\r\n\r\n`);
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("unexpected address");
    origin = `http://127.0.0.1:${address.port}`;
    wss.on("connection", (socket: WebSocket, request) => {
      seen.push({ auth: request.headers.authorization, path: request.url ?? "" });
      const acked = new Map<string, () => void>();
      socket.on("message", async (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        inbound.push(message);
        if (message._tag === "Ping") return socket.send(JSON.stringify({ _tag: "Pong" }));
        if (message._tag === "Ack") return acked.get(String(message.requestId))?.();
        if (message._tag === "Interrupt") return onInterrupt();
        if (message._tag !== "Request") return;
        const id = message.id as string;
        switch (message.tag) {
          case "echo":
            return socket.send(JSON.stringify({ _tag: "Exit", requestId: id, exit: { _tag: "Success", value: message.payload } }));
          case "fail":
            return socket.send(
              JSON.stringify({
                _tag: "Exit",
                requestId: id,
                exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "EnvironmentScopeRequiredError", message: "needs operate" } }] },
              }),
            );
          case "rejected":
            return socket.send(
              JSON.stringify({
                _tag: "Exit",
                requestId: id,
                exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "OrchestrationCommandPreviouslyRejectedError", message: "was rejected" } }] },
              }),
            );
          case "protocol":
            return socket.send(JSON.stringify({ _tag: "ClientProtocolError", error: { message: "bad frame" } }));
          case "count": {
            for (let i = 1; i <= 3; i++) {
              socket.send(JSON.stringify({ _tag: "Chunk", requestId: id, values: [{ n: i }] }));
              await new Promise<void>((resolve) => acked.set(id, resolve));
            }
            return socket.send(JSON.stringify({ _tag: "Exit", requestId: id, exit: { _tag: "Success", value: undefined } }));
          }
          case "forever":
            socket.send(JSON.stringify({ _tag: "Chunk", requestId: id, values: [{ n: 1 }] }));
            return;
          case "drop":
            socket.terminate();
            return;
          case "silent":
            return;
        }
      });
    });
  });

  afterEach(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  it("connects to /ws with a bearer header and resolves unary calls", async () => {
    const client = new T3RpcClient(origin, "secret");
    const result = await client.call<{ a: number }>("echo", { a: 1 });
    expect(result).toEqual({ a: 1 });
    expect(seen[0]?.auth).toBe("Bearer secret");
    expect(seen[0]?.path.startsWith("/ws?")).toBe(true);
    client.close();
  });

  it("turns tagged failures into T3RpcError with the tag and message, adding hints where T3 has none", async () => {
    const client = new T3RpcClient(origin, "secret");
    await expect(client.call("fail", {})).rejects.toMatchObject({
      tag: "EnvironmentScopeRequiredError",
      message: "EnvironmentScopeRequiredError: needs operate",
    });
    await expect(client.call("fail", {})).rejects.toBeInstanceOf(T3RpcError);
    await expect(client.call("rejected", {})).rejects.toThrow(/new idempotencyKey/);
    client.close();
  });

  it("acks every chunk so back-pressured streams drain to completion", async () => {
    const client = new T3RpcClient(origin, "secret");
    const chunks: unknown[] = [];
    await client.stream("count", {}, (value) => {
      chunks.push(value);
    });
    expect(chunks).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(inbound.filter((m) => (m as { _tag: string })._tag === "Ack")).toHaveLength(3);
    client.close();
  });

  it("stops a stream early when the handler returns true and sends Interrupt", async () => {
    const client = new T3RpcClient(origin, "secret");
    let calls = 0;
    await client.stream("count", {}, () => ++calls >= 1);
    expect(calls).toBe(1);
    await interrupted;
    client.close();
  });

  it("gives up on a stream after the timeout without throwing", async () => {
    const client = new T3RpcClient(origin, "secret");
    const started = Date.now();
    await client.stream("forever", {}, () => false, 100);
    expect(Date.now() - started).toBeLessThan(2000);
    client.close();
  });

  it("rejects pending work when the socket drops, then reconnects for the next call", async () => {
    const client = new T3RpcClient(origin, "secret");
    await expect(client.call("drop", {})).rejects.toThrow(/WebSocket closed/);
    expect(await client.call("echo", { ok: true })).toEqual({ ok: true });
    expect(seen).toHaveLength(2);
    client.close();
  });

  it("fails pending calls on ClientProtocolError and times out lost replies", async () => {
    const client = new T3RpcClient(origin, "secret");
    await expect(client.call("protocol", {})).rejects.toThrow(/ClientProtocolError: bad frame/);
    await expect(client.call("silent", {}, 100)).rejects.toThrow(/timed out/);
    client.close();
  });

  it("explains a rejected handshake as a token problem", async () => {
    rejectUpgradeWith = 401;
    const client = new T3RpcClient(origin, "stale");
    await expect(client.call("echo", {})).rejects.toThrow(/rejected the stored token \(401\).*pair/);
  });

  it("close() during the handshake terminates the connecting socket and rejects later calls", async () => {
    const client = new T3RpcClient(origin, "secret");
    const pending = client.call("echo", {});
    client.close();
    await expect(pending).rejects.toThrow(/closed/);
    await expect(client.call("echo", {})).rejects.toThrow(/closed/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(Array.from(wss.clients).filter((c) => c.readyState === c.OPEN)).toHaveLength(0);
  });

  it("a stale socket's failure does not reject requests on the new socket", async () => {
    const client = new T3RpcClient(origin, "secret");
    await client.call("echo", {});
    const stale = Array.from(wss.clients)[0]!;
    // Pause the server's close so the old socket is still CLOSING while a new call connects.
    const dropped = client.call("drop", {});
    await expect(dropped).rejects.toThrow(/closed/);
    const next = client.call("echo", { fresh: true });
    stale.emit("close");
    expect(await next).toEqual({ fresh: true });
  });
});
