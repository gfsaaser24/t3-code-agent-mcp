/**
 * Wire shapes copied from packages/contracts in T3 Code, trimmed to the fields
 * this server reads. Everything crossing the wire is plain JSON on the encoded
 * side, so these are structural mirrors rather than schema imports.
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
  createdAt: string;
  updatedAt: string;
}

export interface LatestTurn {
  turnId: string;
  state: "running" | "interrupted" | "completed" | "error";
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: string | null;
}

export interface Session {
  threadId: string;
  status: "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
  providerName: string | null;
  providerInstanceId?: string;
  activeTurnId: string | null;
  lastError: string | null;
  updatedAt: string;
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
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  session: Session | null;
  latestUserMessageAt: string | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  hasActionableProposedPlan: boolean;
}

export interface ShellSnapshot {
  snapshotSequence: number;
  projects: ProjectShell[];
  threads: ThreadShell[];
  updatedAt: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  turnId: string | null;
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadDetail extends Omit<ThreadShell, "latestUserMessageAt" | "hasPendingApprovals" | "hasPendingUserInput" | "hasActionableProposedPlan"> {
  messages: Message[];
  activities?: unknown[];
  proposedPlans?: unknown[];
  session: Session | null;
}

export interface ThreadDetailSnapshot {
  snapshotSequence: number;
  thread: ThreadDetail;
  page?: { beforeCursor: string | null; hasMore: boolean };
}

export interface ProviderModel {
  slug: string;
  name: string;
  shortName?: string;
  aliases?: string[];
  isDefault?: boolean;
  isLegacy?: boolean;
  isCustom: boolean;
}

export interface Provider {
  instanceId: string;
  driver: string;
  displayName?: string;
  enabled: boolean;
  installed: boolean;
  version: string | null;
  status: "ready" | "warning" | "error" | "disabled";
  auth: { status: "authenticated" | "unauthenticated" | "unknown"; label?: string };
  message?: string;
  availability?: "available" | "unavailable";
  unavailableReason?: string;
  models: ProviderModel[];
}

export interface ServerConfig {
  providers: Provider[];
  environment?: { environmentId?: string; label?: string; serverVersion?: string };
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
  hasPrimaryRemote: boolean;
  nextCursor: number | null;
  totalCount: number;
}

export interface DispatchResult {
  sequence: number;
}
