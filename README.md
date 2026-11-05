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
| `antigravity/gpt-oss-120b` | medium |

The catalog comes live from agy and depends on the account.

## Commands

| Command | What it does |
| --- | --- |
| `/agy setup` | Checks agy: shows install steps when it is missing, sign-in steps when it cannot start a session, and reloads the model catalog when it is ready |
| `/agy usage` | Cache-hit rate for this session plus every quota group's 5-hour and weekly remaining share and reset times (from `agy --print /usage`) |

Nothing runs in the background: quota is fetched only when you run `/agy usage`. There is no footer status, settings panel, engine switch, delegation tool, global MCP registration, or config file.

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
| `src/transcript.ts` | Transcript serialization, fingerprints, warm-session turn planning |
| `src/models.ts` | ACP model catalog parsing, effort grouping, family limits, offline fallback catalog |
| `src/mcp-server.ts`, `src/bridge-catalog.ts` | Loopback, token-protected MCP server for pi's active tools |
| `src/quota.ts`, `src/usage-trace.ts` | Cache/quota meter, quota-exhaustion notice, usage diagnostics |
| `src/acp/setup.ts` | Finding `agy` and its data dir |
| `src/acp/connection.ts`, `driver.ts`, `events.ts`, `jsonrpc.ts` | `agy acp` process, ACP protocol, serialized turns, frame mapping |
| `src/acp/step-usage.ts` | Exact per-model-call tokens from agy's conversation store |
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
