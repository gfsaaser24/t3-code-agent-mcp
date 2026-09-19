# t3-code-agent-mcp

A small, local [MCP](https://modelcontextprotocol.io) server that lets a coding agent (Claude Code, Codex CLI, Cursor, or any MCP client) start and drive threads in your running **[T3 Code](https://github.com/pingdotgg/t3code)** app.

Use it when an agent in one thread needs to kick off more work: "open a Codex thread on this repo with `gpt-5.6-sol` and ask it to fix the flaky test", then read the reply, send follow-ups, or cancel.

- Talks to T3 the same way the T3 web app does: T3's own HTTP + WebSocket interfaces, T3's own pairing tokens. T3 handles each harness's protocol.
- Threads show up in the normal T3 UI, with a link back to them.
- Never opens or writes T3's database.
- Runs over stdio on your machine. No cloud, no extra ports.

## Contents

- [Tools](#tools)
- [Guarantees](#guarantees)
- [Requirements](#requirements)
- [Install](#install)
- [Pair with T3](#pair-with-t3)
- [Configure your MCP client](#configure-your-mcp-client)
- [Typical agent flow](#typical-agent-flow)
- [Tool reference](#tool-reference)
- [Environment variables](#environment-variables)
- [How it works](#how-it-works)
- [Compatibility](#compatibility)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Security](#security)

## Tools

| Tool | What it does |
| --- | --- |
| `t3_get_orchestration_prompt` | Recall a copyable orchestrator prompt, with or without TypeSafe/Jev |
| `t3_list_projects` | Projects the T3 server knows, with ids and workspace roots |
| `t3_list_worktrees` | Git worktrees and local branches of one project |
| `t3_list_harnesses` | Harnesses (Codex, Claude, Cursor, Grok, OpenCode, …) and the models each offers, with a usable flag and reason |
| `t3_list_threads` | Recent threads, newest first, optionally per project |
| `t3_create_thread` | Create a thread with an explicit project + worktree + harness + model and send the first prompt |
| `t3_send_message` | Send a follow-up prompt to an existing thread |
| `t3_get_thread` | Status, latest turn state, and recent messages including the assistant reply |
| `t3_wait_for_turn` | Block until the current turn finishes, then return the reply |
| `t3_cancel_turn` | Interrupt the running turn |

## Guarantees

- **No silent substitution.** If the harness or model you name is unknown, disabled, not installed, or signed out, the call fails and lists the valid options. Same for projects and worktrees.
- **No duplicate launches.** Pass an `idempotencyKey` and retries reuse the same thread (or the same turn). Command ids are derived from the key, and T3 dedupes on command id, so even a retry after a crash cannot launch twice. If T3 *rejected* a command, that key is burned: fix the cause and call again with a new key. The error text says so.
- **Loud on drift.** The few response fields the wait loop relies on are checked at runtime. If a T3 upgrade renames them, tools fail with a clear message instead of reporting "done".

## Requirements

- Node.js 20 or newer.
- A running T3 Code server on the same machine: the desktop app, or `npx t3`.
- A pairing link from that T3 (Settings → Connections).

## Install

```bash
git clone https://github.com/gfsaaser24/t3-code-agent-mcp
cd t3-code-agent-mcp
npm install
npm run build
```

The server entry point is `dist/cli.js`.

## Pair with T3

One-time step. T3 issues short-lived pairing codes; this server exchanges one for a 30-day bearer token and stores it locally.

1. In T3 open **Settings → Connections** and create a pairing link. (CLI users: `t3 pair`.)
2. Copy the pairing URL or the short code.
3. Run one of:

```bash
node dist/cli.js pair "http://127.0.0.1:3773/pair#token=XXXXXXXX"
node dist/cli.js pair XXXXXXXX
```

The token is stored in `~/.t3-code-agent-mcp/credentials.json`. Check everything is wired:

```bash
node dist/cli.js status
# Server: http://127.0.0.1:3773 (v0.0.52, …) via …/server-runtime.json
# Token: ok (…/credentials.json)
# Projects: 12, threads: 80, harnesses: codex, claudeAgent, cursor, …
```

When the token expires, run `pair` again. You can revoke it any time in T3 → Settings → Connections.

Headless alternative: set `T3_ACCESS_TOKEN` to a token from `t3 auth session issue --token-only`.

## Configure your MCP client

Replace `/path/to/t3-code-agent-mcp` with where you cloned it. Ready-made files are in [`examples/`](examples/).

### Claude Code

```bash
claude mcp add --scope user t3 -- node /path/to/t3-code-agent-mcp/dist/cli.js
```

or in `.mcp.json` / `~/.claude.json`:

```json
{
  "mcpServers": {
    "t3": { "command": "node", "args": ["/path/to/t3-code-agent-mcp/dist/cli.js"] }
  }
}
```

### Codex CLI (`~/.codex/config.toml`)

```toml
[mcp_servers.t3]
command = "node"
args = ["/path/to/t3-code-agent-mcp/dist/cli.js"]
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "t3": { "command": "node", "args": ["/path/to/t3-code-agent-mcp/dist/cli.js"] }
  }
}
```

### Any other MCP client

Command `node`, argument `/path/to/t3-code-agent-mcp/dist/cli.js`, transport stdio. Optional environment variables are listed below.

## Typical agent flow

```text
t3_list_projects                       → pick a project id
t3_list_worktrees  {project}           → pick a worktreePath (or use the project root)
t3_list_harnesses                      → pick harnessId + model slug
t3_create_thread   {project, worktreePath, harness, model, title, prompt,
                    idempotencyKey, wait: true}      → reply text + thread url
t3_send_message    {threadId, prompt, wait: true}  → next reply
t3_get_thread      {threadId}                      → status + recent messages
t3_cancel_turn     {threadId}                      → stop a running turn
```

Every thread result includes `url`, which opens the thread in the T3 web UI, and `turn.state` (`running`, `completed`, `interrupted`, `error`).

## Tool reference

### `t3_get_orchestration_prompt`

Ask your agent **"Show me the orchestration prompt"** or **"Show me the orchestration prompt with TypeSafe"**. The agent can call:

```text
t3_get_orchestration_prompt({})                       // standard, without TypeSafe
t3_get_orchestration_prompt({variant: "typesafe"})    // with TypeSafe / Jev
```

| Input | Notes |
| --- | --- |
| `variant` | `standard` (default) or `typesafe` |

Returns the complete saved prompt as a fenced Markdown text block, ready for the agent to display inline in chat. The host client controls rendering and copy-button support. Retrieval only reads a bundled file; it does not launch threads, call T3 APIs, or invoke TypeSafe. The MCP server still uses its normal T3 connection at startup.

Both versions cover up to five workers, separate worktrees and PRs, labeled MCP communication, batched review fixes, dependency order, and lightweight checks without waiting for CI. The TypeSafe version adds optional Jev tool guidance. The editable templates are [standard](examples/orchestrator-prompt-standard.md) and [with TypeSafe](examples/orchestrator-prompt.md); both ship in the npm package.

### `t3_list_projects`

No input. Returns `[{ id, title, workspaceRoot, defaultModelSelection }]`.

### `t3_list_worktrees`

| Input | Notes |
| --- | --- |
| `project` | Project id, exact title, or workspace root path |

Returns the project root (always a valid `worktreePath`), every other worktree with its branch, and the local branch list.

### `t3_list_harnesses`

| Input | Notes |
| --- | --- |
| `includeUnusable` | Also list harnesses that cannot start threads, with a `reason` |

Returns `[{ harnessId, driver, displayName, usable, reason, status, auth, version, models: [{ model, name, aliases, isDefault, isLegacy }] }]`. T3 calls harnesses "providers"; `harnessId` is the provider instance id (`claudeAgent`, `codex`, `cursor`, …).

### `t3_list_threads`

| Input | Notes |
| --- | --- |
| `project` | Optional filter |
| `includeArchived` | Default false |
| `limit` | Default 25, max 200 |

### `t3_create_thread`

| Input | Notes |
| --- | --- |
| `project` | Project id, exact title, or workspace root |
| `harness` | Harness id exactly as listed |
| `model` | Model slug or alias exactly as listed for that harness |
| `title` | Thread title shown in T3 |
| `prompt` | First user message |
| `context` | Optional `[{ label?, text }]` blocks appended below the prompt |
| `worktreePath` | Existing worktree from `t3_list_worktrees`, or the project root (default) |
| `newWorktree` | `{ baseBranch, branch?, runSetupScript? }`: ask T3 to create a fresh worktree. Mutually exclusive with `worktreePath` |
| `runtimeMode` | `approval-required`, `auto-accept-edits`, `auto`, `full-access` (default) |
| `interactionMode` | `default` or `plan` |
| `idempotencyKey` | Stable key; retries reuse the same thread |
| `wait` | Wait for the first turn and return the reply (default false) |
| `timeoutSeconds` | Max wait, default 300 |

Returns the thread summary plus `reused` (true when the key matched an existing thread) and, with `wait`, `reply` and `timedOut`.

### `t3_send_message`

| Input | Notes |
| --- | --- |
| `threadId` | |
| `prompt` | |
| `context` | Optional blocks as above |
| `runtimeMode`, `interactionMode` | Default: the thread's current modes |
| `idempotencyKey` | Stable key; retries do not start a second turn |
| `wait`, `timeoutSeconds` | As above |

Works while a turn is running. T3 passes the message to the harness mid-turn (steering), the same way the T3 UI does. A retry with the same key is always safe. Use `t3_cancel_turn` first if you want a clean stop instead of steering.

### `t3_get_thread`

| Input | Notes |
| --- | --- |
| `threadId` | |
| `messageLimit` | Default 10, max 200 |
| `maxChars` | Truncate each message, default 20000 |

### `t3_wait_for_turn`

| Input | Notes |
| --- | --- |
| `threadId` | |
| `timeoutSeconds` | Default 300 |

Prefer `wait: true` on `t3_create_thread` / `t3_send_message`, which know exactly which turn to wait for.

### `t3_cancel_turn`

| Input | Notes |
| --- | --- |
| `threadId` | |

Returns `cancelled: false` with a reason when nothing is running.

## Environment variables

Put these under `env` in your MCP client config when needed.

| Variable | Meaning |
| --- | --- |
| `T3_SERVER_URL` | Skip discovery and use this origin, e.g. `http://127.0.0.1:3773` |
| `T3CODE_HOME` | T3 data directory to search for `server-runtime.json`. Default: `~/.t3` |
| `T3_ACCESS_TOKEN` | Bearer token to use instead of the stored one |
| `T3_MCP_CREDENTIALS` | Path of the credentials file. Default `~/.t3-code-agent-mcp/credentials.json` |

CLI commands: `serve` (default), `pair <url-or-code>`, `status`, `help`.

## How it works

- **Discovery.** Reads `<T3 home>/userdata/server-runtime.json` (then `dev/`), checks the pid is alive, and probes `/.well-known/t3/environment` for the environment id and version.
- **Auth.** Bearer token from T3's pairing flow (`POST /oauth/token` token exchange), sent as an `Authorization` header on HTTP and on the WebSocket upgrade.
- **Reads.** `GET /api/orchestration/shell` (projects + thread list) and `GET /api/orchestration/threads/:id` (thread detail, windowed by turn).
- **Commands.** `orchestration.dispatchCommand` over T3's WebSocket RPC with T3's typed commands: `thread.turn.start` with `bootstrap.createThread` (and optional `prepareWorktree`), and `thread.turn.interrupt`. The socket handler is the one that expands `bootstrap` and returns typed errors. Thread, command, and message ids are SHA-256 of your `idempotencyKey`.
- **RPC client.** `server.getConfig` (harnesses + models) and `vcs.listRefs` (worktrees) are socket-only in T3, so a small client speaks the Effect RPC JSON envelope: `Request`, `Chunk` + `Ack` back-pressure, `Exit`, `Ping`/`Pong`, `Interrupt`. Failures are scoped to the socket that carried the request.
- **Waiting.** One thread subscription stays open for the whole wait. On session/settle events the HTTP snapshot is re-read a few times (it lags the event by a tick). After a dispatch the wait only accepts the turn that carries your own message id, so a retry or a lagging projection cannot return the previous turn.

## Compatibility

Wired against upstream [pingdotgg/t3code](https://github.com/pingdotgg/t3code) `main` at `8419238` (server 0.0.40, 2026-09-14). Every touch point was checked against that source:

| Touch point | Upstream |
| --- | --- |
| Pairing exchange | `POST /oauth/token`, grant `urn:ietf:params:oauth:grant-type:token-exchange`, subject type `urn:t3:params:oauth:token-type:environment-bootstrap` |
| Pairing link | `<origin>/pair#token=<code>` (`t3 pair`, `t3 auth pairing create`, Settings → Connections); hosted form `…/pair?host=<origin>#token=<code>` |
| Socket auth | `Authorization: Bearer` on the `/ws` upgrade (server falls back to it when no `wsTicket` is present) |
| Discovery | `$T3CODE_HOME` or `~/.t3`, then `userdata/` or `dev/` `server-runtime.json` (`pid`, `origin`, `devUrl`), default port 3773, `GET /.well-known/t3/environment` |
| Reads | `GET /api/orchestration/shell`, `GET /api/orchestration/threads/:threadId?turnLimit=` |
| Commands | RPC `orchestration.dispatchCommand`: `thread.turn.start` (+ `bootstrap.createThread` / `prepareWorktree`), `thread.turn.interrupt` |
| Config + git | RPC `server.getConfig`, `vcs.listRefs` (limit ≤ 200, `cursor` paging) |
| Waiting | RPC `orchestration.subscribeThread` with `afterSequence` + `turnLimit` |
| Scopes | `orchestration:read` for reads and config, `orchestration:operate` for dispatch (both in T3's standard client scopes) |
| Thread link | Web route `/$environmentId/$threadId` |

Forks that keep these surfaces work unchanged; a fork that moves its data directory only needs `T3CODE_HOME`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `No running T3 server found` | Start T3 Code, or set `T3_SERVER_URL`. If your T3 data lives elsewhere, set `T3CODE_HOME` |
| `No T3 token for …` / `rejected the stored token (401)` | Create a pairing link in T3 → Settings → Connections and run `node dist/cli.js pair …` |
| `harness "…" is not usable right now` | Install, enable, or sign in to that harness inside T3; check `t3_list_harnesses {includeUnusable: true}` for the reason |
| `model "…" is not offered by harness "…"` | Use a slug or alias from `t3_list_harnesses`; nothing is substituted on purpose |
| `This idempotencyKey was rejected before` | The command failed once and T3 remembers it; fix the cause and use a new key |
| `T3 thread snapshot is missing …` | Your T3 is newer than this server's contract mirror; update t3-code-agent-mcp |

## Development

```bash
npm test                 # unit tests against a fake WebSocket server; no T3 needed
npm run typecheck
npm run build
```

Live smoke test (creates **one real thread** in your T3, visible in the UI):

```bash
npx tsx test/smoke.live.mts <projectIdOrRoot> [harness] [model]
```

Layout:

```text
src/cli.ts          entry point: serve | pair | status
src/discovery.ts    find the running T3 server
src/credentials.ts  pairing exchange + token store
src/http.ts         HTTP snapshot reads
src/rpc.ts          WebSocket RPC client (Effect RPC envelope)
src/t3.ts           typed T3 API + wait loop
src/resolve.ts      strict project / harness / model / worktree lookup
src/ids.ts          idempotency-key → deterministic ids
src/tools.ts        MCP tool definitions
src/types.ts        wire shapes mirrored from T3's contracts
```

## Security

- The stored token carries T3's standard client scopes (`orchestration:read/operate`, `terminal:operate`, `review:write`, `relay:read`). Revoke it in T3 → Settings → Connections.
- The credentials file is written with mode `0600` where the OS supports it. Treat it like a password.
- Anything reachable through your T3 (its projects, its harness credentials) is reachable through this server. Only expose it to MCP clients you trust.
- The server never opens or writes T3's SQLite database.

## License

MIT. See [LICENSE](LICENSE).
