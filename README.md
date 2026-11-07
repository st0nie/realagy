# realagy

A minimal [pi](https://github.com/earendil-works/pi-coding-agent) provider for Google Antigravity. It runs the local Antigravity CLI as an ACP server (`agy acp`) and exposes the account's Gemini, Claude, and GPT models as ordinary `antigravity/*` pi models. The model works with pi's tools instead of agy's own, and pi keeps the transcript.

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

realagy looks for `agy` in `AGY_BIN`, then on `PATH`, then at `~/.local/bin/agy`. It never installs agy or handles credentials, so pi's `/login` has nothing to configure for `antigravity`. If agy is missing or signed out, pi says so at startup; `/realagy setup` checks again and shows the install or sign-in steps. agy updates itself.

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
| `/realagy settings` | Configure Agy auto-compaction bypass, Pi-only agent profile, and optional Pi token-limit overrides (`~/.pi/agent/realagy/config.json`) |
| `/realagy setup` | Checks agy: shows install steps when it is missing, sign-in steps when it cannot start a session, and reloads the model catalog when it is ready |
| `/realagy usage` | Cache-hit rate for this session plus every quota group's 5-hour and weekly remaining share and reset times (from the live `agy acp` server, or `agy --print /usage`) |

Quota is fetched only when you run `/realagy usage`. There is no engine switch, delegation tool, or global MCP registration.

## Pi tools and agy's own tools

realagy starts agy with its own hidden agent profile, `~/.gemini/config/agents/realagy-<hash>.md`. It replaces agy's system prompt (Antigravity's identity, artifacts, IDE slash commands, and its rule to write every file and symbol as a `file://` link) with a short prompt of realagy's, and leaves the model with pi's tools only: agy's `read_file`, `run_command`, `write_file`, `edit_file`, subagents, and web search are gone. pi's tools stay direct tools, so their calls go through pi's permissions and show up as pi tool calls. File references arrive as plain paths (`src/app.ts:10-20`); a `file://` link a model still writes is rewritten to one while the reply streams. The profile is hidden from normal agy sessions (only `agy agents` lists it), changes only processes realagy starts, and is deleted after 7 days without use.

When `agentProfile` is set to `false` in `/realagy settings` (or when the profile cannot be written) agy keeps its default agent. The model then sees pi's tools next to agy's built-in ones, since agy cannot switch its own tools off. realagy adds a short policy to agy's system prompt that asks the model to use pi's tools for reading files (images included), running commands, and changing files, to work itself instead of starting subagents, background tasks, or scheduled tasks, and to write plain paths instead of `file://` links. agy's own tools still work when the model picks them, and pi always shows it:

- each finished call adds a line to the reply's thinking, for example `agy → run_command npm test ✓ 2.1s`;
- while agy works on its own, a live panel above the editor lists each running call, background command, and subagent with a spinner and its elapsed time (the 5-minute inactivity limit waits for a running call);
- a command agy moved to the background, or a subagent, is marked `(runs in background)`. When it finishes, a tool card with the exit code and the last 5 lines of its output (expand it with ctrl+o or a left click for the whole output and the log path) is added to the conversation and pi's agent reacts to it: right away when idle, otherwise after its current work. agy's own leftover output never leaks into your next reply.

## Interrupts and failures

- Esc cancels the running Antigravity turn through ACP. agy keeps running, and the next prompt continues in the same session. agy is restarted only if it ignores the cancel for 10 seconds.
- Starting a new prompt while Antigravity still waits on pi tool results (for example, after the tool calls were interrupted) ends that stale turn instead of waiting for it to time out.
- When agy answers that its servers are busy ("high traffic"), the turn fails as an overload error, so pi retries it instead of keeping the notice as the answer.
- If agy cannot start or exits mid-turn, the turn fails with the binary path, the exit code, and agy's last error line. The next prompt starts it again. A turn with no output for 5 minutes is stopped, unless one of agy's own tools is still running.
- After `/reload`, `pi -c`, or `/tree`, realagy resumes the matching Antigravity session. If agy's copy of that conversation is gone, the next prompt starts a new session with the full pi transcript.

## Context windows, compaction bypass, and settings

By default, realagy unlocks Antigravity's full context window so Pi manages compaction, and reports each model's real context window and output limit to Pi:

- **Gemini (`gemini-4-argon`, `gemini-3-1-pro`, `gemini-3-8-flash`)**: 1,048,576 context / 65,536 max output tokens
- **Claude (`claude-opus-5-5`, `claude-sonnet-5-5`)**: 1,000,000 context / 128,000 max output tokens
- **GPT-OSS (`gpt-oss-120b`)**: 131,072 context / 32,768 max output tokens

Out of the box (`noAutoCompaction: true`), realagy starts an embedded loopback Cloud Code reverse proxy and passes `--cloud_code_endpoint http://127.0.0.1:<port>` to `agy acp`. Only `fetchAvailableModels` is buffered: realagy captures each model's upstream `maxTokens` and `maxOutputTokens` for Pi, disables every `CASCADE_USE_EXPERIMENT_CHECKPOINTER*` configuration, and raises the catalog `maxTokens` clamp so Agy does not run local automatic compaction prematurely. Generation, authentication, quota calls, and streaming RPCs pass through unchanged. Existing `HTTP_PROXY` / `HTTPS_PROXY` and `NO_PROXY` settings are honored; no TLS CA, mitmproxy, or system proxy change is needed.

