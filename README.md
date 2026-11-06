# realagy

A minimal [pi](https://github.com/earendil-works/pi-coding-agent) provider for Google Antigravity. It runs the local Antigravity CLI as an ACP server (`agy acp`) and exposes the account's Gemini, Claude, and GPT models as ordinary `antigravity/*` pi models. Pi's active tools are offered to the model next to agy's own tools, and pi keeps the transcript.

| Document | For |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | How turns, tools, images, session reuse, usage, context, and quota work |
| [docs/development.md](docs/development.md) | Building, testing, live smokes, conventions and pitfalls for contributors |

## Install

Install the [Antigravity CLI](https://antigravity.google/docs/cli/acp/), sign in once with it, then add the extension:

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy                                   # sign in (or: agy acp --login)
pi install git:github.com/st0nie/realagy
```

realagy looks for `agy` in `AGY_BIN`, then on `PATH`, then at `~/.local/bin/agy`. It never installs agy or handles credentials, so pi's `/login` has nothing to configure for `antigravity`. If agy is missing or signed out, pi says so at startup; `/agy setup` checks again and shows the install or sign-in steps. agy updates itself.

Choose a model in pi's `/model` picker:

| Model | Thinking |
| --- | --- |
| `antigravity/gemini-4-argon`, `antigravity/gemini-3-1-pro`, `antigravity/gemini-3-8-flash` | low / medium / high |
| `antigravity/claude-opus-5-5`, `antigravity/claude-sonnet-5-5` | low / medium / high |
| `antigravity/gpt-oss-120b` | medium (text only, no image input) |

The catalog comes live from agy and depends on the account.

## Commands

| Command | What it does |
| --- | --- |
| `/agy setup` | Checks agy: shows install steps when it is missing, sign-in steps when it cannot start a session, and reloads the model catalog when it is ready |
| `/agy usage` | Cache-hit rate for this session plus every quota group's 5-hour and weekly remaining share and reset times (from `agy --print /usage`) |

Quota is fetched only when you run `/agy usage`. There is no settings panel, engine switch, delegation tool, global MCP registration, or config file.

## Pi tools and agy's own tools

The model sees pi's active tools next to agy's built-in ones (`read_file`, `run_command`, `write_file`, subagents, web search, …); agy cannot switch its own tools off. realagy adds a short policy to agy's system prompt that asks the model to use pi's tools for reading files (images included), running commands, and changing files, so that work goes through pi's permissions and shows up as pi tool calls, and to work itself instead of starting subagents, background tasks, or scheduled tasks. agy's own tools still work when the model picks them, and pi always shows it:

- each finished call adds a line to the reply's thinking, for example `agy → run_command npm test ✓ 2.1s`;
- while a call runs, the status line shows `agy: run_command npm test … 12s` (the 5-minute inactivity limit waits for it);
- a command agy moved to the background, or a subagent, is marked `(runs in background)`, and a notice appears when agy reports it finished, with the exit code and the end of its output. Its leftover output does not leak into your next reply.

## Interrupts and failures

- Esc cancels the running Antigravity turn through ACP. agy keeps running, and the next prompt continues in the same session. agy is restarted only if it ignores the cancel for 10 seconds.
- Starting a new prompt while Antigravity still waits on pi tool results (for example, after the tool calls were interrupted) ends that stale turn instead of waiting for it to time out.
- When agy answers that its servers are busy ("high traffic"), the turn fails as an overload error, so pi retries it instead of keeping the notice as the answer.
- If agy cannot start or exits mid-turn, the turn fails with the binary path, the exit code, and agy's last error line. The next prompt starts it again. A turn with no output for 5 minutes is stopped, unless one of agy's own tools is still running.
- After `/reload`, `pi -c`, or `/tree`, realagy resumes the matching Antigravity session. If agy's copy of that conversation is gone, the next prompt starts a new session with the full pi transcript.

| Environment | Effect |
| --- | --- |
| `AGY_BIN` | Path to the `agy` binary |
| `GEMINI_HOME` | agy's data root (default `~/.gemini`) |
| `REALAGY_TRACE_USAGE` | `1` or an absolute path: log turn plans and token counts (no content) to `~/.pi/agent/realagy/usage-trace.jsonl` |

## Layout

| Path | What it holds |
| --- | --- |
| `extensions/index.ts` | Composition root: pi MCP bridge, `antigravity/*` models, agy discovery, `/agy setup`, `/agy usage` |
| `src/provider.ts` | pi assistant event stream, MCP → `toolUse` → `toolResult` round-trips, usage mapping |
| `src/transcript.ts` | Transcript serialization, fingerprints, warm-session turn planning across checkpoints |
| `src/models.ts` | ACP model catalog parsing, effort grouping, family limits, offline fallback catalog |
| `src/mcp-server.ts`, `src/bridge-catalog.ts` | Loopback, token-protected MCP server for pi's active tools |
| `src/quota.ts`, `src/usage-trace.ts` | Cache/quota meter, quota-exhaustion notice, usage diagnostics |
| `src/acp/setup.ts` | Finding `agy` and its data dir |
| `src/acp/connection.ts`, `driver.ts`, `events.ts`, `jsonrpc.ts` | `agy acp` process, ACP protocol, serialized turns, frame mapping |
| `src/acp/step-usage.ts` | Exact per-model-call tokens from agy's conversation store, and `/tree` forks of it |
| `src/tool-policy.ts` | The tool policy appended to agy's system prompt |
| `src/native-tools.ts`, `src/acp/background.ts` | Thinking lines and live status for agy's own tool calls; notices when its background work finishes |
| `src/stream-sanitizer.ts`, `src/frame-guard.ts`, `src/redact.ts` | Hiding injected `<SYSTEM_MESSAGE>` blocks, dropping stdout noise, redacting secrets from logs and errors |
| `tests/` | Vitest suites; `tests/helpers/fake-acp-server.mjs` stands in for agy |
| `scripts/` | Live smokes and probes (spend account quota) |

## Build

```sh
bun install            # or npm install
npm run check          # TypeScript + tests
npm run smoke:pi       # load the extension through pi's real loader
```

[docs/development.md](docs/development.md) has the live smokes and the conventions.

## Protocol note

agy offers third-party models only to clients it recognizes, so realagy declares `clientInfo.name = "zed"` to get the same Claude/GPT catalog Zed sees. Sign-in, quotas, and generation all still go through Google's official agy CLI. realagy does not call private endpoints or bypass quota checks.
