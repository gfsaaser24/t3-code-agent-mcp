import { discoverServer, type DiscoveredServer } from "./discovery.js";
import { resolveAccessToken } from "./credentials.js";
import { makeHttpClient, type HttpClient } from "./http.js";
import { T3RpcClient } from "./rpc.js";
import {
  assertThreadShape,
  type DispatchResult,
  type InteractionMode,
  type ModelSelection,
  type RuntimeMode,
  type ServerConfig,
  type ShellSnapshot,
  type ThreadDetailSnapshot,
  type VcsListRefsResult,
} from "./types.js";

export interface T3Connection {
  server: DiscoveredServer;
  tokenSource: string;
  http: HttpClient;
  rpc: Pick<T3RpcClient, "call" | "stream" | "close">;
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

export interface TurnStartSpec {
  commandId: string;
  threadId: string;
  messageId: string;
  text: string;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
}

export interface WaitOptions {
  /** Only a turn that carries this user message counts as "the turn we are waiting for". */
  expectedMessageId?: string;
}

/** Events after which the thread projection may have moved to a settled state. */
const SETTLE_HINT_EVENTS = new Set([
  "thread.session-set",
  "thread.settled",
  "thread.turn-interrupt-requested",
  "thread.turn-diff-completed",
]);

/**
 * Typed wrappers over T3's surfaces. Reads go over HTTP snapshots. Commands go
 * over the RPC socket, not `POST /api/orchestration/dispatch`: only the socket
 * handler expands `bootstrap` (create thread + prepare worktree) before
 * applying the turn, and it returns typed errors instead of a generic 500.
 */
export class T3Api {
  constructor(private readonly conn: T3Connection) {}

  shell(): Promise<ShellSnapshot> {
    return this.conn.http.get<ShellSnapshot>("/api/orchestration/shell");
  }

  async thread(threadId: string, turnLimit?: number): Promise<ThreadDetailSnapshot> {
    const snapshot = await this.conn.http.get<ThreadDetailSnapshot>(
      `/api/orchestration/threads/${encodeURIComponent(threadId)}`,
      { turnLimit },
    );
    return assertThreadShape(snapshot);
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

  startTurn(spec: TurnStartSpec): Promise<DispatchResult> {
    return this.dispatch({
      type: "thread.turn.start",
      commandId: spec.commandId,
      threadId: spec.threadId,
      message: { messageId: spec.messageId, role: "user", text: spec.text, attachments: [] },
      runtimeMode: spec.runtimeMode,
      interactionMode: spec.interactionMode,
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
   * Wait until the thread's latest turn stops running. One subscription stays
   * open for the whole wait; on events that can mean "settled" the HTTP
   * snapshot is re-read (it lags the event by a tick, so a few bounded
   * re-reads). Resolves with the final snapshot either way; `timedOut` says
   * which. With `expectedMessageId`, only the turn that carries that user
   * message counts, which makes waiting after a dispatch immune to projection
   * lag and to the previous turn still being "latest".
   */
  async waitForTurnSettled(
    threadId: string,
    timeoutMs: number,
    options: WaitOptions = {},
  ): Promise<{ snapshot: ThreadDetailSnapshot; timedOut: boolean }> {
    const deadline = Date.now() + timeoutMs;
    const read = () => this.thread(threadId, 1);
    let snapshot = await read();
    if (isSettled(snapshot, options)) return { snapshot, timedOut: false };

    while (Date.now() < deadline) {
      let hint = false;
      await this.conn.rpc.stream(
        "orchestration.subscribeThread",
        { threadId, turnLimit: 1, afterSequence: snapshot.snapshotSequence },
        (item) => {
          const record = item as { kind?: string; event?: { type?: string } };
          if (record.kind !== "event" || !SETTLE_HINT_EVENTS.has(record.event?.type ?? "")) return false;
          hint = true;
          return true;
        },
        Math.max(0, deadline - Date.now()),
      );
      if (!hint) break; // timed out with no hint
      for (let attempt = 0; attempt < 4; attempt++) {
        snapshot = await read();
        if (isSettled(snapshot, options)) return { snapshot, timedOut: false };
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
    return { snapshot: await read(), timedOut: true };
  }
}

export function isSettled(snapshot: ThreadDetailSnapshot, options: WaitOptions = {}): boolean {
  const turn = snapshot.thread.latestTurn;
  if (!turn) return false;
  if (options.expectedMessageId) {
    const ownMessage = snapshot.thread.messages.find((m) => m.id === options.expectedMessageId);
    if (!ownMessage) return false;
    // The user message is committed before the turn starts; until the turn
    // exists the previous, already-settled turn is still "latest".
    if (ownMessage.turnId && ownMessage.turnId !== turn.turnId) return false;
    if (!ownMessage.turnId && !isNewerThan(turn, ownMessage.createdAt)) return false;
  }
  if (turn.state === "running") return false;
  const assistant = turn.assistantMessageId
    ? snapshot.thread.messages.find((m) => m.id === turn.assistantMessageId)
    : undefined;
  return !(assistant?.streaming ?? false);
}

const isNewerThan = (turn: { startedAt: string | null }, iso: string): boolean =>
  turn.startedAt !== null && turn.startedAt >= iso;
