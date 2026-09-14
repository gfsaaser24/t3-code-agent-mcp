/**
 * Live smoke test against the running T3 server. Not part of `npm test`.
 * Creates one real thread (visible in the T3 UI) and drives it end to end.
 *
 *   T3_ACCESS_TOKEN=... npx tsx test/smoke.live.mts <projectIdOrRoot> [harness] [model]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [projectArg, harnessArg = "claudeAgent", modelArg = ""] = process.argv.slice(2);
if (!projectArg) throw new Error("Usage: npx tsx test/smoke.live.mts <projectIdOrRoot> [harness] [model]");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["./node_modules/tsx/dist/cli.mjs", "src/cli.ts", "serve"],
  env: { ...process.env } as Record<string, string>,
  stderr: "pipe",
});
transport.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const body = (result.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");
  if (result.isError) {
    console.log(`\n== ${name} -> ERROR\n${body}`);
    return { error: body };
  }
  console.log(`\n== ${name}\n${body.slice(0, 1500)}${body.length > 1500 ? "\n…" : ""}`);
  return JSON.parse(body);
};

const must = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await call(name, args);
  if (result.error) throw new Error(`${name} failed: ${result.error}`);
  return result;
};
const mustFail = async (name: string, args: Record<string, unknown>, pattern: RegExp) => {
  const result = await call(name, args);
  if (!result.error || !pattern.test(result.error)) throw new Error(`${name} should have failed with ${pattern}`);
};

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

const projects = await must("t3_list_projects");
const project = projects.find((p: { id: string; workspaceRoot: string }) => p.id === projectArg || p.workspaceRoot.toLowerCase() === projectArg.toLowerCase()) ?? projects[0];
console.log("using project", project.title, project.id);

await must("t3_list_worktrees", { project: project.id });
const harnesses = await must("t3_list_harnesses");
const harness = harnesses.find((h: { harnessId: string }) => h.harnessId === harnessArg);
if (!harness) throw new Error(`harness ${harnessArg} not usable`);
const model =
  modelArg ||
  harness.models.find((m: { model: string }) => /haiku|mini|flash/.test(m.model))?.model ||
  harness.models.find((m: { isDefault: boolean }) => m.isDefault)?.model;
console.log("using model", model);

// Negative checks: nothing gets substituted.
await mustFail("t3_create_thread", { project: project.id, harness: "nope", model, title: "x", prompt: "x" }, /harness "nope" not found/);
await mustFail("t3_create_thread", { project: project.id, harness: harnessArg, model: "not-a-model", title: "x", prompt: "x" }, /not offered by harness/);
await mustFail(
  "t3_create_thread",
  { project: project.id, harness: harnessArg, model, title: "x", prompt: "x", worktreePath: "/definitely/not/a/worktree" },
  /is not a worktree of project/,
);

const key = `smoke-${Date.now()}`;
const created = await must("t3_create_thread", {
  project: project.id,
  harness: harnessArg,
  model,
  title: "[mcp smoke] ping",
  prompt: "Reply with exactly the single word PONG and do nothing else. Do not read files.",
  context: [{ label: "Why", text: "Automated smoke test of t3-code-agent-mcp." }],
  idempotencyKey: key,
});
const retry = await must("t3_create_thread", {
  project: project.id,
  harness: harnessArg,
  model,
  title: "[mcp smoke] ping",
  prompt: "Reply with exactly the single word PONG and do nothing else.",
  idempotencyKey: key,
});
if (retry.threadId !== created.threadId || retry.reused !== true) throw new Error("retry launched a second thread!");

const first = await must("t3_wait_for_turn", { threadId: created.threadId, timeoutSeconds: 240 });
if (first.timedOut) throw new Error("first turn timed out");

const followKey = `${key}-follow`;
const follow = await must("t3_send_message", { threadId: created.threadId, prompt: "Now reply with exactly the word PANG.", idempotencyKey: followKey, wait: true, timeoutSeconds: 240 });
const followRetry = await must("t3_send_message", { threadId: created.threadId, prompt: "Now reply with exactly the word PANG.", idempotencyKey: followKey });
if (followRetry.reused !== true) throw new Error("follow-up retry started a second turn!");

await must("t3_get_thread", { threadId: created.threadId, messageLimit: 6 });

// Cancel: start a slow turn then interrupt it.
await call("t3_send_message", { threadId: created.threadId, prompt: "Count slowly from 1 to 500, one number per line, thinking carefully between each." });
await new Promise((r) => setTimeout(r, 4000));
const cancelled = await must("t3_cancel_turn", { threadId: created.threadId });
console.log("\ncancel result:", cancelled.cancelled, cancelled.turn?.state);
await call("t3_list_threads", { project: project.id, limit: 3 });

console.log("\nSMOKE OK — thread", created.threadId, created.url, "| follow reply:", follow.reply?.text);
await client.close();
