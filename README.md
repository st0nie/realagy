# realagy

A minimal [pi](https://github.com/earendil-works/pi-coding-agent) provider for Google Antigravity. It runs the local Antigravity CLI as an ACP server (`agy acp`) and exposes the account's Gemini, Claude, and GPT models as ordinary `antigravity/*` pi models. The model works with pi's tools instead of agy's own, and pi keeps the transcript.

| Document | For |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | How turns, tools, images, session reuse, usage, context, and quota work |
| [docs/configuration.md](docs/configuration.md) | `/realagy settings`, `~/.pi/agent/realagy/config.json`, environment variables, and files on disk |
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
| `/realagy` | Open an interactive Settings / Usage / Setup menu (cancel returns without running a command) |
| `/realagy settings` | Configure Agy auto-compaction bypass, Pi-only agent profile, and optional Pi token-limit overrides (`~/.pi/agent/realagy/config.json`) |
| `/realagy setup` | Checks agy: shows install steps when it is missing, sign-in steps when it cannot start a session, and reloads the model catalog when it is ready |
| `/realagy refresh` | Refresh the model catalog and update its local cache |
| `/realagy usage` | Cache-hit rate for this session plus every quota group's 5-hour and weekly remaining share and reset times (from the live `agy acp` server, or `agy --print /usage`) |

Quota is fetched only when you run `/realagy usage`. There is no engine switch, delegation tool, or global MCP registration.
The last successful model catalog is cached in `~/.pi/agent/realagy/models.json` and loaded immediately on startup. Live discovery replaces it in the background; `/realagy refresh` requests another catalog without restarting agy. Without a valid cache, no models are shown until discovery succeeds. If discovery returns no models, try `/realagy refresh`; if it fails, run `/realagy setup`.

## Pi tools and agy's own tools

realagy starts agy with its own hidden agent profile, `~/.gemini/config/agents/realagy-<hash>.md`. It replaces agy's system prompt (Antigravity's identity, artifacts, IDE slash commands, and its rule to write every file and symbol as a `file://` link) with a short prompt of realagy's, and leaves the model with pi's tools only: agy's `read_file`, `run_command`, `write_file`, `edit_file`, subagents, and web search are gone. pi's tools stay direct tools, so their calls go through pi's permissions and show up as pi tool calls. File references arrive as plain paths (`src/app.ts:10-20`); a `file://` link a model still writes is rewritten to one while the reply streams. The profile is hidden from normal agy sessions (only `agy agents` lists it), changes only processes realagy starts, and is deleted after 7 days without use.

When `agentProfile` is set to `false` in `/realagy settings` (or when the profile cannot be written) agy keeps its default agent. The model then sees pi's tools next to agy's built-in ones, since agy cannot switch its own tools off. realagy adds a short policy to agy's system prompt that asks the model to use pi's tools for reading files (images included), running commands, and changing files, to work itself instead of starting subagents, background tasks, or scheduled tasks, and to write plain paths instead of `file://` links. agy's own tools still work when the model picks them, and pi always shows it:

- each finished call adds a line to the reply's thinking, for example `agy → run_command npm test ✓ 2.1s`;
- while agy works on its own, a live panel above the editor lists each running call, background command, and subagent with a spinner and its elapsed time (the 5-minute inactivity limit waits for a running call);
- a command agy moved to the background, or a subagent, is marked `(runs in background)`. When it finishes, a tool card with the exit code and the last 5 lines of its output (expand it with ctrl+o or a left click for the whole output and the log path) is added to the conversation and pi's agent reacts to it: right away when idle, otherwise after its current work. agy's own leftover output never leaks into your next reply.

## Parallel Pi tools

The bridge exposes a virtual `parallel` tool for independent Pi tool calls. It accepts 1–16 calls, each with a Pi tool `name` and its `arguments`:

```json
{
  "calls": [
    { "name": "read", "arguments": { "path": "src/a.ts" } },
    { "name": "read", "arguments": { "path": "src/b.ts" } },
    { "name": "bash", "arguments": { "command": "bun test" } }
  ]
}
```

realagy expands this one MCP request into multiple genuine Pi `toolCall` blocks in the same assistant message. Pi applies its normal permissions, hooks, cancellation, and native scheduler: eligible calls run concurrently, while Pi's global sequential mode or a tool's `executionMode: "sequential"` is still respected. Use `parallel` only for independent work; do not use it for dependent steps or writes that can conflict. Nested `parallel` calls and inner `bridge_poll_result` calls are rejected. Invalid batches, inactive tools, and empty or oversized batches are rejected before any tool starts.

The MCP response contains a JSON `results` array in input order. Every entry has `callId`, `name`, `isError`, and `content`; text is embedded, while images are referenced by their 1-based `index` in the MCP response's appended image blocks. One failed tool does not hide the other results, and the aggregate MCP `isError` is true if any entry failed. Cancellation aborts the whole batch without leaving a pending MCP request.

A batch still running after 150 seconds returns `STILL RUNNING` with its outer `parallel` call ID. Poll that outer ID with `bridge_poll_result`; inner call IDs are not separate poll handles. Ordinary single-tool ACP calls retain their existing behavior.

