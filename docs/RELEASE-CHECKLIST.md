# Release checklist

Do this before every push to `master`. It keeps the version, changelog, docs, and tests in step with the code.

## 1. Pick the version bump

This project uses [Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`.

| Change | Bump |
| --- | --- |
| Breaking change to a tool name, tool input, tool output, CLI command, or env var | `MAJOR` (or `MINOR` while still `0.x`) |
| New tool, new tool input, new prompt variant, new CLI command | `MINOR` |
| Bug fix, doc fix, prompt wording, test change, dependency update | `PATCH` |

Docs-only or test-only pushes still get a `PATCH` bump when they ship in the npm `files` list (`README.md`, `examples/orchestrator-prompt*.md`).

## 2. Update these files

| File | What to change |
| --- | --- |
| `package.json` | `version` |
| `package-lock.json` | Both top-level `version` fields (line 3 and `packages[""]`). Run `npm install --package-lock-only` if unsure |
| `README.md` → **Changelog** | Add a `### vX.Y.Z — YYYY-MM-DD` heading at the top with `Added` / `Changed` / `Fixed` / `Removed` bullets. One line per user-visible change |
| `README.md` → **Tools** table and **Tool reference** | Any tool, input, or output that changed |
| `README.md` → **Compatibility** | If you rewired a T3 touch point, update the upstream commit, server version, and date |
| `README.md` → **Environment variables** / **Troubleshooting** | If you added an env var, CLI command, or a new error message |
| `examples/` | Client config or prompt templates, if the tool surface or prompt changed |
| `src/prompts.ts` | If you added or renamed a prompt variant, add it here and to `package.json` → `files` |
| `test/` | Add or update the test that covers the change |

## 3. Verify

```bash
npm run typecheck
npm test
npm run build
```

All three must pass. Do not push on red.

## 4. Commit and tag

- One commit per logical change. Use Conventional Commits: `feat(tools): …`, `fix(rpc): …`, `docs: …`, `chore(release): vX.Y.Z`.
- The release commit is `chore(release): vX.Y.Z` and contains only the version bump and changelog entry.
- Tag it: `git tag vX.Y.Z` and push tags with `git push origin master --tags`.

## 5. Never commit

- `CLAUDE.md`, `AGENTS.md` (local agent instructions; already in `.gitignore`)
- `dist/`, `node_modules/`, `*.log`
- Pairing tokens, `credentials.json`, or any T3 server output pasted into docs
