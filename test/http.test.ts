import { describe, expect, it } from "vitest";

import { makeHttpClient, summarizeError } from "../src/http.js";

describe("summarizeError", () => {
  it("reads tagged Effect errors from JSON text and objects", () => {
    expect(summarizeError('{"_tag":"EnvironmentInternalError","message":"boom"}')).toBe("EnvironmentInternalError: boom");
    expect(summarizeError({ _tag: "X", detail: "d" })).toBe("X: d");
    expect(summarizeError({ reason: "r" })).toBe("r");
    expect(summarizeError("plain text")).toBe("plain text");
    expect(summarizeError("")).toBe("(empty response)");
    expect(summarizeError(new Error("e"))).toBe("e");
  });
});

describe("makeHttpClient", () => {
  it("sends the bearer header and query, and maps 401 to the pairing hint", async () => {
    let seen: { url: string; auth: string | undefined } | null = null;
    const ok = makeHttpClient("http://h", "tok", async (input, init) => {
      seen = { url: String(input), auth: (init?.headers as Record<string, string>).authorization };
      return new Response('{"a":1}', { status: 200 });
    });
    expect(await ok.get("/api/x", { turnLimit: 1, skip: undefined })).toEqual({ a: 1 });
    expect(seen).toEqual({ url: "http://h/api/x?turnLimit=1", auth: "Bearer tok" });

    const denied = makeHttpClient("http://h", "tok", async () => new Response("", { status: 401 }));
    await expect(denied.get("/api/x")).rejects.toThrow(/pair/);
  });

  it("names the path and reason on failures and timeouts", async () => {
    const failing = makeHttpClient("http://h", "tok", async () => new Response('{"_tag":"Nope","message":"m"}', { status: 500 }));
    await expect(failing.get("/api/y")).rejects.toThrow("T3 GET /api/y failed (500): Nope: m");
    const timeout = makeHttpClient("http://h", "tok", async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    await expect(timeout.get("/api/z")).rejects.toThrow("T3 GET /api/z timed out after 30s");
  });
});
