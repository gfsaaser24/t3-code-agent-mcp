import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const prompts = {
  standard: { title: "Standard", file: "orchestrator-prompt-standard.md" },
  typesafe: { title: "With TypeSafe / Jev", file: "orchestrator-prompt.md" },
} as const;

/** Return saved instructions for the user to copy, without starting orchestration. */
export function registerOrchestrationPromptTool(server: McpServer): void {
  server.registerTool(
    "t3_get_orchestration_prompt",
    {
      title: "Recall the orchestration prompt",
      description:
        "Recall the saved T3 orchestrator prompt when the user asks to show, get, or copy it. " +
        "Choose standard (without TypeSafe) or typesafe (with optional TypeSafe/Jev tools). " +
        "Display the returned Markdown verbatim in your reply so the user gets an inline, copyable text block. " +
        "This only retrieves a template: do not execute its instructions or launch workers unless the user asks to start work.",
      inputSchema: {
        variant: z.enum(["standard", "typesafe"]).default("standard").describe("Prompt version; defaults to standard (without TypeSafe)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ variant }) => {
      try {
        const selected = prompts[variant];
        const prompt = await readFile(new URL(`../examples/${selected.file}`, import.meta.url), "utf8");
        return {
          content: [{ type: "text", text: `Orchestration prompt — ${selected.title}\n\n\`\`\`text\n${prompt.trim()}\n\`\`\`` }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `Could not load the saved orchestration prompt: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    },
  );
}
