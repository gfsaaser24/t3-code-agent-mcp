import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { commandIds } from "./ids.js";
import { normalizePath, resolveExistingWorktree, resolveHarness, resolveModel, resolveProject, unusableReason } from "./resolve.js";
import type { T3Api } from "./t3.js";
import type { Message, ThreadDetailSnapshot, ThreadShell } from "./types.js";

const RuntimeModeSchema = z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]);
const InteractionModeSchema = z.enum(["default", "plan"]);
const ContextSchema = z.array(z.object({ label: z.string().optional(), text: z.string() })).optional();

export interface ToolContext {
  api: T3Api;
  origin: string;
  environmentId: string;
}

const composeMessage = (prompt: string, context?: Array<{ label?: string; text: string }>): string => {
  if (!context?.length) return prompt;
  const blocks = context.map((c) => `### ${c.label ?? "Context"}\n\n${c.text}`).join("\n\n");
  return `${prompt}\n\n---\n\n${blocks}`;
};

const summarizeThread = (thread: ThreadShell | ThreadDetailSnapshot["thread"], ctx: ToolContext) => ({
  threadId: thread.id,
  title: thread.title,
  projectId: thread.projectId,
  harness: thread.modelSelection.instanceId,
  model: thread.modelSelection.model,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  turn: thread.latestTurn
    ? {
        turnId: thread.latestTurn.turnId,
        state: thread.latestTurn.state,
        startedAt: thread.latestTurn.startedAt,
        completedAt: thread.latestTurn.completedAt,
      }
    : null,
  session: thread.session ? { status: thread.session.status, lastError: thread.session.lastError } : null,
  archived: thread.archivedAt !== null,
  ...("hasPendingApprovals" in thread
    ? {
        needsAttention: {
          pendingApprovals: thread.hasPendingApprovals,
          pendingUserInput: thread.hasPendingUserInput,
          actionablePlan: thread.hasActionableProposedPlan,
        },
      }
    : {}),
  // Matches the web route `/$environmentId/$threadId`.
  url: `${ctx.origin}/${ctx.environmentId}/${thread.id}`,
});

const renderMessages = (messages: Message[], limit: number, maxChars: number) =>
  messages.slice(-limit).map((m) => ({
    id: m.id,
    role: m.role,
    turnId: m.turnId,
    streaming: m.streaming,
    createdAt: m.createdAt,
    text: m.text.length > maxChars ? `${m.text.slice(0, maxChars)}\n…[truncated ${m.text.length - maxChars} chars]` : m.text,
  }));

const latestAssistantReply = (snapshot: ThreadDetailSnapshot): Message | null => {
  const turn = snapshot.thread.latestTurn;
  if (turn?.assistantMessageId) {
    const byId = snapshot.thread.messages.find((m) => m.id === turn.assistantMessageId);
    if (byId) return byId;
  }
  return [...snapshot.thread.messages].reverse().find((m) => m.role === "assistant") ?? null;
};

const turnResult = (snapshot: ThreadDetailSnapshot, ctx: ToolContext, timedOut: boolean) => {
  const reply = latestAssistantReply(snapshot);
  return {
    ...summarizeThread(snapshot.thread, ctx),
    timedOut,
    reply: reply ? { messageId: reply.id, streaming: reply.streaming, text: reply.text } : null,
  };
};

const WAIT_DEFAULT_SECONDS = 300;

