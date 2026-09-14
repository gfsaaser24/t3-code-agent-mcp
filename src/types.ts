/**
 * Wire shapes copied from packages/contracts in T3 Code, trimmed to the fields
 * this server reads. Everything crossing the wire is plain JSON on the encoded
 * side, so these are structural mirrors rather than schema imports. The few
 * fields we branch on are checked at runtime in `assertThreadShape`.
 */

export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: Record<string, unknown>;
}

export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export type InteractionMode = "default" | "plan";

export interface ProjectShell {
  id: string;
  title: string;
  workspaceRoot: string;
  defaultModelSelection: ModelSelection | null;
}

export interface LatestTurn {
  turnId: string;
  // T3 defines more states than we compare against; only "running" matters here.
  state: "running" | "interrupted" | "completed" | "error" | (string & {});
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: string | null;
}

export interface Session {
  status: string;
  lastError: string | null;
}

export interface ThreadShell {
  id: string;
  projectId: string;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  branch: string | null;
  worktreePath: string | null;
  latestTurn: LatestTurn | null;
  updatedAt: string;
  archivedAt: string | null;
  session: Session | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  hasActionableProposedPlan: boolean;
}

export interface ShellSnapshot {
  snapshotSequence: number;
  projects: ProjectShell[];
  threads: ThreadShell[];
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  turnId: string | null;
  streaming: boolean;
  createdAt: string;
}

export interface ThreadDetail
  extends Omit<ThreadShell, "hasPendingApprovals" | "hasPendingUserInput" | "hasActionableProposedPlan"> {
  messages: Message[];
}

export interface ThreadDetailSnapshot {
  snapshotSequence: number;
  thread: ThreadDetail;
}

/**
 * Guard against silent contract drift after a T3 upgrade: if the fields the
 * wait loop branches on vanish, fail loudly instead of reporting "done".
 */
export function assertThreadShape(snapshot: ThreadDetailSnapshot): ThreadDetailSnapshot {
  const thread = snapshot?.thread as Partial<ThreadDetail> | undefined;
  const problems: string[] = [];
  if (!thread || typeof thread.id !== "string") problems.push("thread.id");
  if (!Array.isArray(thread?.messages)) problems.push("thread.messages");
  if (thread && !("latestTurn" in thread)) problems.push("thread.latestTurn");
  const turn = thread?.latestTurn;
  if (turn && (typeof turn.turnId !== "string" || typeof turn.state !== "string")) problems.push("thread.latestTurn.{turnId,state}");
  if (problems.length) {
    throw new Error(
      `T3 thread snapshot is missing ${problems.join(", ")}. The T3 server contract may have changed; update t3-code-agent-mcp.`,
    );
  }
  return snapshot;
}

export interface ProviderModel {
  slug: string;
  name: string;
  aliases?: string[];
  isDefault?: boolean;
  isLegacy?: boolean;
}

export interface Provider {
  instanceId: string;
  driver: string;
  displayName?: string;
  enabled: boolean;
  installed: boolean;
  version: string | null;
  status: "ready" | "warning" | "error" | "disabled" | (string & {});
  auth: { status: "authenticated" | "unauthenticated" | "unknown" | (string & {}) };
  message?: string;
  availability?: "available" | "unavailable";
  unavailableReason?: string;
  models: ProviderModel[];
}

export interface ServerConfig {
  providers: Provider[];
}

export interface VcsRef {
  name: string;
  isRemote?: boolean;
  current: boolean;
  isDefault: boolean;
  worktreePath: string | null;
}

export interface VcsListRefsResult {
  refs: VcsRef[];
  isRepo: boolean;
  nextCursor: number | null;
}

export interface DispatchResult {
  sequence: number;
}
