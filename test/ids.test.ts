import { describe, expect, it } from "vitest";

import { commandIds, deterministicId } from "../src/ids.js";

const launchIds = (key: string | undefined) => commandIds("launch", key);
const followUpIds = (threadId: string, key: string | undefined) => commandIds(threadId, key);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("ids", () => {
  it("derives stable, uuid-shaped ids from an idempotency key", () => {
    const a = launchIds("ticket-42");
    const b = launchIds("ticket-42");
    expect(a).toEqual(b);
    expect(a.threadId).toMatch(UUID);
    expect(a.commandId).toMatch(UUID);
    expect(a.messageId).toMatch(UUID);
    expect(new Set([a.threadId, a.commandId, a.messageId]).size).toBe(3);
  });

  it("changes every id when the key changes", () => {
    const a = launchIds("one");
    const b = launchIds("two");
    expect(a.threadId).not.toBe(b.threadId);
    expect(a.commandId).not.toBe(b.commandId);
  });

  it("generates fresh random ids when no key is given", () => {
    const a = launchIds(undefined);
    const b = launchIds("   ");
    expect(a.threadId).not.toBe(b.threadId);
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });

  it("scopes follow-up ids to the thread so the same key on two threads never collides", () => {
    const a = followUpIds("thread-a", "step-1");
    const b = followUpIds("thread-b", "step-1");
    expect(a.commandId).not.toBe(b.commandId);
    expect(followUpIds("thread-a", "step-1")).toEqual(a);
  });

  it("keeps namespaces separate", () => {
    expect(deterministicId("thread", "k")).not.toBe(deterministicId("command", "k"));
  });
});
