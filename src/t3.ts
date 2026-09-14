import { discoverServer, type DiscoveredServer } from "./discovery.js";
import { resolveAccessToken } from "./credentials.js";
import { makeHttpClient, type HttpClient } from "./http.js";
import { T3RpcClient } from "./rpc.js";
import type {
  DispatchResult,
  InteractionMode,
  ModelSelection,
  RuntimeMode,
  ServerConfig,
  ShellSnapshot,
  ThreadDetailSnapshot,
  VcsListRefsResult,
} from "./types.js";

export interface T3Connection {
  server: DiscoveredServer;
  tokenSource: string;
  http: HttpClient;
  rpc: T3RpcClient;
}

export async function connect(env: NodeJS.ProcessEnv = process.env): Promise<T3Connection> {
  const server = await discoverServer({ env });
  const { token, source } = await resolveAccessToken(server.origin, env);
  return {
    server,
    tokenSource: source,
    http: makeHttpClient(server.origin, token),
    rpc: new T3RpcClient(server.origin, token),
  };
}

export interface ThreadCreateSpec {
  commandId: string;
  threadId: string;
  messageId: string;
  projectId: string;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  branch: string | null;
  worktreePath: string | null;
  text: string;
  newWorktree?: { projectCwd: string; baseBranch: string; branch?: string; runSetupScript: boolean };
}

/**
 * Thin, typed wrappers over T3's HTTP and RPC surfaces. Commands go over HTTP
 * `/api/orchestration/dispatch` (durable, idempotent on commandId); config and
 * git refs are RPC-only in T3 so they go over the socket.
 */
export class T3Api {
  constructor(private readonly conn: T3Connection) {}

  shell(): Promise<ShellSnapshot> {
    return this.conn.http.get<ShellSnapshot>("/api/orchestration/shell");
  }

  thread(threadId: string, turnLimit?: number): Promise<ThreadDetailSnapshot> {
    return this.conn.http.get<ThreadDetailSnapshot>(`/api/orchestration/threads/${encodeURIComponent(threadId)}`, {
      turnLimit,
    });
  }

  config(): Promise<ServerConfig> {
    return this.conn.rpc.call<ServerConfig>("server.getConfig", {});
  }