## Interrupts and failures

- Esc cancels the running Antigravity turn through ACP. agy keeps running, and the next prompt continues in the same session. agy is restarted only if it ignores the cancel for 10 seconds.
- Starting a new prompt while Antigravity still waits on pi tool results (for example, after the tool calls were interrupted) ends that stale turn instead of waiting for it to time out.
- When agy answers that its servers are busy ("high traffic"), the turn fails as an overload error, so pi retries it instead of keeping the notice as the answer.
- If agy cannot start or exits mid-turn, the turn fails with the binary path, the exit code, and agy's last error line. The next prompt starts it again. A turn with no output for 5 minutes is stopped, unless one of agy's own tools is still running.
- After `/reload` or `pi -c`, realagy restores only the latest warm session on the current Pi branch, and only an exact unchanged transcript prefix reuses it. `/tree`, compaction, editing, or rollback invalidates that cache; the next prompt starts a new ACP session with one bounded replay of the selected Pi history. agy's SQLite conversation store is never forked or rewritten.

## Context windows, compaction bypass, and settings

By default, realagy unlocks Antigravity's full context window so Pi manages compaction, and reports each model's real context window and output limit to Pi:

- **Gemini (`gemini-4-argon`, `gemini-3-1-pro`, `gemini-3-8-flash`)**: 1,048,576 context / 65,536 max output tokens
- **Claude (`claude-opus-5-5`, `claude-sonnet-5-5`)**: 1,000,000 context / 128,000 max output tokens
- **GPT-OSS (`gpt-oss-120b`)**: 131,072 context / 32,768 max output tokens

Out of the box (`noAutoCompaction: true`), realagy starts an embedded loopback Cloud Code reverse proxy and passes `--cloud_code_endpoint http://127.0.0.1:<port>` to `agy acp`. Only `fetchAvailableModels` is buffered: realagy captures each model's upstream `maxTokens` and `maxOutputTokens` for Pi, disables every `CASCADE_USE_EXPERIMENT_CHECKPOINTER*` configuration, and raises the catalog `maxTokens` clamp so Agy does not run local automatic compaction prematurely. Generation, authentication, quota calls, and streaming RPCs pass through unchanged. Existing `HTTP_PROXY` / `HTTPS_PROXY` and `NO_PROXY` settings are honored; no TLS CA, mitmproxy, or system proxy change is needed.


With `noAutoCompaction: true` (the default), realagy derives a private agy executable in `~/.pi/agent/realagy/derived-bin/` with the context-window and per-input truncation gates unlocked. With `fullMcpOutput: true` (also the default), the same in-memory derivative additionally returns complete individual and `parallel` MCP tool results instead of agy's truncated preview. The two TypeScript patches compose before the derivative is signed, hash-verified, cached, and launched by absolute path; the source agy and `PATH` are never modified. Windows x64, Linux x64, and macOS arm64 are supported; macOS derivatives are ad-hoc signed locally after patching. Every source and patch combination is SHA-256 keyed, Go functions are resolved from `pclntab`, and instruction layouts must match the expected signatures. An unrecognized upgrade or unsupported architecture fails explicitly rather than applying fixed offsets. Disabling both patches uses the original agy. Authentication, telemetry, client identity, and request signing code remain untouched.
Run `/realagy settings` (or edit `~/.pi/agent/realagy/config.json`) to toggle the compaction bypass (`noAutoCompaction`), complete MCP output (`fullMcpOutput`), and the Pi-only agent profile (`agentProfile`), or override Pi's reported global `contextWindow` and `maxOutputTokens`. Changes save atomically and apply without restarting Pi: model metadata refreshes immediately, and process-level changes (`noAutoCompaction`, `fullMcpOutput`, or `agentProfile`) restart `agy acp` cleanly for the next turn. Pi's effective context is always authoritative: exact-prefix turns reuse the native session, while compaction, edits, and `/tree` navigation rebuild it with one bounded `<pi_history>` replay (2.2 MB unlocked, 160 KB otherwise).

Realagy tracks ownership of new ACP sessions and, after a successful replacement and a seven-day retention period, removes the old session's conversation database and its SQLite sidecars when no live realagy/Pi or agy process holds a lease. A currently usable or resumed checkpoint stays protected; missing databases cause a fresh replay. Cleanup runs when realagy starts and after replacements, and waits for long-running instances and their agy processes to exit. Sessions resumed by another runtime are conservatively retained because another Pi session may reference them. Catalog-only sessions, existing sessions without an ownership record, and sessions created directly in agy are not cleaned. `brain` directories, images, and task logs are never removed. See [session retention](docs/architecture.md#owned-session-database-retention) for safety and recovery details.

