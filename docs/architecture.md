# Architecture

`agy acp` runs the agent: it generates text and reasoning and decides which tools to use. Pi owns the transcript and rendering, and its active tools are offered alongside agy's own.

## Process and models

The extension starts one long-lived `agy acp` process per pi session (`src/acp/driver.ts`). It shares the Antigravity CLI's sign-in, settings, and data dir (`~/.gemini/antigravity-cli`). On startup realagy:

1. finds `agy` (`AGY_BIN` > `PATH` > `~/.local/bin/agy`). If none is found, it points to `/agy setup` and stops there;
2. sets `queuedMessages` to `send-immediately` in agy's `settings.json` when it is unset, so pi steering interrupts the agent the way pi expects;
3. reads the live model catalog from `session/new` and registers it as `antigravity/*`. Effort tiers (`-low`, `-medium`, `-high`) collapse into one pi model with thinking levels (`src/models.ts`).

The provider is registered with ambient-only auth: there is no `login` method, pi never stores a key, and the provider counts as configured whenever agy is present. agy offers Claude/GPT only to clients it recognizes, so `initialize` sends `clientInfo.name = "zed"`.

## Tools

agy keeps its native tools (`read_file`, `run_command`, `edit_file`, `write_file`, `search_web`, subagents, …); `agy acp` ignores tool allowlists, and the model picks whichever tool fits. Native tools run inside agy under its own permission rules (`~/.gemini/antigravity-cli/settings.json`), and realagy approves agy's permission requests. Pi's active tools are served by a loopback MCP server (`src/mcp-server.ts`) that requires a shared-secret header. The server is registered with every ACP session as the eager `pi-bridge`, so models see pi tools directly instead of going through agy's lazy `call_mcp_tool` helper.

A pi tool call follows this path:

1. agy calls a pi tool over MCP. The request is parked.
2. realagy emits a genuine pi `toolCall` and ends the assistant message with `toolUse`.
3. Pi runs the tool under its normal permission policy and hooks.
4. Pi's `toolResult` answers the parked MCP request, and the same ACP turn continues.

After 20 seconds, a slow tool returns a `STILL RUNNING` handle that the model resolves through `bridge_poll_result`. This avoids upstream MCP timeouts.

## Images

Pi image results go back as ordinary MCP image blocks. agy stores them under its conversation (`brain/<session>/.system_generated/steps/<n>/media_*.png`) and shows them to the model, so the same ACP session continues and no history is replayed. Image files can also be opened directly with agy's native `read_file`. Images in pi's transcript are sent as ACP image blocks when a fresh session starts.

## Session reuse and prompt caching

Every new user turn is planned from pi's current transcript (`src/transcript.ts`).

- **Warm:** the last turn completed cleanly, and a SHA-256 fingerprint of the pi messages that session holds still matches, along with the cwd and active tool set. realagy reuses the ACP session and sends only the messages pi added since. Plain user messages go as ordinary prompt text. Anything else (other models' replies, tool results, updated pi system instructions) goes as a `pi://transcript-delta` resource. agy's native history stays an unchanged prompt prefix the provider can cache.
- **Fresh:** after compaction, branch navigation, edits, a tool or cwd change, or a failed or aborted turn, realagy starts a new session and sends the whole transcript as `pi://transcript`.

If agy can no longer load a remembered session, the driver opens a new session and sends the full transcript, not the delta. Fingerprints leave out thinking, which is model-private. A continuation after a pi tool result always re-enters the running ACP turn.

## Usage, context, and quota

`agy acp` reports usage only once per prompt, summed over all of its internal model calls. Exact per-call counts live in agy's conversation store, `~/.gemini/antigravity-cli/conversations/<sessionId>.db`. Agent steps (`step_type` 15) carry metadata field 9: 2 = uncached input, 3 = output, 5 = cache read. `src/acp/step-usage.ts` reads the steps that are new since the last report, both when a tool call ends a pi message and when the prompt ends.

| pi `Usage` field | Source |
| --- | --- |
| `input`, `cacheRead`, `output` | Sum over the model calls the pi message covers, so pi's footer shows real `↑ R ↓` and `CH` |
| `totalTokens` | Context held by the latest model call. Pi's footer, `ctx.getContextUsage()`, and compaction use it as current occupancy |
| parallel tool calls | One model call can request several tools, and each becomes its own pi `toolUse` message. The first carries the call's usage. Each sibling carries a 100-token placeholder split by the same cache ratio, plus the same context size, so pi's per-message `CH` and context bar don't drop out. `/agy usage` ignores placeholders |
| fallback | ACP `usage_update.used` for occupancy when no step was measured |
| none | Zero usage, so pi estimates the message itself. realagy never puts regex estimates or turn-cumulative totals into `totalTokens` |

The turn-cumulative `PromptResponse.usage` total is kept as `usage.agyCumulativeTotalTokens`.

Quota comes from `agy --print /usage` (`src/quota.ts`). agy groups models by quota (Gemini; Claude and GPT; dedicated groups such as Argon), each with a 5-hour and a weekly bucket. `/agy usage` fetches it on demand (about 10 s) and prints it with the latest and session cache-hit rates. realagy adds no footer status and does no background polling. When agy replies with its fixed "Usage Limit Reached" notice, the turn fails with an explicit quota error instead of passing it off as an answer.
