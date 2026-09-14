import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { commandIds } from "../src/ids.js";
import type { T3Api } from "../src/t3.js";
import { registerTools } from "../src/tools.js";
import type { Provider, ShellSnapshot, ThreadDetailSnapshot, ThreadShell, VcsListRefsResult } from "../src/types.js";

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

/** Capture tool handlers straight off McpServer so no transport is needed. */
function harness(api: Partial<T3Api>) {
  const server = new McpServer({ name: "test", version: "0" });
  const handlers = new Map<string, Handler>();
  const original = server.registerTool.bind(server);
  (server as unknown as { registerTool: unknown }).registerTool = (name: string, meta: unknown, cb: Handler) => {
    handlers.set(name, cb);
    return original(name, meta as never, cb as never);
  };
  registerTools(server, { api: api as T3Api, origin: "http://t3", environmentId: "env-9" });
  return async (name: string, args: Record<string, unknown> = {}) => {
    const result = await handlers.get(name)!(args);
    const text = result.content.map((c) => c.text).join("");
    return result.isError ? { error: text } : JSON.parse(text);
  };
}

const provider: Provider = {
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated" },
  models: [{ slug: "claude-opus-5", name: "Opus" }],
};

const threadShell = (id: string, latestTurn: ThreadShell["latestTurn"]): ThreadShell => ({
  id,
  projectId: "p1",
  title: "t",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestTurn,
  updatedAt: "",
  archivedAt: null,
  session: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const detail = (shell: ThreadShell, messages: ThreadDetailSnapshot["thread"]["messages"] = []): ThreadDetailSnapshot => {
  const { hasPendingApprovals: _a, hasPendingUserInput: _b, hasActionableProposedPlan: _c, ...rest } = shell;
  return { snapshotSequence: 1, thread: { ...rest, messages } };
};

const shell = (threads: ThreadShell[]): ShellSnapshot => ({
  snapshotSequence: 1,
  projects: [{ id: "p1", title: "proj", workspaceRoot: "C:\\code\\proj", defaultModelSelection: null }],
  threads,
});

const refs: VcsListRefsResult = {
  isRepo: true,
  nextCursor: null,
  refs: [
    { name: "main", current: true, isDefault: true, worktreePath: "c:/code/proj" },
    { name: "feat", current: false, isDefault: false, worktreePath: "C:\\code\\proj-feat" },
  ],
};

const base = (key: string) => ({ project: "p1", harness: "claudeAgent", model: "claude-opus-5", title: "T", prompt: "go", idempotencyKey: key });

describe("t3_create_thread", () => {
  it("creates with bootstrap and reports the web url", async () => {
    const calls: unknown[] = [];
    const ids = commandIds("launch", "k1");
    const call = harness({
      shell: async () => shell([]),
      config: async () => ({ providers: [provider] }),
      listRefs: async () => refs,
      createThreadWithFirstTurn: async (spec) => {
        calls.push(spec);
        return { sequence: 1 };
      },
      thread: async () => detail(threadShell(ids.threadId, null)),
    });
    const result = await call("t3_create_thread", base("k1"));
    expect(result.reused).toBe(false);
    expect(result.url).toBe(`http://t3/env-9/${ids.threadId}`);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ threadId: ids.threadId, commandId: ids.commandId, branch: "main", worktreePath: null });
  });

  it("finishes a half-launched thread (exists, no turn) instead of calling it reused", async () => {
    const ids = commandIds("launch", "k2");
    const started: unknown[] = [];
    const call = harness({
      shell: async () => shell([threadShell(ids.threadId, null)]),
      config: async () => ({ providers: [provider] }),
      startTurn: async (spec) => {
        started.push(spec);
        return { sequence: 2 };
      },
      createThreadWithFirstTurn: async () => {
        throw new Error("must not re-bootstrap");
      },
      thread: async () => detail(threadShell(ids.threadId, null)),
    });
    const result = await call("t3_create_thread", base("k2"));
    expect(result.reused).toBe(true);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ commandId: ids.commandId, messageId: ids.messageId, threadId: ids.threadId });
  });

  it("reuses a launched thread without dispatching anything, and honours wait", async () => {
    const ids = commandIds("launch", "k3");
    const turn = { turnId: "T", state: "completed", startedAt: "2026-01-01T00:00:01.000Z", completedAt: null, assistantMessageId: "a1" };
    const call = harness({
      shell: async () => shell([threadShell(ids.threadId, turn)]),
      config: async () => ({ providers: [provider] }),
      startTurn: async () => {
        throw new Error("must not dispatch");
      },
      createThreadWithFirstTurn: async () => {
        throw new Error("must not dispatch");
      },
      waitForTurnSettled: async () => ({
        snapshot: detail(threadShell(ids.threadId, turn), [
          { id: "a1", role: "assistant", text: "PONG", turnId: "T", streaming: false, createdAt: "" },
        ]),
        timedOut: false,
      }),
    });
    const result = await call("t3_create_thread", { ...base("k3"), wait: true });
    expect(result.reused).toBe(true);
    expect(result.reply.text).toBe("PONG");
  });

  it("rejects both worktreePath and newWorktree, and an unknown baseBranch", async () => {
    const call = harness({
      shell: async () => shell([]),
      config: async () => ({ providers: [provider] }),
      listRefs: async () => refs,
    });
    expect((await call("t3_create_thread", { ...base("k4"), worktreePath: "x", newWorktree: { baseBranch: "main" } })).error).toMatch(/not both/);
    expect((await call("t3_create_thread", { ...base("k4"), newWorktree: { baseBranch: "nope" } })).error).toMatch(/not a local branch/);
  });
});

describe("t3_send_message", () => {
  it("refuses a different running turn but lets a retry of an already-sent message through", async () => {
    const running = { turnId: "R", state: "running", startedAt: "", completedAt: null, assistantMessageId: null };
    const ids = commandIds("t1", "step");
    const call = harness({
      thread: async () => detail(threadShell("t1", running), [{ id: ids.messageId, role: "user", text: "x", turnId: "R", streaming: false, createdAt: "" }]),
      startTurn: async () => {
        throw new Error("must not dispatch");
      },
    });
    expect((await call("t3_send_message", { threadId: "t1", prompt: "p", idempotencyKey: "other" })).error).toMatch(/already has a running turn/);
    const retry = await call("t3_send_message", { threadId: "t1", prompt: "p", idempotencyKey: "step" });
    expect(retry.reused).toBe(true);
  });
});

describe("t3_list_harnesses", () => {
  it("hides unusable harnesses by default and explains them when asked", async () => {
    const signedOut: Provider = { ...provider, instanceId: "codex", driver: "codex", auth: { status: "unauthenticated" } };
    const call = harness({ config: async () => ({ providers: [provider, signedOut] }) });
    expect((await call("t3_list_harnesses")).map((h: { harnessId: string }) => h.harnessId)).toEqual(["claudeAgent"]);
    const all = await call("t3_list_harnesses", { includeUnusable: true });
    expect(all[1]).toMatchObject({ harnessId: "codex", usable: false, reason: expect.stringMatching(/signed in/) });
  });
});

describe("t3_list_worktrees", () => {
  it("does not list the project root twice when paths differ only by case or slashes", async () => {
    const call = harness({ shell: async () => shell([]), listRefs: async () => refs });
    const result = await call("t3_list_worktrees", { project: "proj" });
    expect(result.worktrees.map((w: { worktreePath: string }) => w.worktreePath)).toEqual(["C:\\code\\proj", "C:\\code\\proj-feat"]);
  });
});
