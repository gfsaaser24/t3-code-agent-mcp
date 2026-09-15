/**
 * Live steering check. Not part of `npm test`.
 * Starts a slow turn, then sends a second message while it is still running.
 *
 *   npx tsx test/steer.live.mts <projectIdOrRoot> [harness] [model]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [projectArg, harnessArg = "claudeAgent", modelArg = ""] = process.argv.slice(2);
if (!projectArg) throw new Error("Usage: npx tsx test/steer.live.mts <projectIdOrRoot> [harness] [model]");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/cli.js", "serve"],
  env: { ...process.env } as Record<string, string>,
  stderr: "pipe",
});
transport.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));
const client = new Client({ name: "steer", version: "0" });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const body = (result.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");
  if (result.isError) throw new Error(`${name} failed: ${body}`);
  return JSON.parse(body);
};

const projects = await call("t3_list_projects");
const project = projects.find((p: { id: string; workspaceRoot: string }) => p.id === projectArg || p.workspaceRoot.toLowerCase() === projectArg.toLowerCase()) ?? projects[0];
const harnesses = await call("t3_list_harnesses");
const harness = harnesses.find((h: { harnessId: string }) => h.harnessId === harnessArg);
if (!harness) throw new Error(`harness ${harnessArg} not usable`);
const model = modelArg || harness.models.find((m: { model: string }) => /haiku|mini|flash/.test(m.model))?.model || harness.models.find((m: { isDefault: boolean }) => m.isDefault)?.model;

const key = `steer-${Date.now()}`;
const created = await call("t3_create_thread", {
  project: project.id,
  harness: harnessArg,
  model,
  title: "[mcp steer] mid-turn message",
  prompt: "Count slowly from 1 to 300, one number per line. Do not read files. If I send a new message, stop counting and reply with only the word STEERED.",
  idempotencyKey: key,
});
console.log("thread", created.threadId, created.url);

// The turn shows as "running" only once the harness has picked it up; poll for it.
let state: string | undefined;
for (let i = 0; i < 30 && state !== "running"; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  state = (await call("t3_get_thread", { threadId: created.threadId, messageLimit: 2 })).turn?.state;
}
console.log("state before steer:", state);
if (state !== "running") throw new Error("turn was not running when steering was attempted; test inconclusive");
await new Promise((r) => setTimeout(r, 3000));

const steer = await call("t3_send_message", { threadId: created.threadId, prompt: "New message: stop and reply STEERED.", idempotencyKey: `${key}-steer`, wait: true, timeoutSeconds: 180 });
console.log("steer accepted, reused =", steer.reused, "| timedOut =", steer.timedOut, "| reply:", String(steer.reply?.text ?? "").slice(0, 200));

const after = await call("t3_get_thread", { threadId: created.threadId, messageLimit: 6 });
const userMsgs = after.messages.filter((m: { role: string }) => m.role === "user").length;
console.log("user messages on thread:", userMsgs, "| final state:", after.turn?.state);
if (userMsgs < 2) throw new Error("steer message did not land on the thread");
console.log("\nSTEER OK");
await client.close();