Run `/realagy settings` (or edit `~/.pi/agent/realagy/config.json`) to toggle the compaction bypass (`noAutoCompaction`), toggle the Pi-only agent profile (`agentProfile`), or override Pi's reported global `contextWindow` and `maxOutputTokens`. Changes save atomically and apply without restarting Pi: model metadata refreshes immediately, and process-level changes (`noAutoCompaction` or `agentProfile`) restart `agy acp` cleanly for the next turn while preserving remembered sessions.

For a model-specific context window, add `contextWindowOverrides` to `config.json`. Its keys are exact, case-sensitive Pi model IDs shown after `antigravity/` in `/model` (without the provider prefix); one entry covers every thinking tier grouped into that Pi model. A matching per-model value takes precedence over the global `contextWindow`; models without an entry use the global value, then the upstream catalog or family default. The settings menu continues to edit the global values and preserves this map. For example:

```json
{
  "noAutoCompaction": true,
  "agentProfile": true,
  "contextWindow": 512000,
  "contextWindowOverrides": {
    "gemini-3-8-flash": 1048576,
    "claude-sonnet-5-5": 200000
  }
}
```

Here Gemini 3.8 Flash reports 1,048,576 tokens, Claude Sonnet 5.5 reports 200,000, and every other model reports 512,000. Omitting `contextWindow` would leave those other models at their catalog or family defaults. These overrides affect only metadata reported to Pi, not Agy's real server-side limits or `maxOutputTokens`.

The bypass does not increase real server-side model limits; when a conversation exceeds the upstream window without Pi compaction, the request fails rather than triggering Agy's local summary.

| Setting (`~/.pi/agent/realagy/config.json`) | Default | Effect |
| --- | --- | --- |
| `noAutoCompaction` | `true` | Enable the loopback catalog proxy and disable Agy's local automatic compaction |
| `agentProfile` | `true` | Run Agy with realagy's hidden Pi-only agent profile (`false` keeps Agy's default agent) |
| `contextWindow` | *(model default)* | Optional positive integer overriding the context window reported to Pi for all models |
| `contextWindowOverrides` | *(none)* | Optional map of exact Pi model IDs to positive-integer context windows; each match takes precedence over `contextWindow` |
| `maxOutputTokens` | *(model default)* | Optional positive integer overriding the output limit reported to Pi for all models |

| Environment | Effect |
| --- | --- |
| `AGY_BIN` | Path to the `agy` binary |
| `GEMINI_HOME` | agy's data root (default `~/.gemini`) |
| `REALAGY_TRACE_USAGE` | `1` or an absolute path: log turn plans and token counts (no content) to `~/.pi/agent/realagy/usage-trace.jsonl` |

## Layout

| Path | What it holds |
| --- | --- |
| `extensions/index.ts` | Composition root: pi MCP bridge, `antigravity/*` models, agy discovery, `/realagy settings`, `/realagy setup`, `/realagy usage` |
| `src/provider.ts` | pi assistant event stream, MCP → `toolUse` → `toolResult` round-trips, usage mapping |
| `src/transcript.ts` | Transcript serialization, fingerprints, warm-session turn planning across checkpoints |
| `src/models.ts` | ACP model catalog parsing, effort grouping, per-model limits and overrides, offline fallback catalog |
| `src/settings.ts` | `/realagy settings` TUI component, validation, and `~/.pi/agent/realagy/config.json` persistence |
| `src/mcp-server.ts`, `src/bridge-catalog.ts` | Loopback, token-protected MCP server for pi's tools (every tool an extension may activate; only active ones run) |
| `src/tool-loadout.ts` | Undoes the situational tools pi's `/tree` restore activates |
| `src/quota.ts`, `src/usage-trace.ts` | Cache/quota meter, quota-exhaustion notice, usage diagnostics |
| `src/acp/setup.ts` | Finding `agy` and its data dir |
| `src/acp/connection.ts`, `driver.ts`, `events.ts`, `jsonrpc.ts` | `agy acp` process, ACP protocol, serialized turns, frame mapping |
| `src/acp/catalog-proxy.ts` | Loopback Cloud Code proxy (default on), upstream limit capture, catalog compaction rewrite, upstream proxy support |
| `src/acp/step-usage.ts` | Exact per-model-call tokens from agy's conversation store, and `/tree` forks of it |
| `src/agent-profile.ts`, `src/tool-policy.ts` | agy's custom agent profile (realagy's system prompt, eager pi tools) and the tool policy appended to it |
| `src/native-tools.ts`, `src/acp/background.ts`, `src/background-card.ts` | Thinking lines and the live panel for agy's own tool calls; finished background work as a conversation card that wakes pi's agent |
| `src/stream-sanitizer.ts`, `src/file-links.ts`, `src/frame-guard.ts`, `src/redact.ts` | Hiding injected `<SYSTEM_MESSAGE>` blocks, rewriting `file://` links to plain paths, dropping stdout noise, redacting secrets from logs and errors |
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

agy offers third-party models only to clients it recognizes, so realagy declares `clientInfo.name = "zed"` to get the same Claude/GPT catalog Zed sees. Sign-in, quotas, and generation all still go through Google's official agy CLI and Cloud Code endpoint. The optional loopback proxy forwards that same traffic and never bypasses quota checks.