  /** All local refs for a checkout. T3 pages at 200, so follow `nextCursor` until it is null. */
  async listRefs(cwd: string): Promise<VcsListRefsResult> {
    const refs: VcsListRefsResult["refs"] = [];
    let cursor: number | undefined;
    let last: VcsListRefsResult | undefined;
    for (let page = 0; page < 50; page++) {
      last = await this.conn.rpc.call<VcsListRefsResult>("vcs.listRefs", {
        cwd,
        refKind: "local",
        refresh: page === 0,
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      refs.push(...last.refs);
      if (last.nextCursor === null || last.nextCursor === undefined) break;
      cursor = last.nextCursor;
    }
    return { ...(last as VcsListRefsResult), refs, nextCursor: null };
  }

  /**
   * Commands go over the RPC socket, not `POST /api/orchestration/dispatch`:
   * only the socket handler expands `bootstrap` (create thread + prepare
   * worktree) before applying the turn, and it returns typed errors instead
   * of a generic 500.
   */
  dispatch(command: Record<string, unknown>): Promise<DispatchResult> {
    return this.conn.rpc.call<DispatchResult>("orchestration.dispatchCommand", command);
  }

  /** Create a thread and start its first turn in one durable command. */
  createThreadWithFirstTurn(spec: ThreadCreateSpec): Promise<DispatchResult> {
    const createdAt = new Date().toISOString();
    const bootstrap: Record<string, unknown> = {
      createThread: {
        projectId: spec.projectId,
        title: spec.title,
        modelSelection: spec.modelSelection,
        runtimeMode: spec.runtimeMode,
        interactionMode: spec.interactionMode,
        branch: spec.branch,
        worktreePath: spec.worktreePath,
        createdAt,
      },
    };
    if (spec.newWorktree) {
      bootstrap.prepareWorktree = {
        projectCwd: spec.newWorktree.projectCwd,
        baseBranch: spec.newWorktree.baseBranch,
        ...(spec.newWorktree.branch ? { branch: spec.newWorktree.branch } : {}),
      };
      bootstrap.runSetupScript = spec.newWorktree.runSetupScript;
    }
    return this.dispatch({
      type: "thread.turn.start",
      commandId: spec.commandId,
      threadId: spec.threadId,
      message: { messageId: spec.messageId, role: "user", text: spec.text, attachments: [] },
      modelSelection: spec.modelSelection,
      titleSeed: spec.title,
      runtimeMode: spec.runtimeMode,
      interactionMode: spec.interactionMode,
      bootstrap,
      createdAt,
    });
  }

  startTurn(input: {
    commandId: string;
    threadId: string;
    messageId: string;
    text: string;
    runtimeMode: RuntimeMode;
    interactionMode: InteractionMode;
  }): Promise<DispatchResult> {
    return this.dispatch({
      type: "thread.turn.start",
      commandId: input.commandId,
      threadId: input.threadId,
      message: { messageId: input.messageId, role: "user", text: input.text, attachments: [] },
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      createdAt: new Date().toISOString(),
    });
  }

  interruptTurn(commandId: string, threadId: string, turnId?: string): Promise<DispatchResult> {
    return this.dispatch({
      type: "thread.turn.interrupt",
      commandId,
      threadId,
      ...(turnId ? { turnId } : {}),
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Wait until the thread's latest turn stops running. Uses the thread
   * subscription so completion is event-driven, with a wall-clock cap.
   * Resolves with the final snapshot either way; `timedOut` says which.
   */
  async waitForTurnSettled(
    threadId: string,
    timeoutMs: number,
    options: { afterTurnId?: string | null } = {},
  ): Promise<{ snapshot: ThreadDetailSnapshot; timedOut: boolean }> {
    const isSettled = (snapshot: ThreadDetailSnapshot): boolean => {
      const turn = snapshot.thread.latestTurn;
      if (!turn) return false;
      // A freshly dispatched turn shows up a beat after dispatch; until then the
      // previous, already-settled turn is still "latest" and must not count.
      if (options.afterTurnId !== undefined && turn.turnId === options.afterTurnId) return false;
      if (turn.state === "running") return false;
      const assistant = turn.assistantMessageId
        ? snapshot.thread.messages.find((m) => m.id === turn.assistantMessageId)
        : undefined;
      return !(assistant?.streaming ?? false);
    };
    const first = await this.thread(threadId, 1);
    if (isSettled(first)) return { snapshot: first, timedOut: false };

    const deadline = Date.now() + timeoutMs;
    let settled = false;
    await this.conn.rpc.stream(
      "orchestration.subscribeThread",
      { threadId, turnLimit: 1, afterSequence: first.snapshotSequence },
      (item) => {
        const record = item as { kind?: string; event?: { type?: string } };
        if (record.kind !== "event") return;
        const type = record.event?.type ?? "";
        // Any turn/session/settlement transition is a reason to re-read; the
        // authoritative check is the HTTP snapshot, not event payload parsing.
        if (
          type.startsWith("thread.turn") ||
          type.startsWith("thread.session") ||
          type === "thread.settled" ||
          type === "thread.message-sent"
        ) {
          settled = true;
          return true;
        }
        return false;
      },
      Math.max(0, deadline - Date.now()),
    );
    // Re-read until the projection reflects the transition (it lags the event by a tick).
    for (let attempt = 0; attempt < 20; attempt++) {
      const snapshot = await this.thread(threadId, 1);
      if (isSettled(snapshot)) return { snapshot, timedOut: false };
      if (!settled || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (Date.now() < deadline) return this.waitForTurnSettled(threadId, deadline - Date.now(), options);
    return { snapshot: await this.thread(threadId, 1), timedOut: true };
  }
}
