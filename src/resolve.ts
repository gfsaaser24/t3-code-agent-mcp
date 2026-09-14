import type { ProjectShell, Provider, ProviderModel, VcsRef } from "./types.js";

/**
 * Strict lookups. Every resolver either returns the exact match the caller
 * asked for or throws an error that lists the valid choices. Nothing here
 * ever picks a default or a "close enough" alternative on the caller's behalf.
 */
export const normalizePath = (value: string): string => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export function resolveProject(projects: ProjectShell[], ref: string): ProjectShell {
  const wanted = ref.trim();
  if (!wanted) throw new Error("project is required.");
  const byId = projects.filter((p) => p.id === wanted);
  if (byId.length === 1) return byId[0]!;
  const byRoot = projects.filter((p) => normalizePath(p.workspaceRoot) === normalizePath(wanted));
  if (byRoot.length === 1) return byRoot[0]!;
  const byTitle = projects.filter((p) => p.title === wanted);
  if (byTitle.length === 1) return byTitle[0]!;
  if (byTitle.length > 1 || byRoot.length > 1) {
    throw new Error(
      `project "${wanted}" is ambiguous; pass the project id instead. Matches: ${[...byTitle, ...byRoot]
        .map((p) => `${p.id} (${p.title} @ ${p.workspaceRoot})`)
        .join(", ")}`,
    );
  }
  throw new Error(
    `project "${wanted}" not found. Use t3_list_projects. Known: ${projects.map((p) => `${p.title} [${p.id}]`).join(", ")}`,
  );
}

/** The single definition of "can this harness start a thread right now". Null means yes. */
export function unusableReason(provider: Provider): string | null {
  if (provider.availability === "unavailable") return provider.unavailableReason ?? "unavailable";
  if (!provider.installed) return provider.message ?? "not installed";
  if (!provider.enabled || provider.status === "disabled") return provider.message ?? "disabled in T3 settings";
  if (provider.auth.status === "unauthenticated") return "not signed in; sign in through T3 first";
  return null;
}

export function resolveHarness(providers: Provider[], ref: string): Provider {
  const wanted = ref.trim();
  if (!wanted) throw new Error("harness is required.");
  const exact = providers.find((p) => p.instanceId === wanted);
  const byName = exact
    ? [exact]
    : providers.filter(
        (p) => (p.displayName ?? "").toLowerCase() === wanted.toLowerCase() || p.driver.toLowerCase() === wanted.toLowerCase(),
      );
  if (byName.length !== 1) {
    throw new Error(
      `harness "${wanted}" not found. Use t3_list_harnesses. Known ids: ${providers.map((p) => p.instanceId).join(", ")}`,
    );
  }
  const provider = byName[0]!;
  const reason = unusableReason(provider);
  if (reason) throw new Error(`harness "${provider.instanceId}" is not usable right now: ${reason}.`);
  return provider;
}

export function resolveModel(provider: Provider, ref: string): ProviderModel {
  const wanted = ref.trim();
  if (!wanted) throw new Error("model is required.");
  const bySlug = provider.models.find((m) => m.slug === wanted);
  if (bySlug) return bySlug;
  const byAlias = provider.models.filter((m) => (m.aliases ?? []).includes(wanted) || m.name === wanted);
  if (byAlias.length === 1) return byAlias[0]!;
  throw new Error(
    `model "${wanted}" is not offered by harness "${provider.instanceId}". Use t3_list_harnesses. Offered: ${provider.models
      .map((m) => m.slug)
      .join(", ")}`,
  );
}

export interface WorktreeChoice {
  branch: string | null;
  worktreePath: string | null;
}

/**
 * Resolve an explicit worktree selection against the refs T3 reports for the
 * project. The project root means the main checkout; anything else must be a
 * path T3 already knows as a worktree, matched exactly.
 */
export function resolveExistingWorktree(project: ProjectShell, refs: VcsRef[], worktreePath: string): WorktreeChoice {
  const wanted = normalizePath(worktreePath.trim());
  if (!wanted) throw new Error("worktreePath is required.");
  if (wanted === normalizePath(project.workspaceRoot)) {
    const current = refs.find((r) => r.current && !r.isRemote);
    return { branch: current?.name ?? null, worktreePath: null };
  }
  const match = refs.filter((r) => r.worktreePath && normalizePath(r.worktreePath) === wanted);
  if (match.length === 0) {
    const known = refs.filter((r) => r.worktreePath).map((r) => `${r.worktreePath} (${r.name})`);
    throw new Error(
      `worktree "${worktreePath}" is not a worktree of project "${project.title}". Use t3_list_worktrees. Known: ${
        known.length ? known.join(", ") : "(none besides the project root)"
      }`,
    );
  }
  return { branch: match[0]!.name, worktreePath: match[0]!.worktreePath };
}
