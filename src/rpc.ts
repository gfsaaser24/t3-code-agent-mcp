import WebSocket from "ws";

import { summarizeError } from "./http.js";

/**
 * Minimal client for T3's WebSocket RPC (Effect `unstable/rpc` with JSON
 * serialization). Unary requests resolve on `Exit`; streaming requests are
 * drained via `stream`, acknowledging every chunk on the socket that received
 * it because the server back-pressures on client acks. A ping goes out every
 * 5 seconds like the first-party client. All socket state is per-socket so a
 * late `close` from an old socket can never clobber a newer one.
 */
type Exit =
  | { _tag: "Success"; value: unknown }
  | { _tag: "Failure"; cause: Array<{ _tag: string; error?: unknown; defect?: unknown }> };

type ServerMessage =
  | { _tag: "Chunk"; requestId: string | number; values: unknown[] }
  | { _tag: "Exit"; requestId: string | number; exit: Exit }
  | { _tag: "Defect"; defect: unknown }
  | { _tag: "ClientProtocolError"; error: unknown }
  | { _tag: "Pong" };

interface Pending {
  socket: WebSocket;
  onChunk?: (value: unknown) => void;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class T3RpcError extends Error {
  constructor(
    readonly tag: string,
    message: string,
  ) {
    super(message);
  }
}

export const PAIR_HINT = "Run: t3-code-agent-mcp pair <pairing-url-or-code>";

export function exitToError(exit: Extract<Exit, { _tag: "Failure" }>): T3RpcError {
  const first = exit.cause[0];
  if (!first) return new T3RpcError("Unknown", "RPC failed with an empty cause.");
  if (first._tag === "Fail") {
    const error = first.error;
    const tag =
      error && typeof error === "object" && typeof (error as { _tag?: unknown })._tag === "string"
        ? (error as { _tag: string })._tag
        : "Fail";
    return new T3RpcError(tag, explainTaggedError(tag, summarizeError(error)));
  }
  if (first._tag === "Interrupt") return new T3RpcError("Interrupt", "RPC was interrupted.");
  // Schema rejections surface as defects; phrase them as a request problem, not a crash.
  return new T3RpcError("Die", `T3 rejected the request: ${summarizeError(first.defect)}`);
}

/** Add the one hint an agent needs for T3's durable idempotency errors. */
function explainTaggedError(tag: string, message: string): string {
  if (tag === "OrchestrationCommandPreviouslyRejectedError") {
    return `${message} This idempotencyKey was rejected before and can never be retried. Fix the cause, then call again with a new idempotencyKey.`;
  }
  if (tag === "EnvironmentAuthInvalidError" || tag === "EnvironmentAuthorizationError") {
    return `${message} ${PAIR_HINT}`;
  }
  return message;
}

const DEFAULT_CALL_TIMEOUT_MS = 60_000;

export class T3RpcClient {
  private socket: WebSocket | null = null;
  private connecting: WebSocket | null = null;
  private opening: Promise<WebSocket> | null = null;
  private closed = false;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;

  constructor(
    private readonly origin: string,
    private readonly token: string,
  ) {}

