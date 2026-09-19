import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import type { T3Api } from "../src/t3.js";
import { registerTools } from "../src/tools.js";

async function withClient(run: (client: Client) => Promise<void>) {
  const server = new McpServer({ name: "prompt-test", version: "0" });
  const api = new Proxy({} as T3Api, {
    get: () => { throw new Error("Prompt retrieval must not access T3"); },
  });
  registerTools(server, { api, origin: "http://t3", environmentId: "test" });
  const client = new Client({ name: "prompt-test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("t3_get_orchestration_prompt", () => {
  it.each([
    { args: {}, file: "orchestrator-prompt-standard.md", title: "Standard", typesafe: false },
    { args: { variant: "standard" }, file: "orchestrator-prompt-standard.md", title: "Standard", typesafe: false },
    { args: { variant: "typesafe" }, file: "orchestrator-prompt.md", title: "With TypeSafe / Jev", typesafe: true },
  ])("returns the complete $title template for $args in a copyable text block without T3 calls", async ({ args, file, title, typesafe }) => {
    await withClient(async (client) => {
      const result = await client.callTool({ name: "t3_get_orchestration_prompt", arguments: args });
      const saved = (await readFile(new URL(`../examples/${file}`, import.meta.url), "utf8")).trim();
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{ type: "text", text: `Orchestration prompt — ${title}\n\n\`\`\`text\n${saved}\n\`\`\`` }]);
      expect(saved).toContain("FIVE concurrent worker threads");
      expect(saved).toContain("READY_TO_MERGE");
      expect(/typesafe|jev_/i.test(saved)).toBe(typesafe);
    });
  });

  it("rejects an unknown version rather than silently returning another prompt", async () => {
    await withClient(async (client) => {
      const result = await client.callTool({ name: "t3_get_orchestration_prompt", arguments: { variant: "unknown" } });
      expect(result.isError).toBe(true);
    });
  });
});
