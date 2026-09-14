import type { ProjectShell, Provider, ProviderModel, VcsRef } from "./types.js";

/**
 * Strict lookups. Every resolver either returns the exact match the caller
 * asked for or throws an error that lists the valid choices. Nothing here
 * ever picks a default or a "close enough" alternative on the caller's behalf.
 */
export class ResolveError extends Error {}

const normalizePath = (value: string): string => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export function resolveProject(projects: ProjectShell[], ref: string): ProjectShell {
  const wanted = ref.trim();
  if (!wanted) throw new ResolveError("project is required.");
  const byId = projects.filter((p) => p.id === wanted);
  if (byId.length === 1) return byId[0]!;
  const byRoot = projects.filter((p) => normalizePath(p.workspaceRoot) === normalizePath(wanted));
  if (byRoot.length === 1) return byRoot[0]!;
  const byTitle = projects.filter((p) => p.title === wanted);
  if (byTitle.length === 1) return byTitle[0]!;
  if (byTitle.length > 1 || byRoot.length > 1) {
    throw new ResolveError(
      `project "${wanted}" is ambiguous; pass the project id instead. Matches: ${[...byTitle, ...byRoot]
        .map((p) => `${p.id} (${p.title} @ ${p.workspaceRoot})`)
        .join(", ")}`,
    );
  }
  throw new ResolveError(
    `project "${wanted}" not found. Use t3_list_projects. Known: ${projects
      .map((p) => `${p.title} [${p.id}]`)
      .join(", ")}`,
  );
}

export const isProviderUsable = (provider: Provider): boolean =>
  provider.enabled && provider.installed && provider.availability !== "unavailable" && provider.status !== "disabled";

export function resolveHarness(providers: Provider[], ref: string): Provider {
  const wanted = ref.trim();
  if (!wanted) throw new ResolveError("harness is required.");
  const exact = providers.find((p) => p.instanceId === wanted);
  if (!exact) {
    const byName = providers.filter(
      (p) => (p.displayName ?? "").toLowerCase() === wanted.toLowerCase() || p.driver.toLowerCase() === wanted.toLowerCase(),
    );
    if (byName.length === 1) return assertUsable(byName[0]!);
    throw new ResolveError(
      `harness "${wanted}" not found. Use t3_list_harnesses. Known ids: ${providers.map((p) => p.instanceId).join(", ")}`,
    );
  }
  return assertUsable(exact);
}

function assertUsable(provider: Provider): Provider {
  if (!isProviderUsable(provider)) {
    const reason =
      provider.unavailableReason ??
      provider.message ??
      (!provider.installed ? "not installed" : !provider.enabled ? "disabled in T3 settings" : provider.status);
    throw new ResolveError(`harness "${provider.instanceId}" is not usable right now: ${reason}.`);
  }
  if (provider.auth.status === "unauthenticated") {
    throw new ResolveError(`harness "${provider.instanceId}" is not signed in. Sign in through T3 first.`);
  }
  return provider;
}

export function resolveModel(provider: Provider, ref: string): ProviderModel {
  const wanted = ref.trim();
  if (!wanted) throw new ResolveError("model is required.");
  const bySlug = provider.models.find((m) => m.slug === wanted);
  if (bySlug) return bySlug;
  const byAlias = provider.models.filter((m) => (m.aliases ?? []).includes(wanted) || m.name === wanted);
  if (byAlias.length === 1) return byAlias[0]!;
  throw new ResolveError(
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
 * project. `projectRoot` means the main checkout; anything else must be a path
 * T3 already knows as a worktree, matched exactly.
 */
export function resolveExistingWorktree(
  project: ProjectShell,
  refs: VcsRef[],
  worktreePath: string,
): WorktreeChoice {
  const wanted = normalizePath(worktreePath.trim());
  if (!wanted) throw new ResolveError("worktreePath is required.");
  if (wanted === normalizePath(project.workspaceRoot)) {
    const current = refs.find((r) => r.current && !r.isRemote);
    return { branch: current?.name ?? null, worktreePath: null };
  }
  const match = refs.filter((r) => r.worktreePath && normalizePath(r.worktreePath) === wanted);
  if (match.length === 0) {
    const known = refs.filter((r) => r.worktreePath).map((r) => `${r.worktreePath} (${r.name})`);
    throw new ResolveError(
      `worktree "${worktreePath}" is not a worktree of project "${project.title}". Use t3_list_worktrees. Known: ${
        known.length ? known.join(", ") : "(none besides the project root)"
      }`,
    );
  }
  return { branch: match[0]!.name, worktreePath: match[0]!.worktreePath };
}
