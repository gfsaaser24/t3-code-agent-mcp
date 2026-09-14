import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Shape of the `server-runtime.json` file a live T3 server writes next to its
 * database. Mirrors apps/server/src/serverRuntimeState.ts in T3 Code.
 */
export interface ServerRuntimeFile {
  version: number;
  pid: number;
  host?: string;
  port: number;
  origin: string;
  devUrl?: string;
  startedAt: string;
}

export interface DiscoveredServer {
  origin: string;
  runtimeFile: string;
  pid: number;
  environmentId: string;
  serverVersion?: string;
  label?: string;
}

/** Candidate T3 home directories, most specific first. */
export function candidateHomeDirs(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const dirs: string[] = [];
  if (env.T3CODE_HOME?.trim()) dirs.push(env.T3CODE_HOME.trim());
  dirs.push(join(home, ".t3"));
  return Array.from(new Set(dirs));
}

export function candidateRuntimeFiles(homeDirs: string[]): string[] {
  return homeDirs.flatMap((dir) => [
    join(dir, "userdata", "server-runtime.json"),
    join(dir, "dev", "server-runtime.json"),
  ]);
}

export function parseRuntimeFile(text: string): ServerRuntimeFile | null {
  try {
    const value = JSON.parse(text) as Partial<ServerRuntimeFile>;
    if (typeof value.pid !== "number" || typeof value.origin !== "string") return null;
    return value as ServerRuntimeFile;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function probeEnvironment(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ environmentId: string; serverVersion?: string; label?: string } | null> {
  try {
    const response = await fetchImpl(new URL("/.well-known/t3/environment", origin), {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { environmentId?: string; serverVersion?: string; label?: string };
    if (typeof body.environmentId !== "string") return null;
    return { environmentId: body.environmentId, serverVersion: body.serverVersion, label: body.label };
  } catch {
    return null;
  }
}

/**
 * Locate the running local T3 server. `T3_SERVER_URL` wins when set; otherwise
 * each candidate `server-runtime.json` is read, its pid checked, and its
 * origin probed. The dev URL is preferred when present because a dev server is
 * single-origin behind Vite.
 */
export async function discoverServer(
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<DiscoveredServer> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const explicit = env.T3_SERVER_URL?.trim();
  if (explicit) {
    const origin = new URL(explicit).origin;
    const probe = await probeEnvironment(origin, fetchImpl);
    if (!probe) throw new Error(`T3_SERVER_URL is set to ${origin} but no T3 server answered there.`);
    return { origin, runtimeFile: "(T3_SERVER_URL)", pid: -1, ...probe };
  }
  const tried: string[] = [];
  for (const file of candidateRuntimeFiles(candidateHomeDirs(env))) {
    tried.push(file);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const runtime = parseRuntimeFile(text);
    if (!runtime || !isProcessAlive(runtime.pid)) continue;
    const origin = new URL(runtime.devUrl ?? runtime.origin).origin;
    const probe = await probeEnvironment(origin, fetchImpl);
    if (!probe) continue;
    return { origin, runtimeFile: file, pid: runtime.pid, ...probe };
  }
  throw new Error(
    `No running T3 server found. Start T3 Code, or set T3_SERVER_URL. Looked at: ${tried.join(", ")}`,
  );
}
