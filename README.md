# t3-code-agent-mcp

A small, local MCP server that lets a coding agent (Claude Code, Codex, Cursor, or any MCP client) start and drive threads in your running **T3 Code / T3 Turbo** app.

It talks to the T3 server the same way the T3 web app does, over T3's own HTTP and WebSocket interfaces with T3's own pairing tokens. T3 handles each harness's protocol. Threads you create here show up in the normal T3 UI. Nothing touches T3's database directly.

## What you get

| Tool | What it does |
| --- | --- |
| `t3_list_projects` | Projects the T3 server knows, with ids and workspace roots |
| `t3_list_worktrees` | Worktrees and local branches for one project |
| `t3_list_harnesses` | Harnesses (Codex, Claude, Cursor, Grok, OpenCode, …) and the models each one offers, with a usable/not-usable flag |
| `t3_list_threads` | Recent threads, optionally per project |
| `t3_create_thread` | Create a thread with an explicit project + worktree + harness + model and send the first prompt |
| `t3_send_message` | Send a follow-up prompt to an existing thread |
| `t3_get_thread` | Status, turn state, and recent messages (including the assistant reply) |
| `t3_wait_for_turn` | Block until the current turn finishes, then return the reply |
| `t3_cancel_turn` | Interrupt the running turn |

Rules the server enforces:

- **No silent substitution.** If the harness or model you name is unknown, disabled, not installed, or signed out, the call fails and lists the valid options. Same for projects and worktrees.
- **No duplicate launches.** Pass an `idempotencyKey` and retries reuse the same thread (or the same turn). T3 dedupes on the derived command id, so even a retry after a crash cannot launch twice.
- **Local only.** Discovery, auth, and traffic stay on your machine unless you point `T3_SERVER_URL` elsewhere.

## Install

```bash
git clone https://github.com/gfsaaser24/t3-code-agent-mcp
cd t3-code-agent-mcp
npm install
npm run build
```

Requires Node 20+ and a running T3 Turbo / T3 Code (desktop app or `npx t3`).

## Pair with T3 (one time)

1. Open T3 → **Settings → Connections** → create a pairing link (or run `t3 pair` if you use the CLI server).
2. Copy the pairing URL or the short pairing code.
3. Run:

```bash
node dist/cli.js pair "http://127.0.0.1:3773/pair#token=XXXXXXXX"
# or just the code:
node dist/cli.js pair XXXXXXXX
```

The server exchanges the one-time code for a bearer token at T3's `/oauth/token` and stores it in `~/.t3-code-agent-mcp/credentials.json` (30-day TTL by default; pair again when it expires).

Check it:

```bash
node dist/cli.js status
```

Alternative: set `T3_ACCESS_TOKEN` to a token from `t3 auth session issue --token-only`.

## Configure your MCP client

### Claude Code

```bash
claude mcp add t3 -- node C:/code/t3-code-agent-mcp/dist/cli.js
```

or in `.mcp.json` / `~/.claude.json`:

```json
{
  "mcpServers": {
    "t3": {
      "command": "node",
      "args": ["C:/code/t3-code-agent-mcp/dist/cli.js"]
    }
  }
}
```

### Codex CLI (`~/.codex/config.toml`)

```toml
[mcp_servers.t3]
command = "node"
args = ["C:/code/t3-code-agent-mcp/dist/cli.js"]
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "t3": { "command": "node", "args": ["C:/code/t3-code-agent-mcp/dist/cli.js"] }
  }
}
```

Optional environment variables (put them under `env` in the config above):

| Variable | Meaning |
| --- | --- |
| `T3_SERVER_URL` | Skip discovery; use this origin (e.g. `http://127.0.0.1:3773`) |
| `T3CODE_HOME` | T3 data dir to search for `server-runtime.json` (default `~/.t3-turbo`, then `~/.t3`) |
| `T3_ACCESS_TOKEN` | Bearer token to use instead of the stored one |
| `T3_MCP_CREDENTIALS` | Path of the credentials file |

## Typical flow for an agent

```text
t3_list_projects                 → pick a project id
t3_list_worktrees {project}      → pick a worktreePath (or use the project root)
t3_list_harnesses                → pick harnessId + model slug
t3_create_thread {project, worktreePath, harness, model, title, prompt, idempotencyKey, wait: true}
t3_send_message  {threadId, prompt, wait: true}
t3_get_thread    {threadId}
t3_cancel_turn   {threadId}
```

`t3_create_thread` can also ask T3 to create a fresh worktree:

```json
{ "project": "…", "harness": "codex", "model": "gpt-5.6-sol", "title": "Fix #42",
  "prompt": "…", "newWorktree": { "baseBranch": "main" } }
```

Every thread result includes `url`, a link that opens the thread in the T3 web UI.

## How it works

- **Discovery.** Reads `<T3 home>/userdata/server-runtime.json` (then `dev/`), checks the pid is alive, and probes `/.well-known/t3/environment`.
- **Auth.** Bearer token from T3's pairing flow, sent as an `Authorization` header on HTTP and on the WebSocket upgrade.
- **Commands.** `orchestration.dispatchCommand` over the WebSocket RPC with T3's typed commands (`thread.turn.start` with `bootstrap.createThread`, `thread.turn.interrupt`). The socket handler is the one that expands `bootstrap` into "create thread, then start the turn" and returns typed errors. Command ids are derived from your `idempotencyKey` with SHA-256, so the same key always yields the same `threadId`, `commandId`, and `messageId`, and T3 dedupes on `commandId`.
- **Reads.** `GET /api/orchestration/shell` and `GET /api/orchestration/threads/:id` over HTTP.
- **RPC.** `server.getConfig` (harnesses + models) and `vcs.listRefs` (worktrees) are WebSocket-only in T3, so a tiny client speaks the Effect RPC JSON envelope (Request / Chunk / Ack / Exit / Ping).
- **Waiting.** Subscribes to the thread over the socket and re-reads the HTTP snapshot when a turn/session event lands; no fixed polling loop.

## Develop

```bash
npm test                      # unit tests (fake WebSocket server, no T3 needed)
npm run typecheck
T3_ACCESS_TOKEN=… npx tsx test/smoke.live.mts   # creates ONE real thread in your T3
```

## Security notes

- The stored token has T3's standard client scopes (`orchestration:read/operate`, `terminal:operate`, `review:write`, `relay:read`). Revoke it any time in T3 → Settings → Connections.
- The credentials file is created with mode `0600` where the OS supports it.
- The server never opens or writes T3's SQLite database.
