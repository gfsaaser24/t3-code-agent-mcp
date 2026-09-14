import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { T3RpcClient, T3RpcError } from "../src/rpc.js";

/**
 * A fake T3 socket speaking the Effect RPC JSON envelope: unary requests get
 * an Exit, streaming requests get Chunks gated on client Acks.
 */
describe("T3RpcClient", () => {
  let wss: WebSocketServer;
  let origin: string;
  let seen: Array<{ auth: string | undefined; path: string }>;
  let inbound: unknown[];

  beforeEach(async () => {
    seen = [];
    inbound = [];
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const address = wss.address();
    if (typeof address === "string") throw new Error("unexpected address");
    origin = `http://127.0.0.1:${address.port}`;
    wss.on("connection", (socket: WebSocket, request) => {
      seen.push({ auth: request.headers.authorization, path: request.url ?? "" });
      const acked = new Map<string, () => void>();
      socket.on("message", async (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        inbound.push(message);
        if (message._tag === "Ping") return socket.send(JSON.stringify({ _tag: "Pong" }));
        if (message._tag === "Ack") return acked.get(String(message.requestId))?.();
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
          case "count": {
            for (let i = 1; i <= 3; i++) {
              socket.send(JSON.stringify({ _tag: "Chunk", requestId: id, values: [{ n: i }] }));
              await new Promise<void>((resolve) => acked.set(id, resolve));
            }
            return socket.send(JSON.stringify({ _tag: "Exit", requestId: id, exit: { _tag: "Success", value: undefined } }));
          }
          case "forever": {
            socket.send(JSON.stringify({ _tag: "Chunk", requestId: id, values: [{ n: 1 }] }));
            return;
          }
        }
      });
    });
  });

  afterEach(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it("connects to /ws with a bearer header and resolves unary calls", async () => {
    const client = new T3RpcClient(origin, "secret");
    const result = await client.call<{ a: number }>("echo", { a: 1 });
    expect(result).toEqual({ a: 1 });
    expect(seen[0]?.auth).toBe("Bearer secret");
    expect(seen[0]?.path.startsWith("/ws?")).toBe(true);
    client.close();
  });

  it("turns tagged failures into T3RpcError with the tag and message", async () => {
    const client = new T3RpcClient(origin, "secret");
    await expect(client.call("fail", {})).rejects.toMatchObject({
      tag: "EnvironmentScopeRequiredError",
      message: "EnvironmentScopeRequiredError: needs operate",
    });
    await expect(client.call("fail", {})).rejects.toBeInstanceOf(T3RpcError);
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
    // The Interrupt frame is in flight when stream() resolves locally; give the fake server a beat to receive it.
    const sawInterrupt = () => inbound.some((m) => (m as { _tag: string })._tag === "Interrupt");
    for (let i = 0; i < 50 && !sawInterrupt(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(sawInterrupt()).toBe(true);
    client.close();
  });

  it("gives up on a stream after the timeout without throwing", async () => {
    const client = new T3RpcClient(origin, "secret");
    const started = Date.now();
    await client.stream("forever", {}, () => false, 100);
    expect(Date.now() - started).toBeLessThan(2000);
    client.close();
  });
});