For model-specific limits, open `/realagy settings` and choose **Per-model context windows** or **Per-model output tokens**. Each submenu lists the available models with either its override or `inherit global`; select a model to choose a preset, enter a custom positive integer, or restore inheritance. The main settings list shows only the two submenu entries and their override counts. RPC hosts expose the same two submenus. Changes are stored in `contextWindowOverrides` and `maxOutputTokensOverrides`, whose keys are exact, case-sensitive Pi model IDs shown after `antigravity/` in `/model` (without the provider prefix); one entry covers every thinking tier grouped into that Pi model. A matching per-model value takes precedence over its corresponding global `contextWindow` or `maxOutputTokens`; models without an entry use the global value, then the upstream catalog or family default. The equivalent JSON configuration is:

```json
{
  "noAutoCompaction": true,
  "fullMcpOutput": true,
  "agentProfile": true,
  "contextWindow": 512000,
  "maxOutputTokens": 32768,
  "contextWindowOverrides": {
    "gemini-3-8-flash": 1048576,
    "claude-sonnet-5-5": 200000
  },
  "maxOutputTokensOverrides": {
    "gemini-3-8-flash": 65536
  }
}
```

Here Gemini 3.8 Flash reports a 1,048,576-token context window and 65,536-token output limit, Claude Sonnet 5.5 reports a 200,000-token context window and the global 32,768-token output limit, and every other model uses the global limits. Omitting either global value would leave unlisted models at their catalog or family defaults. These overrides affect only metadata reported to Pi, not Agy's real server-side limits.

The bypass does not increase real server-side model limits; when a conversation exceeds the upstream window without Pi compaction, the request fails rather than triggering Agy's local summary.

| Setting (`~/.pi/agent/realagy/config.json`) | Default | Effect |
| --- | --- | --- |
| `noAutoCompaction` | `true` | Enable the loopback catalog proxy, derive the context-unlocked agy, disable Agy's local automatic compaction, and allow a 2.2 MB history replay |
| `fullMcpOutput` | `true` | Add the MCP output-preview truncation patch to the same private agy derivative; supported on Windows x64, Linux x64, and macOS arm64 |
| `agentProfile` | `true` | Run Agy with realagy's hidden Pi-only agent profile (`false` keeps Agy's default agent) |
| `contextWindow` | *(model default)* | Optional positive integer overriding the context window reported to Pi for all models |
| `contextWindowOverrides` | *(none)* | Optional map of exact Pi model IDs to positive-integer context windows; each match takes precedence over `contextWindow` |
| `maxOutputTokens` | *(model default)* | Optional positive integer overriding the output limit reported to Pi for all models |
| `maxOutputTokensOverrides` | *(none)* | Optional map of exact Pi model IDs to positive-integer output limits; each match takes precedence over `maxOutputTokens` |

| Environment | Effect |
| --- | --- |
| `AGY_BIN` | Path to the `agy` binary |
| `GEMINI_HOME` | agy's data root (default `~/.gemini`) |
| `REALAGY_TRACE_USAGE` | `1` or an absolute path: log turn plans and token counts (no content) to `~/.pi/agent/realagy/usage-trace.jsonl` |

See [docs/configuration.md](docs/configuration.md) for the full configuration reference, precedence and validation rules, proxy variables, and files on disk.

## Layout

| Path | What it holds |
| --- | --- |
| `extensions/index.ts` | Composition root: pi MCP bridge, `antigravity/*` models, agy discovery, `/realagy settings`, `/realagy setup`, `/realagy usage` |
| `src/provider.ts` | pi assistant event stream, MCP → `toolUse` → `toolResult` round-trips, usage mapping |
| `src/parallel.ts` | Explicit `parallel` schema and validation, ordered result/image aggregation |
| `src/transcript.ts` | Authoritative transcript serialization, exact-prefix warm reuse, and bounded `<pi_history>` rebuild planning |
| `src/models.ts` | ACP model catalog parsing, effort grouping, per-model limits and overrides |
| `src/settings.ts` | `/realagy settings` TUI component, validation, and `~/.pi/agent/realagy/config.json` persistence |
| `src/mcp-server.ts`, `src/bridge-catalog.ts` | Loopback, token-protected MCP server for pi's tools (every tool an extension may activate; only active ones run) |
| `src/tool-loadout.ts` | Undoes the situational tools pi's `/tree` restore activates |
| `src/quota.ts`, `src/usage-trace.ts` | Cache/quota meter, quota-exhaustion notice, usage diagnostics |
| `src/acp/setup.ts` | Finding `agy` and its data dir |
| `src/acp/derived-agy.ts`, `context-unlock.ts`, `go-symbols.ts`, `output-patch.ts`, `binary-image.ts` | One SHA-256-keyed private agy derivative, Go `pclntab` symbol lookup, context-window/input unlock, target-preserving MCP output patch, ELF/PE/Mach-O inspection |
| `src/acp/connection.ts`, `driver.ts`, `events.ts`, `jsonrpc.ts` | `agy acp` process, ACP protocol, serialized turns, frame mapping |
| `src/acp/catalog-proxy.ts` | Loopback Cloud Code proxy (default on), upstream limit capture, catalog compaction rewrite, upstream proxy support |
| `src/acp/step-usage.ts` | Read-only exact per-model-call tokens and prompt-delivery evidence from agy's conversation store |
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
