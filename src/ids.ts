import { createHash, randomUUID } from "node:crypto";

/**
 * Deterministic UUID-shaped id derived from a caller-supplied idempotency key.
 * T3 dedupes commands on `commandId` and treats `threadId`/`messageId` as
 * client-chosen, so a retried call with the same key reuses the same ids and
 * cannot launch a second thread or turn.
 */
export function deterministicId(namespace: string, key: string): string {
  const hex = createHash("sha256").update(`t3-code-agent-mcp:${namespace}:${key}`).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

export interface CommandIds {
  idempotencyKey: string;
  threadId: string;
  commandId: string;
  messageId: string;
}

/**
 * Ids for one logical intent. `scope` is "launch" for a new thread or the
 * existing threadId for a follow-up, so the same key on two threads never
 * collides. Without a key the ids are random, so only that one call is safe.
 */
export function commandIds(scope: string, idempotencyKey: string | undefined): CommandIds {
  const key = idempotencyKey?.trim() || randomUUID();
  return {
    idempotencyKey: key,
    threadId: deterministicId(`thread:${scope}`, key),
    commandId: deterministicId(`command:${scope}`, key),
    messageId: deterministicId(`message:${scope}`, key),
  };
}
