import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StoredCredential {
  origin: string;
  accessToken: string;
  scope: string;
  issuedAt: string;
  expiresAt: string;
}

interface CredentialsFile {
  version: 1;
  credentials: StoredCredential[];
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.T3_MCP_CREDENTIALS?.trim() || join(home, ".t3-code-agent-mcp", "credentials.json");
}

async function readStore(path: string): Promise<CredentialsFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as CredentialsFile;
    if (parsed.version === 1 && Array.isArray(parsed.credentials)) return parsed;
  } catch {
    // missing or unreadable: start fresh
  }
  return { version: 1, credentials: [] };
}

export async function saveCredential(path: string, credential: StoredCredential): Promise<void> {
  const store = await readStore(path);
  store.credentials = store.credentials.filter((c) => c.origin !== credential.origin);
  store.credentials.push(credential);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2) + "\n", "utf8");
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows ignores POSIX modes
  }
}

export async function loadCredential(path: string, origin: string): Promise<StoredCredential | null> {
  const store = await readStore(path);
  return store.credentials.find((c) => c.origin === origin) ?? null;
}

/**
 * Resolve the bearer token for an origin. `T3_ACCESS_TOKEN` wins so headless
 * setups can inject a token minted with `t3 auth session issue`.
 */
export async function resolveAccessToken(
  origin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ token: string; source: string }> {
  const fromEnv = env.T3_ACCESS_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "T3_ACCESS_TOKEN" };
  const path = credentialsPath(env);
  const stored = await loadCredential(path, origin);
  if (stored) {
    if (new Date(stored.expiresAt).getTime() < Date.now()) {
      throw new Error(
        `The stored T3 token for ${origin} expired on ${stored.expiresAt}. Run: t3-code-agent-mcp pair <pairing-url-or-code>`,
      );
    }
    return { token: stored.accessToken, source: path };
  }
  throw new Error(
    `No T3 token for ${origin}. In T3, open Settings > Connections, create a pairing link, then run: t3-code-agent-mcp pair <pairing-url-or-code>`,
  );
}

/**
 * Accepts the three forms T3 hands out: a bare pairing code, a direct
 * `http://host/pair#token=CODE` link, or a hosted
 * `https://app.../pair?host=<origin>#token=CODE` link. Mirrors
 * packages/shared/src/remote.ts in T3 Code.
 */
export function parsePairingInput(input: string, fallbackOrigin?: string): { code: string; origin?: string } {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter a pairing URL or pairing code.");
  if (!/^[a-z]+:\/\//i.test(trimmed)) {
    return { code: trimmed, origin: fallbackOrigin };
  }
  const url = new URL(trimmed);
  const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const code = hashParams.get("token") ?? url.searchParams.get("token");
  if (!code) throw new Error("Pairing URL is missing its token.");
  const hostParam = url.searchParams.get("host");
  if (hostParam) {
    const host = hostParam.startsWith("//") ? `https:${hostParam}` : hostParam;
    return { code, origin: new URL(host).origin };
  }
  return { code, origin: url.origin };
}

/** Exchange a pairing code for a bearer token at T3's `/oauth/token`. */
export async function exchangePairingCode(
  origin: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredCredential> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: code,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    client_label: "t3-code-agent-mcp",
    client_device_type: "desktop",
  });
  const response = await fetchImpl(new URL("/oauth/token", origin), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Pairing failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const result = JSON.parse(text) as {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
  };
  if (result.token_type !== "Bearer") {
    throw new Error(`T3 issued a ${result.token_type} token; only Bearer is supported.`);
  }
  const issuedAt = new Date();
  return {
    origin,
    accessToken: result.access_token,
    scope: result.scope,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + result.expires_in * 1000).toISOString(),
  };
}