  private connect(): Promise<WebSocket> {
    if (this.closed) return Promise.reject(new Error("T3 RPC client is closed."));
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    if (this.opening) return this.opening;
    const attempt = new Promise<WebSocket>((resolve, reject) => {
      const url = new URL("/ws", this.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("clientSurface", "web");
      url.searchParams.set("connectionMethod", "direct");
      const socket = new WebSocket(url, {
        headers: { authorization: `Bearer ${this.token}` },
        handshakeTimeout: 10_000,
      });
      this.connecting = socket;
      let pingTimer: NodeJS.Timeout | null = null;
      let rejectedWith: Error | null = null;
      const fail = (error: Error) => {
        if (this.opening === attempt) this.opening = null;
        if (this.connecting === socket) this.connecting = null;
        if (this.socket === socket) this.socket = null;
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = null;
        rejectedWith ??= error;
        reject(error);
        this.failSocket(socket, error);
      };
      socket.on("unexpected-response", (_request, response) => {
        const status = response.statusCode ?? 0;
        const message =
          status === 401 || status === 403
            ? `T3 rejected the stored token (${status}). ${PAIR_HINT}`
            : `T3 WebSocket handshake failed (${status}).`;
        socket.terminate();
        fail(new Error(message));
      });
      socket.on("open", () => {
        if (this.closed) {
          socket.terminate();
          fail(new Error("T3 RPC client is closed."));
          return;
        }
        this.socket = socket;
        if (this.connecting === socket) this.connecting = null;
        if (this.opening === attempt) this.opening = null;
        pingTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ _tag: "Ping" }));
        }, 5000);
        resolve(socket);
      });
      socket.on("message", (data) => this.handleMessage(socket, data.toString()));
      socket.on("error", (error) => {
        if (!rejectedWith) fail(new Error(`T3 WebSocket error: ${error.message}`));
      });
      socket.on("close", (code, reason) => {
        if (rejectedWith) return;
        const detail = reason.toString();
        fail(new Error(`T3 WebSocket closed (${code}${detail ? `: ${detail}` : ""})`));
      });
    });
    this.opening = attempt;
    return attempt;
  }

  /** Reject only the requests that were sent on this socket; a newer socket's requests are untouched. */
  private failSocket(socket: WebSocket, error: Error): void {
    for (const [id, pending] of Array.from(this.pending.entries())) {
      if (pending.socket !== socket) continue;
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private handleMessage(socket: WebSocket, raw: string): void {
    let parsed: ServerMessage | ServerMessage[];
    try {
      parsed = JSON.parse(raw) as ServerMessage | ServerMessage[];
    } catch {
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) {
      if (message._tag === "Pong") continue;
      if (message._tag === "Defect" || message._tag === "ClientProtocolError") {
        const detail = message._tag === "Defect" ? message.defect : message.error;
        this.failSocket(socket, new Error(`T3 RPC ${message._tag}: ${summarizeError(detail)}`));
        continue;
      }
      const pending = this.pending.get(String(message.requestId));
      if (!pending || pending.socket !== socket) continue;
      if (message._tag === "Chunk") {
        for (const value of message.values) pending.onChunk?.(value);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ _tag: "Ack", requestId: message.requestId }));
        }
        continue;
      }
      this.pending.delete(String(message.requestId));
      if (message.exit._tag === "Success") pending.resolve(message.exit.value);
      else pending.reject(exitToError(message.exit));
    }
  }

  private async send(
    tag: string,
    payload: unknown,
    onChunk?: (value: unknown, requestId: string) => void,
  ): Promise<{ id: string; done: Promise<unknown> }> {
    const socket = await this.connect();
    const id = String(this.nextId++);
    const done = new Promise<unknown>((resolve, reject) => {
      try {
        socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.pending.set(id, { socket, onChunk: onChunk && ((value) => onChunk(value, id)), resolve, reject });
    });
    return { id, done };
  }

  /** Unary RPC: resolves with the decoded success value, or rejects after the timeout. */
  async call<T>(tag: string, payload: unknown, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<T> {
    const { id, done } = await this.send(tag, payload);
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(id);
        this.sendInterrupt(id);
        reject(new Error(`T3 RPC ${tag} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    });
    try {
      return (await Promise.race([done, timeout])) as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Streaming RPC. `onChunk` returns true to stop early, which interrupts the
   * server-side stream. Resolves when the stream ends, is stopped, or the
   * timeout passes.
   */
  async stream(
    tag: string,
    payload: unknown,
    onChunk: (value: unknown) => boolean | void,
    timeoutMs?: number,
  ): Promise<void> {
    let stopped = false;
    const { id, done } = await this.send(tag, payload, (value, requestId) => {
      if (stopped) return;
      if (onChunk(value) === true) {
        stopped = true;
        this.interrupt(requestId);
      }
    });
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
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Settle the local stream promise immediately and tell the server to stop. */
  private interrupt(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (pending) {
      this.pending.delete(requestId);
      pending.resolve(undefined);
    }
    this.sendInterrupt(requestId);
  }

  private sendInterrupt(requestId: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ _tag: "Interrupt", requestId }));
    }
  }

  /** Stop everything, including a handshake still in flight. Further calls reject. */
  close(): void {
    this.closed = true;
    const socket = this.socket;
    const connecting = this.connecting;
    this.socket = null;
    this.connecting = null;
    socket?.close();
    connecting?.terminate();
  }
}
