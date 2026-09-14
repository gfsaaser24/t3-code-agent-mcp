import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  exchangePairingCode,
  loadCredential,
  parsePairingInput,
  resolveAccessToken,
  saveCredential,
} from "../src/credentials.js";

describe("parsePairingInput", () => {
  it("accepts a bare pairing code and keeps the fallback origin", () => {
    expect(parsePairingInput("  ABC123  ", "http://127.0.0.1:3773")).toEqual({
      code: "ABC123",
      origin: "http://127.0.0.1:3773",
    });
  });

  it("reads a direct /pair link with the token in the hash", () => {
    expect(parsePairingInput("http://127.0.0.1:3773/pair#token=ABCD1234")).toEqual({
      code: "ABCD1234",
      origin: "http://127.0.0.1:3773",
    });
  });

  it("reads a hosted link and points at the host param", () => {
    expect(
      parsePairingInput("https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%3A44342%2F#token=abc"),
    ).toEqual({ code: "abc", origin: "https://desktop.tailnet.ts.net:44342" });
  });

  it("rejects a link without a token", () => {
    expect(() => parsePairingInput("http://127.0.0.1:3773/pair")).toThrow(/missing its token/);
  });
});

describe("credential store", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("saves, replaces per origin, and loads", async () => {
    dir = await mkdtemp(join(tmpdir(), "t3mcp-"));
    const path = join(dir, "nested", "credentials.json");
    const base = { scope: "orchestration:read", issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" };
    await saveCredential(path, { origin: "http://a", accessToken: "one", ...base });
    await saveCredential(path, { origin: "http://b", accessToken: "two", ...base });
    await saveCredential(path, { origin: "http://a", accessToken: "three", ...base });
    expect((await loadCredential(path, "http://a"))?.accessToken).toBe("three");
    expect((await loadCredential(path, "http://b"))?.accessToken).toBe("two");
    expect(JSON.parse(await readFile(path, "utf8")).credentials).toHaveLength(2);
  });

  it("prefers T3_ACCESS_TOKEN, then the store, and explains when the token expired", async () => {
    dir = await mkdtemp(join(tmpdir(), "t3mcp-"));
    const path = join(dir, "credentials.json");
    expect(await resolveAccessToken("http://x", { T3_ACCESS_TOKEN: "env-token" })).toEqual({
      token: "env-token",
      source: "T3_ACCESS_TOKEN",
    });
    await expect(resolveAccessToken("http://x", { T3_MCP_CREDENTIALS: path })).rejects.toThrow(/pair/);
    await saveCredential(path, {
      origin: "http://x",
      accessToken: "stored",
      scope: "s",
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    await expect(resolveAccessToken("http://x", { T3_MCP_CREDENTIALS: path })).rejects.toThrow(/expired/);
  });
});

describe("exchangePairingCode", () => {
  it("posts the token-exchange form and stores the bearer token with expiry", async () => {
    let captured: { url: string; body: string } | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      captured = { url: String(input), body: String(init?.body) };
      return new Response(
        JSON.stringify({ access_token: "tok", token_type: "Bearer", expires_in: 60, scope: "a b" }),
        { status: 200 },
      );
    };
    const before = Date.now();
    const cred = await exchangePairingCode("http://127.0.0.1:3773", "CODE", fetchImpl);
    expect(captured!.url).toBe("http://127.0.0.1:3773/oauth/token");
    const params = new URLSearchParams(captured!.body);
    expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(params.get("subject_token")).toBe("CODE");
    expect(params.get("subject_token_type")).toBe("urn:t3:params:oauth:token-type:environment-bootstrap");
    expect(cred.accessToken).toBe("tok");
    expect(new Date(cred.expiresAt).getTime()).toBeGreaterThanOrEqual(before + 60_000);
  });

  it("surfaces server errors", async () => {
    const fetchImpl: typeof fetch = async () => new Response('{"_tag":"Nope"}', { status: 401 });
    await expect(exchangePairingCode("http://h", "x", fetchImpl)).rejects.toThrow(/401/);
  });
});
