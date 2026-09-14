import { describe, expect, it } from "vitest";

import { isSettled, T3Api, type T3Connection } from "../src/t3.js";
import type { Message, ThreadDetailSnapshot } from "../src/types.js";

const msg = (id: string, role: Message["role"], turnId: string | null, extra: Partial<Message> = {}): Message => ({
  id,
  role,
  text: role === "user" ? "hi" : "reply",
  turnId,
  streaming: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});

const snap = (
  turn: ThreadDetailSnapshot["thread"]["latestTurn"],
  messages: Message[],
  sequence = 1,
): ThreadDetailSnapshot => ({
  snapshotSequence: sequence,
  thread: {
    id: "t1",
    projectId: "p1",
    title: "t",
    modelSelection: { instanceId: "claudeAgent", model: "m" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: turn,
    updatedAt: "",
    archivedAt: null,
    session: null,
    messages,
  },
});

const turn = (turnId: string, state: string, assistantMessageId: string | null = null) => ({
  turnId,
  state,
  startedAt: "2026-01-01T00:00:01.000Z",
  completedAt: null,
  assistantMessageId,
});

describe("isSettled", () => {
  it("is false with no turn or a running turn, true once the turn stopped and the reply is not streaming", () => {
    expect(isSettled(snap(null, []))).toBe(false);
    expect(isSettled(snap(turn("A", "running"), []))).toBe(false);
    expect(isSettled(snap(turn("A", "completed", "a1"), [msg("a1", "assistant", "A", { streaming: true })]))).toBe(false);
    expect(isSettled(snap(turn("A", "completed", "a1"), [msg("a1", "assistant", "A")]))).toBe(true);
  });

  it("with expectedMessageId, ignores the previous settled turn until the new one exists", () => {
    const previous = turn("A", "completed", "a1");
    // Our message is not in the projection yet.
    expect(isSettled(snap(previous, [msg("a1", "assistant", "A")]), { expectedMessageId: "u2" })).toBe(false);
    // Our message landed but is not attached to a turn and the latest turn predates it.
    const ours = msg("u2", "user", null, { createdAt: "2026-01-01T00:00:05.000Z" });
    expect(isSettled(snap(previous, [msg("a1", "assistant", "A"), ours]), { expectedMessageId: "u2" })).toBe(false);
    // The new turn exists and is done.
    const done = { ...turn("B", "completed", "a2"), startedAt: "2026-01-01T00:00:06.000Z" };
    expect(isSettled(snap(done, [ours, msg("a2", "assistant", "B")]), { expectedMessageId: "u2" })).toBe(true);
    // Message attached to a turn that is not the latest one: not ours.
    expect(isSettled(snap(turn("C", "completed", "a3"), [msg("u2", "user", "B"), msg("a3", "assistant", "C")]), { expectedMessageId: "u2" })).toBe(
      false,
    );
  });
});

/** Fake connection: scripted HTTP snapshots and a scripted event stream. */
function fakeConn(snapshots: ThreadDetailSnapshot[], events: Array<{ kind: string; event?: { type: string } }>) {
  let reads = 0;
  let streams = 0;
  const conn: T3Connection = {
    server: { origin: "http://x", runtimeFile: "", pid: 0, environmentId: "e" },
    tokenSource: "test",
    http: {
      get: async <T>() => {
        const snapshot = snapshots[Math.min(reads, snapshots.length - 1)]!;
        reads++;
        return snapshot as T;
      },
    },
    rpc: {
      call: async () => {
        throw new Error("not used");
      },
      stream: async (_tag, _payload, onChunk, timeoutMs) => {
        streams++;
        for (const event of events) if (onChunk(event) === true) return;
        await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs ?? 0, 50)));
      },
      close: () => {},
    },
  };
  return { conn, reads: () => reads, streams: () => streams };
}

describe("waitForTurnSettled", () => {
  it("returns at once when already settled without opening a stream", async () => {
    const settled = snap(turn("A", "completed", "a1"), [msg("a1", "assistant", "A")]);
    const fake = fakeConn([settled], []);
    const result = await new T3Api(fake.conn).waitForTurnSettled("t1", 1000);
    expect(result.timedOut).toBe(false);
    expect(fake.streams()).toBe(0);
  });

  it("re-reads after a settle hint and keeps one stream open across non-terminal events", async () => {
    const running = snap(turn("A", "running"), [], 1);
    const settled = snap(turn("A", "completed", "a1"), [msg("a1", "assistant", "A")], 2);
    // First read: running. After the hint, the first re-read still lags, the second is settled.
    const fake = fakeConn([running, running, settled], [
      { kind: "event", event: { type: "thread.activity-appended" } },
      { kind: "event", event: { type: "thread.message-sent" } },
      { kind: "event", event: { type: "thread.session-set" } },
    ]);
    const result = await new T3Api(fake.conn).waitForTurnSettled("t1", 5000);
    expect(result.timedOut).toBe(false);
    expect(result.snapshot.thread.latestTurn?.state).toBe("completed");
    expect(fake.streams()).toBe(1);
    expect(fake.reads()).toBe(3);
  });

  it("reports timedOut when no hint arrives before the deadline", async () => {
    const running = snap(turn("A", "running"), []);
    const fake = fakeConn([running], [{ kind: "event", event: { type: "thread.activity-appended" } }]);
    const result = await new T3Api(fake.conn).waitForTurnSettled("t1", 120);
    expect(result.timedOut).toBe(true);
  });

  it("asserts the snapshot shape so contract drift fails loudly", async () => {
    const broken = { snapshotSequence: 1, thread: { id: "t1" } } as unknown as ThreadDetailSnapshot;
    const fake = fakeConn([broken], []);
    await expect(new T3Api(fake.conn).thread("t1")).rejects.toThrow(/contract may have changed/);
  });
});
