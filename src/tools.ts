import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { followUpIds, freshCommandId, launchIds } from "./ids.js";
import { isProviderUsable, resolveExistingWorktree, resolveHarness, resolveModel, resolveProject } from "./resolve.js";
import type { T3Api } from "./t3.js";
import type { Message, ThreadDetailSnapshot, ThreadShell } from "./types.js";

const RuntimeModeSchema = z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]);
const InteractionModeSchema = z.enum(["default", "plan"]);

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const failure = (error: unknown) => ({
  isError: true as const,
  content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
});

const composeMessage = (prompt: string, context?: Array<{ label?: string; text: string }>): string => {
  if (!context?.length) return prompt;
  const blocks = context.map((c) => `### ${c.label ?? "Context"}\n\n${c.text}`).join("\n\n");
  return `${prompt}\n\n---\n\n${blocks}`;
};

const summarizeThread = (thread: ThreadShell | ThreadDetailSnapshot["thread"], origin: string) => ({
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
  url: `${origin}/threads/${thread.id}`,
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

const turnResult = (snapshot: ThreadDetailSnapshot, origin: string, timedOut: boolean) => {
  const reply = latestAssistantReply(snapshot);
  return {
    ...summarizeThread(snapshot.thread, origin),
    timedOut,
    reply: reply ? { messageId: reply.id, streaming: reply.streaming, text: reply.text } : null,
  };
};

export function registerTools(server: McpServer, api: T3Api, origin: string): void {
  server.registerTool(
    "t3_list_projects",
    {
      title: "List T3 projects",
      description: "List the projects the running T3 server knows about, with ids, titles, and workspace roots.",
      inputSchema: {},
    },
    async () => {
      try {
        const shell = await api.shell();
        return text(
          shell.projects.map((p) => ({
            id: p.id,
            title: p.title,
            workspaceRoot: p.workspaceRoot,
            defaultModelSelection: p.defaultModelSelection,
          })),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "t3_list_worktrees",
    {
      title: "List worktrees for a project",
      description:
        "List the git worktrees and local branches of a T3 project. The project root is always a valid worktreePath. Pass the project id, title, or workspace root.",
      inputSchema: { project: z.string().describe("Project id, exact title, or workspace root path") },
    },
    async ({ project }) => {
      try {
        const shell = await api.shell();
        const resolved = resolveProject(shell.projects, project);
        const refs = await api.listRefs(resolved.workspaceRoot);
        const current = refs.refs.find((r) => r.current && !r.isRemote);
        const worktrees = [
          { worktreePath: resolved.workspaceRoot, branch: current?.name ?? null, isProjectRoot: true },
          ...refs.refs
            .filter((r) => r.worktreePath && r.worktreePath !== resolved.workspaceRoot)
            .map((r) => ({ worktreePath: r.worktreePath, branch: r.name, isProjectRoot: false })),
        ];
        return text({
          projectId: resolved.id,
          isRepo: refs.isRepo,
          worktrees,
          branches: refs.refs.filter((r) => !r.isRemote).map((r) => ({ name: r.name, isDefault: r.isDefault, worktreePath: r.worktreePath })),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "t3_list_harnesses",
    {
      title: "List harnesses and models",
      description:
        "List the coding-agent harnesses (providers) configured in T3 and the models each one offers. Only usable harnesses can start threads; unusable ones are listed with a reason.",
      inputSchema: { includeUnusable: z.boolean().optional().describe("Also list harnesses that cannot start threads right now") },
    },
    async ({ includeUnusable }) => {
      try {
        const config = await api.config();
        const providers = config.providers.filter((p) => includeUnusable || isProviderUsable(p));
        return text(
          providers.map((p) => ({
            harnessId: p.instanceId,
            driver: p.driver,
            displayName: p.displayName ?? p.instanceId,
            usable: isProviderUsable(p) && p.auth.status !== "unauthenticated",
            status: p.status,
            auth: p.auth.status,
            version: p.version,
            reason: p.unavailableReason ?? p.message,
            models: p.models.map((m) => ({
              model: m.slug,
              name: m.name,
              aliases: m.aliases,
              isDefault: m.isDefault ?? false,
              isLegacy: m.isLegacy ?? false,
            })),
          })),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
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
      try {
        const shell = await api.shell();
        const projectId = project ? resolveProject(shell.projects, project).id : undefined;
        const threads = shell.threads
          .filter((t) => (projectId ? t.projectId === projectId : true))
          .filter((t) => includeArchived || t.archivedAt === null)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, limit ?? 25);
        return text(threads.map((t) => summarizeThread(t, origin)));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "t3_create_thread",
    {
      title: "Create a T3 thread and send the first prompt",
      description:
        "Create a new thread in T3 with an explicit project, worktree, harness, and model, then send the first prompt. The thread appears in the T3 UI. Nothing is substituted: unknown or unusable choices fail with the valid options. Pass the same idempotencyKey on retries to guarantee a single launch.",
      inputSchema: {
        project: z.string().describe("Project id, exact title, or workspace root (see t3_list_projects)"),
        harness: z.string().describe("Harness id exactly as listed by t3_list_harnesses, e.g. claudeAgent, codex, cursor"),
        model: z.string().describe("Model slug or alias exactly as listed for that harness"),
        title: z.string().min(1).describe("Thread title shown in T3"),
        prompt: z.string().min(1).describe("First user message"),
        context: z
          .array(z.object({ label: z.string().optional(), text: z.string() }))
          .optional()
          .describe("Extra context blocks appended below the prompt"),
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
      try {
        if (input.worktreePath && input.newWorktree) {
          throw new Error("Pass either worktreePath or newWorktree, not both.");
        }
        const [shell, config] = await Promise.all([api.shell(), api.config()]);
        const project = resolveProject(shell.projects, input.project);
        const harness = resolveHarness(config.providers, input.harness);
        const model = resolveModel(harness, input.model);
        const ids = launchIds(input.idempotencyKey);

        const existing = shell.threads.find((t) => t.id === ids.threadId);
        if (existing) {
          return text({ reused: true, idempotencyKey: ids.idempotencyKey, ...summarizeThread(existing, origin) });
        }

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
          commandId: ids.commandId,
          threadId: ids.threadId,
          messageId: ids.messageId,
          projectId: project.id,
          title: input.title,
          modelSelection: { instanceId: harness.instanceId, model: model.slug },
          runtimeMode: input.runtimeMode ?? "full-access",
          interactionMode: input.interactionMode ?? "default",
          branch,
          worktreePath,
          text: composeMessage(input.prompt, input.context),
          newWorktree,
        });

        if (input.wait) {
          const { snapshot, timedOut } = await api.waitForTurnSettled(ids.threadId, (input.timeoutSeconds ?? 300) * 1000);
          return text({ reused: false, idempotencyKey: ids.idempotencyKey, ...turnResult(snapshot, origin, timedOut) });
        }
        const snapshot = await api.thread(ids.threadId, 1);
        return text({ reused: false, idempotencyKey: ids.idempotencyKey, ...summarizeThread(snapshot.thread, origin) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "t3_send_message",
    {
      title: "Send a follow-up prompt",
      description:
        "Send another user message to an existing T3 thread, starting a new turn with the thread's current harness and model. Fails if a turn is already running.",
      inputSchema: {
        threadId: z.string(),
        prompt: z.string().min(1),
        context: z.array(z.object({ label: z.string().optional(), text: z.string() })).optional(),
        runtimeMode: RuntimeModeSchema.optional().describe("Default: the thread's current mode"),
        interactionMode: InteractionModeSchema.optional().describe("Default: the thread's current mode"),
        idempotencyKey: z.string().optional().describe("Stable key; retries with the same key do not start a second turn"),
        wait: z.boolean().optional().describe("Wait for the turn to finish and return the reply (default false)"),
        timeoutSeconds: z.number().int().min(1).max(3600).optional().describe("Max wait when wait=true (default 300)"),
      },
    },
    async (input) => {
      try {
        const before = await api.thread(input.threadId, 1);
        const ids = followUpIds(input.threadId, input.idempotencyKey);
        const alreadySent = before.thread.messages.some((m) => m.id === ids.messageId);
        if (!alreadySent && before.thread.latestTurn?.state === "running") {
          throw new Error(`Thread ${input.threadId} already has a running turn (${before.thread.latestTurn.turnId}). Wait for it or cancel it first.`);
        }
        if (!alreadySent) {
          await api.startTurn({
            commandId: ids.commandId,
            threadId: input.threadId,
            messageId: ids.messageId,
            text: composeMessage(input.prompt, input.context),
            runtimeMode: input.runtimeMode ?? before.thread.runtimeMode,
            interactionMode: input.interactionMode ?? before.thread.interactionMode,
          });
        }
        if (input.wait) {
          const { snapshot, timedOut } = await api.waitForTurnSettled(input.threadId, (input.timeoutSeconds ?? 300) * 1000, {
            afterTurnId: alreadySent ? undefined : (before.thread.latestTurn?.turnId ?? null),
          });
          return text({ reused: alreadySent, idempotencyKey: ids.idempotencyKey, ...turnResult(snapshot, origin, timedOut) });
        }
        const snapshot = await api.thread(input.threadId, 1);
        return text({ reused: alreadySent, idempotencyKey: ids.idempotencyKey, ...summarizeThread(snapshot.thread, origin) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
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
      try {
        const snapshot = await api.thread(threadId);
        return text({
          ...summarizeThread(snapshot.thread, origin),
          messages: renderMessages(snapshot.thread.messages, messageLimit ?? 10, maxChars ?? 20_000),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "t3_wait_for_turn",
    {
      title: "Wait for the current turn",
      description: "Block until the thread's latest turn finishes (or the timeout passes) and return the assistant reply.",
      inputSchema: {
        threadId: z.string(),
        timeoutSeconds: z.number().int().min(1).max(3600).optional().describe("Default 300"),
      },
    },
    async ({ threadId, timeoutSeconds }) => {
      try {
        const { snapshot, timedOut } = await api.waitForTurnSettled(threadId, (timeoutSeconds ?? 300) * 1000);
        return text(turnResult(snapshot, origin, timedOut));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "t3_cancel_turn",
    {
      title: "Cancel the running turn",
      description: "Interrupt the thread's running turn. No-op with a clear message if nothing is running.",
      inputSchema: { threadId: z.string() },
    },
    async ({ threadId }) => {
      try {
        const before = await api.thread(threadId, 1);
        const turn = before.thread.latestTurn;
        if (!turn || turn.state !== "running") {
          return text({ cancelled: false, reason: "No turn is running.", ...summarizeThread(before.thread, origin) });
        }
        await api.interruptTurn(freshCommandId(), threadId, turn.turnId);
        const { snapshot } = await api.waitForTurnSettled(threadId, 15_000, { afterTurnId: null });
        return text({ cancelled: true, ...summarizeThread(snapshot.thread, origin) });
      } catch (error) {
        return failure(error);
      }
    },
  );
}