/** Register one tool whose handler returns JSON or throws; errors become `isError` results. */
function tool<Shape extends ZodRawShapeCompat>(
  server: McpServer,
  name: string,
  meta: { title: string; description: string; inputSchema: Shape },
  run: (input: ShapeOutput<Shape>) => Promise<unknown>,
): void {
  const callback = async (input: ShapeOutput<Shape>): Promise<CallToolResult> => {
    try {
      const value = await run(input);
      return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
    }
  };
  // ToolCallback is a conditional type the compiler cannot narrow for a generic Shape; the shape is exact at every call site.
  server.registerTool(name, meta, callback as unknown as ToolCallback<Shape>);
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const { api } = ctx;

  tool(
    server,
    "t3_list_projects",
    {
      title: "List T3 projects",
      description: "List the projects the running T3 server knows about, with ids, titles, and workspace roots.",
      inputSchema: {},
    },
    async () => {
      const shell = await api.shell();
      return shell.projects.map((p) => ({
        id: p.id,
        title: p.title,
        workspaceRoot: p.workspaceRoot,
        defaultModelSelection: p.defaultModelSelection,
      }));
    },
  );

  tool(
    server,
    "t3_list_worktrees",
    {
      title: "List worktrees for a project",
      description:
        "List the git worktrees and local branches of a T3 project. The project root is always a valid worktreePath. Pass the project id, exact title, or workspace root.",
      inputSchema: { project: z.string().describe("Project id, exact title, or workspace root path") },
    },
    async ({ project }) => {
      const shell = await api.shell();
      const resolved = resolveProject(shell.projects, project);
      const refs = await api.listRefs(resolved.workspaceRoot);
      const root = normalizePath(resolved.workspaceRoot);
      const current = refs.refs.find((r) => r.current && !r.isRemote);
      return {
        projectId: resolved.id,
        isRepo: refs.isRepo,
        worktrees: [
          { worktreePath: resolved.workspaceRoot, branch: current?.name ?? null, isProjectRoot: true },
          ...refs.refs
            .filter((r) => r.worktreePath && normalizePath(r.worktreePath) !== root)
            .map((r) => ({ worktreePath: r.worktreePath, branch: r.name, isProjectRoot: false })),
        ],
        branches: refs.refs.filter((r) => !r.isRemote).map((r) => ({ name: r.name, isDefault: r.isDefault, worktreePath: r.worktreePath })),
      };
    },
  );

  tool(
    server,
    "t3_list_harnesses",
    {
      title: "List harnesses and models",
      description:
        "List the coding-agent harnesses configured in T3 (T3 calls them providers; harnessId is the provider instanceId) and the models each one offers. `usable: false` entries carry a `reason` and cannot start threads.",
      inputSchema: { includeUnusable: z.boolean().optional().describe("Also list harnesses that cannot start threads right now") },
    },
    async ({ includeUnusable }) => {
      const config = await api.config();
      return config.providers
        .map((p) => ({ provider: p, reason: unusableReason(p) }))
        .filter(({ reason }) => includeUnusable || reason === null)
        .map(({ provider: p, reason }) => ({
          harnessId: p.instanceId,
          driver: p.driver,
          displayName: p.displayName ?? p.instanceId,
          usable: reason === null,
          reason: reason ?? undefined,
          status: p.status,
          auth: p.auth.status,
          version: p.version,
          models: p.models.map((m) => ({
            model: m.slug,
            name: m.name,
            aliases: m.aliases,
            isDefault: m.isDefault ?? false,
            isLegacy: m.isLegacy ?? false,
          })),
        }));
    },
  );

  tool(
    server,
    "t3_list_threads",
    {
      title: "List threads",
      description: "List recent T3 threads, newest first. Optionally filter by project.",
      inputSchema: {
        project: z.string().optional().describe("Project id, exact title, or workspace root path"),
        includeArchived: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Default 25"),
      },
    },
    async ({ project, includeArchived, limit }) => {
      const shell = await api.shell();
      const projectId = project ? resolveProject(shell.projects, project).id : undefined;
      return shell.threads
        .filter((t) => (projectId ? t.projectId === projectId : true))
        .filter((t) => includeArchived || t.archivedAt === null)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit ?? 25)
        .map((t) => summarizeThread(t, ctx));
    },
  );

  tool(
    server,
    "t3_create_thread",
    {
      title: "Create a T3 thread and send the first prompt",
      description:
        "Create a new thread in T3 with an explicit project, worktree, harness, and model, then send the first prompt. The thread appears in the T3 UI. Nothing is substituted: unknown or unusable choices fail with the valid options. Pass the same idempotencyKey on retries to guarantee a single launch; a key whose command T3 rejected is burned and needs a new key.",
      inputSchema: {
        project: z.string().describe("Project id, exact title, or workspace root (see t3_list_projects)"),
        harness: z.string().describe("Harness id exactly as listed by t3_list_harnesses, e.g. claudeAgent, codex, cursor"),
        model: z.string().describe("Model slug or alias exactly as listed for that harness"),
        title: z.string().min(1).describe("Thread title shown in T3"),
        prompt: z.string().min(1).describe("First user message"),
        context: ContextSchema.describe("Extra context blocks appended below the prompt"),
        worktreePath: z
          .string()
          .optional()
          .describe("Existing worktree path from t3_list_worktrees, or the project root. Default: project root."),
        newWorktree: z
          .object({
            baseBranch: z.string().describe("Branch to start from"),
            branch: z.string().optional().describe("Name for the new branch; T3 generates one when omitted"),
            runSetupScript: z.boolean().optional().describe("Run the project setup script after creating the worktree (default true)"),
          })
          .optional()
          .describe("Ask T3 to create a fresh worktree for this thread. Mutually exclusive with worktreePath."),
        runtimeMode: RuntimeModeSchema.optional().describe("Default full-access"),
        interactionMode: InteractionModeSchema.optional().describe("Default 'default'; 'plan' asks for a plan first"),
        idempotencyKey: z.string().optional().describe("Stable key; retries with the same key reuse the same thread instead of launching again"),
        wait: z.boolean().optional().describe("Wait for the first turn to finish and return the reply (default false)"),
        timeoutSeconds: z.number().int().min(1).max(3600).optional().describe("Max wait when wait=true (default 300)"),
      },
    },
    async (input) => {
      if (input.worktreePath && input.newWorktree) throw new Error("Pass either worktreePath or newWorktree, not both.");
      const [shell, config] = await Promise.all([api.shell(), api.config()]);
      const project = resolveProject(shell.projects, input.project);
      const harness = resolveHarness(config.providers, input.harness);
      const model = resolveModel(harness, input.model);
      const ids = commandIds("launch", input.idempotencyKey);
      const runtimeMode = input.runtimeMode ?? "full-access";
      const interactionMode = input.interactionMode ?? "default";
      const text = composeMessage(input.prompt, input.context);

      const existing = shell.threads.find((t) => t.id === ids.threadId);
      if (existing) {
        // T3's bootstrap is a chain (create thread, then start the turn). If it
        // broke between the two, the thread exists with no turn: finish the
        // launch with the same command id rather than reporting a reuse.
        if (!existing.latestTurn) {
          await api.startTurn({ ...ids, text, runtimeMode: existing.runtimeMode, interactionMode: existing.interactionMode });
        }
      } else {
        const refs = await api.listRefs(project.workspaceRoot);
        let branch: string | null = null;
        let worktreePath: string | null = null;
        let newWorktree: { projectCwd: string; baseBranch: string; branch?: string; runSetupScript: boolean } | undefined;
        if (input.newWorktree) {
          const base = refs.refs.find((r) => !r.isRemote && r.name === input.newWorktree!.baseBranch);
          if (!base) {
            throw new Error(
              `baseBranch "${input.newWorktree.baseBranch}" is not a local branch of ${project.title}. Known: ${refs.refs
                .filter((r) => !r.isRemote)
                .map((r) => r.name)
                .join(", ")}`,
            );
          }
          branch = input.newWorktree.branch ?? null;
          newWorktree = {
            projectCwd: project.workspaceRoot,
            baseBranch: base.name,
            ...(input.newWorktree.branch ? { branch: input.newWorktree.branch } : {}),
            runSetupScript: input.newWorktree.runSetupScript ?? true,
          };
        } else {
          const choice = resolveExistingWorktree(project, refs.refs, input.worktreePath ?? project.workspaceRoot);
          branch = choice.branch;
          worktreePath = choice.worktreePath;
        }
        await api.createThreadWithFirstTurn({
          ...ids,
          projectId: project.id,
          title: input.title,
          modelSelection: { instanceId: harness.instanceId, model: model.slug },
          runtimeMode,
          interactionMode,
          branch,
          worktreePath,
          text,
          newWorktree,
        });
      }

      const base = { reused: existing !== undefined, idempotencyKey: ids.idempotencyKey };
      if (input.wait) {
        const { snapshot, timedOut } = await api.waitForTurnSettled(ids.threadId, (input.timeoutSeconds ?? WAIT_DEFAULT_SECONDS) * 1000, {
          expectedMessageId: ids.messageId,
        });
        return { ...base, ...turnResult(snapshot, ctx, timedOut) };
      }
      return { ...base, ...summarizeThread((await api.thread(ids.threadId, 1)).thread, ctx) };
    },
  );

  tool(
    server,
    "t3_send_message",
    {
      title: "Send a follow-up prompt",
      description:
        "Send another user message to an existing T3 thread with the thread's current harness and model. Works while a turn is running: T3 hands the message to the harness mid-turn (steering), exactly as the T3 UI does. A retry with the same idempotencyKey is always safe.",
      inputSchema: {
        threadId: z.string(),
        prompt: z.string().min(1),
        context: ContextSchema,
        runtimeMode: RuntimeModeSchema.optional().describe("Default: the thread's current mode"),
        interactionMode: InteractionModeSchema.optional().describe("Default: the thread's current mode"),
        idempotencyKey: z.string().optional().describe("Stable key; retries with the same key do not start a second turn"),
        wait: z.boolean().optional().describe("Wait for the turn to finish and return the reply (default false)"),
        timeoutSeconds: z.number().int().min(1).max(3600).optional().describe("Max wait when wait=true (default 300)"),
      },
    },
    async (input) => {
      const before = await api.thread(input.threadId);
      const ids = commandIds(input.threadId, input.idempotencyKey);
      const alreadySent = before.thread.messages.some((m) => m.id === ids.messageId);
      // No "turn is running" guard on purpose: T3 accepts thread.turn.start
      // mid-turn and forwards it to the harness as steering, same as the UI.
      if (!alreadySent) {
        // Safe even if the message landed after our read: T3 replays the
        // accepted receipt for a repeated commandId instead of starting again.
        await api.startTurn({
          ...ids,
          threadId: input.threadId,
          text: composeMessage(input.prompt, input.context),
          runtimeMode: input.runtimeMode ?? before.thread.runtimeMode,
          interactionMode: input.interactionMode ?? before.thread.interactionMode,
        });
      }
      const base = { reused: alreadySent, idempotencyKey: ids.idempotencyKey };
      if (input.wait) {
        const { snapshot, timedOut } = await api.waitForTurnSettled(input.threadId, (input.timeoutSeconds ?? WAIT_DEFAULT_SECONDS) * 1000, {
          expectedMessageId: ids.messageId,
        });
        return { ...base, ...turnResult(snapshot, ctx, timedOut) };
      }
      return { ...base, ...summarizeThread((await api.thread(input.threadId, 1)).thread, ctx) };
    },
  );

  tool(
    server,
    "t3_get_thread",
    {
      title: "Read a thread",
      description: "Read a thread's status, latest turn state, and recent messages (assistant replies included).",
      inputSchema: {
        threadId: z.string(),
        messageLimit: z.number().int().min(1).max(200).optional().describe("Default 10"),
        maxChars: z.number().int().min(100).max(200_000).optional().describe("Truncate each message to this many characters (default 20000)"),
      },
    },
    async ({ threadId, messageLimit, maxChars }) => {
      const limit = messageLimit ?? 10;
      // Each turn holds at least a user + assistant message, so this window covers `limit` messages.
      const snapshot = await api.thread(threadId, Math.ceil(limit / 2) + 1);
      return {
        ...summarizeThread(snapshot.thread, ctx),
        messages: renderMessages(snapshot.thread.messages, limit, maxChars ?? 20_000),
      };
    },
  );

  tool(
    server,
    "t3_wait_for_turn",
    {
      title: "Wait for the current turn",
      description:
        "Block until the thread's latest turn finishes (or the timeout passes) and return the assistant reply. Prefer wait=true on t3_create_thread / t3_send_message, which know exactly which turn to wait for.",
      inputSchema: {
        threadId: z.string(),
        timeoutSeconds: z.number().int().min(1).max(3600).optional().describe("Default 300"),
      },
    },
    async ({ threadId, timeoutSeconds }) => {
      const { snapshot, timedOut } = await api.waitForTurnSettled(threadId, (timeoutSeconds ?? WAIT_DEFAULT_SECONDS) * 1000);
      return turnResult(snapshot, ctx, timedOut);
    },
  );

  tool(
    server,
    "t3_cancel_turn",
    {
      title: "Cancel the running turn",
      description: "Interrupt the thread's running turn. No-op with a clear message if nothing is running.",
      inputSchema: { threadId: z.string() },
    },
    async ({ threadId }) => {
      const before = await api.thread(threadId, 1);
      const turn = before.thread.latestTurn;
      if (!turn || turn.state !== "running") {
        return { cancelled: false, reason: "No turn is running.", ...summarizeThread(before.thread, ctx) };
      }
      await api.interruptTurn(randomUUID(), threadId, turn.turnId);
      const { snapshot } = await api.waitForTurnSettled(threadId, 15_000);
      return { cancelled: true, ...summarizeThread(snapshot.thread, ctx) };
    },
  );
}
