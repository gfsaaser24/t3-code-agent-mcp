import { describe, expect, it } from "vitest";

import { resolveExistingWorktree, resolveHarness, resolveModel, resolveProject } from "../src/resolve.js";
import type { ProjectShell, Provider, VcsRef } from "../src/types.js";

const project = (id: string, title: string, root: string): ProjectShell => ({
  id,
  title,
  workspaceRoot: root,
  defaultModelSelection: null,
  createdAt: "",
  updatedAt: "",
});

const provider = (overrides: Partial<Provider>): Provider => ({
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  displayName: "Claude",
  enabled: true,
  installed: true,
  version: "1.0",
  status: "ready",
  auth: { status: "authenticated" },
  models: [
    { slug: "claude-fable-5-1", name: "Claude Fable 5.1", aliases: ["fable"], isDefault: true, isCustom: false },
    { slug: "claude-opus-5", name: "Claude Opus 5", aliases: ["opus"], isCustom: false },
  ],
  ...overrides,
});

describe("resolveProject", () => {
  const projects = [
    project("p1", "alpha", "C:\\code\\alpha"),
    project("p2", "beta", "C:\\code\\beta"),
    project("p3", "beta", "C:\\code\\beta-two"),
  ];

  it("matches by id, by path (case and slash insensitive), and by unique title", () => {
    expect(resolveProject(projects, "p1").id).toBe("p1");
    expect(resolveProject(projects, "c:/code/ALPHA/").id).toBe("p1");
    expect(resolveProject(projects, "alpha").id).toBe("p1");
  });

  it("refuses ambiguous titles instead of picking one", () => {
    expect(() => resolveProject(projects, "beta")).toThrow(/ambiguous/);
  });

  it("lists the known projects when nothing matches", () => {
    expect(() => resolveProject(projects, "gamma")).toThrow(/alpha \[p1\]/);
  });
});

describe("resolveHarness", () => {
  it("matches the exact instance id", () => {
    expect(resolveHarness([provider({})], "claudeAgent").instanceId).toBe("claudeAgent");
  });

  it("allows a unique display-name match but never a guess", () => {
    expect(resolveHarness([provider({})], "claude").instanceId).toBe("claudeAgent");
    expect(() => resolveHarness([provider({})], "codex")).toThrow(/not found/);
  });

  it("refuses harnesses that are disabled, missing, unavailable, or signed out", () => {
    expect(() => resolveHarness([provider({ enabled: false, status: "disabled" })], "claudeAgent")).toThrow(/not usable/);
    expect(() => resolveHarness([provider({ installed: false })], "claudeAgent")).toThrow(/not installed/);
    expect(() =>
      resolveHarness([provider({ availability: "unavailable", unavailableReason: "driver missing" })], "claudeAgent"),
    ).toThrow(/driver missing/);
    expect(() => resolveHarness([provider({ auth: { status: "unauthenticated" } })], "claudeAgent")).toThrow(/signed in/);
  });
});

describe("resolveModel", () => {
  it("matches slug or alias exactly and never substitutes", () => {
    expect(resolveModel(provider({}), "claude-opus-5").slug).toBe("claude-opus-5");
    expect(resolveModel(provider({}), "fable").slug).toBe("claude-fable-5-1");
    expect(() => resolveModel(provider({}), "gpt-5")).toThrow(/not offered by harness "claudeAgent"/);
  });
});

describe("resolveExistingWorktree", () => {
  const proj = project("p", "t3", "C:\\code\\t3");
  const refs: VcsRef[] = [
    { name: "main", current: true, isDefault: true, worktreePath: "C:\\code\\t3" },
    { name: "feature/x", current: false, isDefault: false, worktreePath: "C:\\code\\t3-wt\\x" },
    { name: "dangling", current: false, isDefault: false, worktreePath: null },
  ];

  it("maps the project root to worktreePath null with the current branch", () => {
    expect(resolveExistingWorktree(proj, refs, "c:/code/t3")).toEqual({ branch: "main", worktreePath: null });
  });

  it("returns the branch and path for a known worktree", () => {
    expect(resolveExistingWorktree(proj, refs, "C:\\code\\t3-wt\\x")).toEqual({
      branch: "feature/x",
      worktreePath: "C:\\code\\t3-wt\\x",
    });
  });

  it("rejects unknown paths and lists the known worktrees", () => {
    expect(() => resolveExistingWorktree(proj, refs, "C:\\elsewhere")).toThrow(/t3-wt\\x \(feature\/x\)/);
  });
});
