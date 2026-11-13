# Configuration

User settings live in `~/.pi/agent/realagy/config.json` (under Pi's agent directory) and are managed interactively with `/realagy settings` or by editing the JSON file directly. Process discovery, data directories, proxy forwarding, and diagnostics are controlled by environment variables.

- [Overview](#overview)
- [`/realagy settings` and `config.json`](#realagy-settings-and-configjson)
- [Model token limits and overrides](#model-token-limits-and-overrides)
- [Environment variables](#environment-variables)
- [Files on disk](#files-on-disk)

## Overview

| Source | Holds | Takes effect |
| --- | --- | --- |
| `~/.pi/agent/realagy/config.json` | Compaction bypass (`noAutoCompaction`), full MCP output patch (`fullMcpOutput`), Pi-only agent profile (`agentProfile`), global and per-model token limits | Immediately on save in `/realagy settings` (`agy acp` restarts for process-level toggles; editing the file by hand applies on `/reload` or next Pi start) |
| Environment variables | `agy` binary path (`AGY_BIN`), data directory (`GEMINI_HOME`), usage trace log (`REALAGY_TRACE_USAGE`), upstream proxy (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`) | When Pi starts (or `/realagy setup` for `AGY_BIN` / `GEMINI_HOME`) |
| `~/.gemini/antigravity-cli/settings.json` | Antigravity CLI's own settings (`queuedMessages`, native tool permissions) | When `agy acp` starts |

## `/realagy settings` and `config.json`

Run `/realagy settings` (or `/realagy` → **Settings**) to open the settings dialog. In TUI mode it renders an interactive `SettingsList` with presets and custom inputs; in non-TUI interactive hosts (such as RPC) it opens a menu selector; in non-interactive hosts it prints the active configuration summary.

Every change in `/realagy settings` is normalized and written atomically to `~/.pi/agent/realagy/config.json` with mode `0600` (parent directory `0700`):

- Model metadata (`antigravity/*`) re-registers in Pi immediately.
- Toggling `noAutoCompaction`, `fullMcpOutput`, or `agentProfile` restarts the background `agy acp` process cleanly (immediately when idle, or before the next turn).

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

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `noAutoCompaction` | `boolean` | `true` | Start the loopback Cloud Code catalog proxy, disable `CASCADE_USE_EXPERIMENT_CHECKPOINTER*` in `fetchAvailableModels`, derive the context-unlocked `agy` binary (removing the 256K checkpoint ceiling and 64K-token / 192 KB `USER_INPUT` clamps), and raise the fresh `<pi_history>` replay budget from 160 KB to 2.2 MB so Pi owns compaction |
| `fullMcpOutput` | `boolean` | `true` | Apply the MCP output-preview truncation patch to realagy's private derived `agy` binary so individual and `parallel` MCP tool results reach the model in full (Windows x64, Linux x64, macOS arm64) |
| `agentProfile` | `boolean` | `true` | Launch `agy acp` with realagy's hidden custom agent profile (`--agent realagy-<hash>`), replacing Antigravity's system prompt and native tools with Pi's prompt and eager `pi-bridge` tools. `false` keeps Antigravity's default agent and appends a tool-policy prompt instead |
| `contextWindow` | `number` | *(model default)* | Optional positive integer overriding the global fallback context window (in tokens) reported to Pi |
| `contextWindowOverrides` | `Record<string, number>` | *(none)* | Optional map of exact Pi model IDs to positive integer context windows; takes precedence over `contextWindow` |
| `maxOutputTokens` | `number` | *(model default)* | Optional positive integer overriding the global fallback max output token limit reported to Pi |
| `maxOutputTokensOverrides` | `Record<string, number>` | *(none)* | Optional map of exact Pi model IDs to positive integer max output limits; takes precedence over `maxOutputTokens` |
| `inactivityMin` | `number` | `5` | Inactivity guard in minutes: if `agy` streams no output for this long (and no tool call is running), the turn fails with "Antigravity produced no output…". Raise it for models that generate very large single tool payloads silently; `0` disables the guard. File-only: not shown in the `/realagy settings` menu, but preserved when the menu saves |

### Validation and fallback rules

- If `config.json` does not exist, cannot be read, or contains invalid JSON, realagy uses `{ noAutoCompaction: true, fullMcpOutput: true, agentProfile: true }`.
- Non-boolean values for `noAutoCompaction`, `fullMcpOutput`, or `agentProfile` fall back to `true`.
- Token limits must be positive safe integers (or numeric strings with optional commas, underscores, or spaces, such as `"1,048,576"`). Zero, negative, non-integer, or empty values are ignored and omitted when saving.
- `inactivityMin` must be a positive safe integer (or numeric string); the literal number `0` is also accepted and disables the inactivity guard. Other values are ignored.
- Unknown keys in `config.json` are ignored and stripped the next time `/realagy settings` saves the file.
- When `noAutoCompaction` or `fullMcpOutput` is enabled, realagy must be able to derive and verify the patched `agy` binary for the current platform (Windows x64 PE, Linux x64 ELF, or macOS arm64 Mach-O). If an unsupported architecture or unrecognized binary layout is encountered, startup fails closed rather than running an unverified binary; disable the corresponding toggle only if you intentionally want the stock `agy` behavior.

## Model token limits and overrides

Pi uses each model's `contextWindow` and `maxTokens` for its footer context bar, `ctx.getContextUsage()`, and automatic compaction triggers. realagy resolves those limits in priority order:

1. **Per-model override** (`contextWindowOverrides[modelId]` or `maxOutputTokensOverrides[modelId]`)
2. **Global override** (`contextWindow` or `maxOutputTokens`)
3. **Live Cloud Code catalog limit** captured from `fetchAvailableModels` (`maxTokens` / `maxOutputTokens`) before checkpointer rewriting
4. **Verified family default**:
   - **Gemini** (`gemini-4-argon`, `gemini-3-1-pro`, `gemini-3-8-flash`): `1,048,576` context / `65,536` max output tokens
   - **Claude** (`claude-opus-5-5`, `claude-sonnet-5-5`): `1,000,000` context / `128,000` max output tokens
   - **GPT-OSS** (`gpt-oss-120b`): `131,072` context / `32,768` max output tokens

In `contextWindowOverrides` and `maxOutputTokensOverrides`, keys are the exact, case-sensitive Pi model IDs shown after `antigravity/` in `/model` (for example `gemini-3-8-flash`, `claude-sonnet-5-5`, `gpt-oss-120b`). Because effort variants (`-low`, `-medium`, `-high`, `-xhigh`, `-max`) collapse into one Pi model with thinking levels, a single model ID entry applies to all thinking levels of that model.

In `/realagy settings`:

- **Pi context window** offers `model default`, `131,072`, `256,000`, `512,000`, `1,000,000`, `1,048,576`, and `Custom…`.
- **Pi max output tokens** offers `model default`, `16,384`, `32,768`, `65,536`, `128,000`, and `Custom…`.
- **Per-model context windows** and **Per-model output tokens** list every discovered model (plus any model IDs already present in `config.json`) with `inherit global` as the first preset; choosing `inherit global` or submitting an empty custom input removes that model's override.

Token limit overrides only change the metadata reported to Pi. They do not increase Google's server-side model limits; if a prompt exceeds the upstream limit without Pi compaction, the request fails upstream rather than triggering Antigravity's local summary.

## Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `AGY_BIN` | *(unset)* | Explicit path to the `agy` executable (`~/` is expanded). Checked before `PATH` and `~/.local/bin/agy` (`agy.exe` on Windows). If `AGY_BIN` is set to a missing or non-executable file, setup fails explicitly instead of falling back to `PATH` |
| `GEMINI_HOME` | `~/.gemini` | Base directory for Antigravity CLI state: `<GEMINI_HOME>/antigravity-cli` (conversations, brain, logs, `settings.json`) and `<GEMINI_HOME>/config/agents` (hidden agent profiles) |
| `REALAGY_TRACE_USAGE` | *(unset)* | Set to `1` (or any non-empty value other than `0` or `false`) to append JSONL diagnostic events to `~/.pi/agent/realagy/usage-trace.jsonl`, or set to an absolute path to write to that file. Logs turn plans, token counts, binary derivation, catalog proxy rewrites, and session retention actions; never logs prompt or tool content |
| `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy` | *(unset)* | Upstream HTTP(S) proxy URL used by the loopback Cloud Code catalog proxy when forwarding to `https://daily-cloudcode-pa.googleapis.com` (`HTTPS_PROXY` takes precedence over `HTTP_PROXY` for HTTPS targets) |
| `NO_PROXY`, `no_proxy` | *(unset)* | Comma-separated hostnames, `.domain` suffixes, or `*` that bypass the upstream proxy in the loopback catalog proxy |

## Files on disk

| Path | Purpose |
| --- | --- |
| `~/.pi/agent/realagy/config.json` | User configuration written by `/realagy settings` (`0600`) |
| `~/.pi/agent/realagy/derived-bin/agy-<sha256>-<patches>[.exe]` | Private patched `agy` executable and its `.sha256` sidecar. Keyed by source binary SHA-256 and enabled patch set (`context-unlock`, `full-mcp-output`); older derivatives are pruned automatically, and the installed `agy` binary is never modified |
| `~/.pi/agent/realagy/usage-trace.jsonl` | Default diagnostic log file when `REALAGY_TRACE_USAGE=1` |
| `~/.gemini/config/agents/realagy-<hash>.md` | Hidden custom agent profile written when `agentProfile: true` (`GEMINI_HOME` respected). Keyed by bridged tool set hash so concurrent Pi instances with different tool loadouts do not collide; refreshed on each turn and deleted after 7 days without use |
| `~/.gemini/antigravity-cli/settings.json` | Antigravity CLI settings (`GEMINI_HOME` respected). On startup, if `queuedMessages` is unset or empty, realagy sets `"queuedMessages": "send-immediately"` (following symlinks and leaving existing values or malformed JSON untouched) so mid-turn Pi steering interrupts immediately |
| `~/.gemini/antigravity-cli/.realagy-session-ownership-v2.sqlite` | Private ownership and process-lease ledger used to retire and remove superseded realagy-created `<sessionId>.db` conversation databases in `~/.gemini/antigravity-cli/conversations/` after 7 days (see [architecture.md](architecture.md#owned-session-database-retention)) |
