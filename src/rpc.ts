import WebSocket from "ws";

import { summarizeError } from "./http.js";

/**
 * Minimal client for T3's WebSocket RPC (Effect `unstable/rpc` with JSON
 * serialization). One request per `call`; streaming responses are drained via
 * `stream`, acknowledging every chunk because the server back-pressures on
 * client acks. A ping is sent every 5 seconds like the first-party client.
 */
type Exit =
  | { _tag: "Success"; value: unknown }
  | { _tag: "Failure"; cause: Array<{ _tag: string; error?: unknown; defect?: unknown }> };

type ServerMessage =
  | { _tag: "Chunk"; requestId: string | number; values: unknown[] }
  | { _tag: "Exit"; requestId: string | number; exit: Exit }
  | { _tag: "Defect"; defect: unknown }
  | { _tag: "Pong" };

interface Pending {
  onChunk?: (value: unknown) => void;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class T3RpcError extends Error {
  constructor(
    readonly tag: string,
    readonly detail: unknown,
    message: string,
  ) {
    super(message);
  }
}

export function exitToError(exit: Extract<Exit, { _tag: "Failure" }>): T3RpcError {
  const first = exit.cause[0];
  if (!first) return new T3RpcError("Unknown", exit, "RPC failed with an empty cause.");
  if (first._tag === "Fail") {
    const error = first.error;
    const tag =
      error && typeof error === "object" && typeof (error as { _tag?: unknown })._tag === "string"
        ? ((error as { _tag: string })._tag as string)
        : "Fail";
    return new T3RpcError(tag, error, summarizeError(error));
  }
  if (first._tag === "Interrupt") return new T3RpcError("Interrupt", first, "RPC was interrupted.");
  // Schema rejections surface as defects; phrase them as a request problem, not a crash.
  return new T3RpcError("Die", first.defect, `T3 rejected the request: ${summarizeError(first.defect)}`);
}

export class T3RpcClient {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private pingTimer: NodeJS.Timeout | null = null;
  private opening: Promise<WebSocket> | null = null;

  constructor(
    private readonly origin: string,
    private readonly token: string,
  ) {}

  private async connect(): Promise<WebSocket> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return this.socket;
    if (this.opening) return this.opening;
    this.opening = new Promise<WebSocket>((resolve, reject) => {
      const url = new URL("/ws", this.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("clientSurface", "web");
      url.searchParams.set("connectionMethod", "direct");
      const socket = new WebSocket(url, {
        headers: { authorization: `Bearer ${this.token}` },
        handshakeTimeout: 10_000,
      });
      socket.on("open", () => {
        this.socket = socket;
        this.opening = null;
        this.pingTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ _tag: "Ping" }));
        }, 5000);
        resolve(socket);
      });
      socket.on("message", (data) => this.handleMessage(data.toString()));
      socket.on("error", (error) => {
        this.opening = null;
        reject(new Error(`T3 WebSocket error: ${error.message}`));
        this.failAll(new Error(`T3 WebSocket error: ${error.message}`));
      });
      socket.on("close", (code, reason) => {
        this.opening = null;
        this.socket = null;
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = null;
        const detail = reason.toString();
        const message = `T3 WebSocket closed (${code}${detail ? `: ${detail}` : ""})`;
        reject(new Error(message));
        this.failAll(new Error(message));
      });
    });
    return this.opening;
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private handleMessage(raw: string): void {
    let parsed: ServerMessage | ServerMessage[];
    try {
      parsed = JSON.parse(raw) as ServerMessage | ServerMessage[];
    } catch {
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) {
      if (message._tag === "Pong") continue;
      if (message._tag === "Defect") {
        this.failAll(new Error(`T3 RPC defect: ${summarizeError(message.defect)}`));
        continue;
      }
      const pending = this.pending.get(String(message.requestId));
      if (!pending) continue;
      if (message._tag === "Chunk") {
        for (const value of message.values) pending.onChunk?.(value);
        this.socket?.send(JSON.stringify({ _tag: "Ack", requestId: message.requestId }));
        continue;
      }
      this.pending.delete(String(message.requestId));
      if (message.exit._tag === "Success") pending.resolve(message.exit.value);
      else pending.reject(exitToError(message.exit));
    }
  }

  private async send(tag: string, payload: unknown, onChunk?: (value: unknown) => void): Promise<{ id: string; done: Promise<unknown> }> {
    const socket = await this.connect();
    const id = String(this.nextId++);
    const done = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { onChunk, resolve, reject });
    });
    socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    return { id, done };
  }

  /** Unary RPC: resolves with the decoded success value. */
  async call<T>(tag: string, payload: unknown): Promise<T> {
    const { done } = await this.send(tag, payload);
    return (await done) as T;
  }

  /**
   * Streaming RPC. `onChunk` returns true to stop early, which interrupts the
   * server-side stream. Resolves when the stream ends or is stopped.
   */
  async stream(tag: string, payload: unknown, onChunk: (value: unknown) => boolean | void, timeoutMs?: number): Promise<void> {
    let stopped = false;
    let requestId = "";
    const { id, done } = await this.send(tag, payload, (value) => {
      if (stopped) return;
      if (onChunk(value) === true) {
        stopped = true;
        this.interrupt(requestId);
      }
    });
    requestId = id;
    let timer: NodeJS.Timeout | null = null;
    const timeout =
      timeoutMs === undefined
        ? null
        : new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), timeoutMs);
          });
    try {
      const outcome = await (timeout ? Promise.race([done, timeout]) : done);
      if (outcome === "timeout") {
        stopped = true;
        this.interrupt(id);
      }
    } catch (error) {
      if (!(stopped && error instanceof T3RpcError && error.tag === "Interrupt")) throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private interrupt(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (pending) {
      this.pending.delete(requestId);
      pending.resolve(undefined);
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ _tag: "Interrupt", requestId }));
    }
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.socket?.close();
    this.socket = null;
  }
}
