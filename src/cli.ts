#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { credentialsPath, exchangePairingCode, parsePairingInput, saveCredential } from "./credentials.js";
import { discoverServer } from "./discovery.js";
import { connect, T3Api } from "./t3.js";
import { registerTools } from "./tools.js";

const USAGE = `t3-code-agent-mcp <command>

Commands:
  serve            Run the MCP server on stdio (default)
  pair <url|code>  Exchange a T3 pairing link or code for a token and store it
  status           Show the discovered T3 server and whether a token works
  help             Show this help

Environment:
  T3_SERVER_URL        Skip discovery and use this origin (e.g. http://127.0.0.1:3773)
  T3CODE_HOME          T3 data dir to look in for server-runtime.json
  T3_ACCESS_TOKEN      Use this bearer token instead of the stored one
  T3_MCP_CREDENTIALS   Where to store tokens (default ~/.t3-code-agent-mcp/credentials.json)
`;

async function serve(): Promise<void> {
  const conn = await connect();
  const api = new T3Api(conn);
  const server = new McpServer({ name: "t3-code-agent-mcp", version: "0.1.0" });
  registerTools(server, { api, origin: conn.server.origin, environmentId: conn.server.environmentId });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`t3-code-agent-mcp: connected to ${conn.server.origin} (token from ${conn.tokenSource})\n`);
  const shutdown = () => {
    conn.rpc.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  transport.onclose = shutdown;
}

async function pair(input: string | undefined): Promise<void> {
  if (!input) throw new Error("Usage: t3-code-agent-mcp pair <pairing-url-or-code>");
  const parsed = parsePairingInput(input);
  const origin = parsed.origin ?? (await discoverServer()).origin;
  const credential = await exchangePairingCode(origin, parsed.code);
  const path = credentialsPath();
  await saveCredential(path, credential);
  process.stdout.write(`Paired with ${origin}. Token stored in ${path} (expires ${credential.expiresAt}).\n`);
}

async function status(): Promise<void> {
  const server = await discoverServer();
  process.stdout.write(`Server: ${server.origin} (v${server.serverVersion ?? "?"}, ${server.label ?? "unlabeled"}) via ${server.runtimeFile}\n`);
  try {
    const conn = await connect();
    const api = new T3Api(conn);
    const [shell, config] = await Promise.all([api.shell(), api.config()]);
    conn.rpc.close();
    process.stdout.write(`Token: ok (${conn.tokenSource})\n`);
    process.stdout.write(`Projects: ${shell.projects.length}, threads: ${shell.threads.length}, harnesses: ${config.providers.map((p) => p.instanceId).join(", ")}\n`);
  } catch (error) {
    process.stdout.write(`Token: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const [command = "serve", arg] = process.argv.slice(2);
  switch (command) {
    case "serve":
      return serve();
    case "pair":
      return pair(arg);
    case "status":
      return status();
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return;
    default:
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
