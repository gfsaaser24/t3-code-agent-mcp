import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { candidateHomeDirs, candidateRuntimeFiles, discoverServer, parseRuntimeFile } from "../src/discovery.js";

describe("discovery", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("orders candidate homes: T3CODE_HOME, then ~/.t3", () => {
    const dirs = candidateHomeDirs({ T3CODE_HOME: "X:\\custom" }, "H:\\home");
    expect(dirs).toEqual(["X:\\custom", join("H:\\home", ".t3")]);
    expect(candidateRuntimeFiles(["A"])).toEqual([join("A", "userdata", "server-runtime.json"), join("A", "dev", "server-runtime.json")]);
  });

  it("rejects malformed runtime files", () => {
    expect(parseRuntimeFile("nope")).toBeNull();
    expect(parseRuntimeFile('{"port":1}')).toBeNull();
    expect(parseRuntimeFile('{"pid":1,"origin":"http://127.0.0.1:1","port":1,"version":1,"startedAt":""}')?.pid).toBe(1);
  });

  it("uses a live runtime file whose pid is alive and whose origin answers", async () => {
    dir = await mkdtemp(join(tmpdir(), "t3mcp-home-"));
    await mkdir(join(dir, "userdata"), { recursive: true });
    await writeFile(
      join(dir, "userdata", "server-runtime.json"),
      JSON.stringify({ version: 1, pid: process.pid, port: 4242, origin: "http://127.0.0.1:4242", startedAt: "" }),
    );
    const probed: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      probed.push(String(input));
      return new Response(JSON.stringify({ environmentId: "env-1", serverVersion: "9.9.9", label: "Box" }), { status: 200 });
    };
    const found = await discoverServer({ env: { T3CODE_HOME: dir }, fetchImpl });
    expect(found.origin).toBe("http://127.0.0.1:4242");
    expect(found.serverVersion).toBe("9.9.9");
    expect(found.environmentId).toBe("env-1");
    expect(probed[0]).toBe("http://127.0.0.1:4242/.well-known/t3/environment");
  });

  it("skips stale runtime files (dead pid) and explains where it looked", async () => {
    dir = await mkdtemp(join(tmpdir(), "t3mcp-home-"));
    await mkdir(join(dir, "userdata"), { recursive: true });
    await writeFile(
      join(dir, "userdata", "server-runtime.json"),
      JSON.stringify({ version: 1, pid: 999_999_999, port: 1, origin: "http://127.0.0.1:1", startedAt: "" }),
    );
    await expect(discoverServer({ env: { T3CODE_HOME: dir, HOME: dir }, fetchImpl: async () => new Response("", { status: 500 }) })).rejects.toThrow(
      /No running T3 server found/,
    );
  });

  it("honours T3_SERVER_URL and fails loudly when nothing answers there", async () => {
    const ok = await discoverServer({
      env: { T3_SERVER_URL: "http://localhost:5555/anything" },
      fetchImpl: async () => new Response(JSON.stringify({ environmentId: "env-1", serverVersion: "1" }), { status: 200 }),
    });
    expect(ok.origin).toBe("http://localhost:5555");
    await expect(
      discoverServer({ env: { T3_SERVER_URL: "http://localhost:5555" }, fetchImpl: async () => new Response("", { status: 404 }) }),
    ).rejects.toThrow(/no T3 server answered/);
  });
});
