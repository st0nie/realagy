# Architecture

`agy acp` runs the agent: it generates text and reasoning and decides which tools to use. Pi owns the transcript and rendering, and its active tools are offered alongside agy's own.

## Process and models

The extension starts one long-lived `agy acp` process per pi session (`src/acp/driver.ts`). It shares the Antigravity CLI's sign-in, settings, and data dir (`~/.gemini/antigravity-cli`). On startup realagy:

1. finds `agy` (`AGY_BIN` > `PATH` > `~/.local/bin/agy`). If none is found, it points to `/agy setup` and stops there;
2. sets `queuedMessages` to `send-immediately` in agy's `settings.json` when it is unset, so pi steering interrupts the agent the way pi expects;
3. reads the live model catalog from `session/new` and registers it as `antigravity/*`. Effort tiers (`-low`, `-medium`, `-high`) collapse into one pi model with thinking levels (`src/models.ts`).

The provider is registered with ambient-only auth: there is no `login` method, pi never stores a key, and the provider counts as configured whenever agy is present. agy offers Claude/GPT only to clients it recognizes, so `initialize` sends `clientInfo.name = "zed"`.

Starting the process is single-flight: concurrent callers (startup catalog discovery, `/agy setup`, and the first turn) share one spawn and one `initialize` handshake, so no request ever reaches agy before the handshake completes. If agy cannot be spawned, or exits mid-turn, the turn fails with the binary path, exit code or signal, and agy's last stderr line (secrets redacted), and the next turn respawns it. agy exits on its own when its stdin closes, so it never outlives pi.

## Turns, aborts, and timeouts

Turns are serialized on the one process. Esc sends ACP `session/cancel` as a notification: agy ends the prompt with `stopReason: "cancelled"` and both the process and the session stay alive. The process is torn down only when agy has not settled the cancelled prompt within 10 seconds. An abort that arrives before the prompt was sent settles the turn at once; the remaining setup steps stop without sending it. Teardown, the 5-minute inactivity guard, and the cancel safety net only ever act on the process of the turn they belong to, never on a later turn's.

A turn parked on pi tool calls waits for pi's tool results. If pi starts a new turn instead of returning them (its agent loop ended after the `toolUse` message), realagy cancels the orphaned turn and fails its parked calls rather than queueing the new turn behind it.

## Tools

Pi's active tools are served by a loopback MCP server (`src/mcp-server.ts`) that requires a shared-secret header. The server is registered with every ACP session as the eager `pi-bridge`, so models see pi tools directly instead of going through agy's lazy `call_mcp_tool` helper. Request bodies are decoded only once complete, so multi-byte characters split across network chunks arrive intact, and each tool's input schema is normalized once per tool definition rather than on every MCP request.

agy keeps its native tools (`read_file`, `run_command`, `write_file`, `edit_file`, `search_web`, `invoke_subagent`, …): `agy acp` 1.5 ignores tool allowlists (`enabledTools` / `disabledTools`). Instead, every `session/new`, `session/resume`, and `session/load` appends a tool policy to agy's system prompt (`_meta.antigravity.systemPrompt.append`, advertised by agy as `systemPrompt.append`; `src/tool-policy.ts`). It names the active pi tools and asks the model to use them for all file and shell work (reading files including images, every shell command, changing files), not to use agy's built-in `run_command`, `read_file`, `write_file`, or `edit_file` for anything a pi tool can do, and to work itself in the foreground instead of starting subagents, the browser agent, background tasks, or scheduled tasks (`invoke_subagent`, `define_subagent`, `manage_subagents`, `schedule`, `manage_task`); a native tool is for jobs no pi tool can do (such as `search_web`). Naming agy's tools matters: with only "prefer pi's tools", GPT-OSS kept mixing in native calls, while Gemini and Claude follow either wording. The policy never appears in the user's prompts. A change of the active tool set already starts a fresh session (see below), so the policy always matches the tools the session offers. Native tools stay usable: they run inside agy under its own permission rules (`~/.gemini/antigravity-cli/settings.json`), and realagy approves agy's permission requests. Each turn sets the ACP session mode to `accept-edits` (pi's `plan` maps to agy's `plan`); agy 1.5 offers only `default`, `accept-edits`, and `plan`.

Native tool use is always visible in pi (`src/native-tools.ts`):

- Each native call agy finishes during a turn adds a line to the reply's thinking block, such as `agy → run_command npm test ✓ 2.1s` or `agy → read_file src/provider.ts ✗`. The duration is left out under 0.1 s: agy reports reads only after they finished, so their start and end arrive together. Calls of agy's own MCP servers count as native; `pi-bridge` calls are pi tool calls and render as pi tool cards instead. Thinking is excluded from warm-session fingerprints and from the transcript sent to agy, so these lines never affect session reuse; reply text they split is joined back into one reply when a fresh session replays the transcript.
- While a native call runs, pi's status line shows `agy: <tool> <target> … <elapsed>`, and the 5-minute inactivity guard pauses, because a long native command produces no ACP frames.
- A call still running when the prompt ends (agy backgrounds commands after `WaitMsBeforeAsync`) gets the line `agy → <tool> <target> … (runs in background)`; `invoke_subagent` returns at once and gets `✓ … (runs in background)`.

agy finishes background work on its own: it writes a message to `brain/<sessionId>/.system_generated/messages/<id>.json` and runs an autonomous agent turn. ACP sends nothing while no prompt is in flight, so realagy polls that directory (every 2 seconds, only while the session has unfinished background work, for at most 12 hours) and shows a pi notice per message with its title, the command's exit code, and the end of its output (`src/acp/background.ts`). No model call is made. agy flushes the frames it buffered meanwhile (the task's completion and its autonomous reply) at the start of the next `session/prompt`, before echoing the new prompt as `user_message_chunk`. realagy holds every frame that arrives before that echo and drops them once the echo arrives, so the leftovers never leak into the new reply. If a prompt ends without an echo, the held frames are processed normally, so nothing is lost on servers that do not echo. agy's own "⚠ Model produced invalid output." notice (sent as reply text when a model, typically GPT-OSS, emits a malformed tool call that agy then retries) is shown as thinking, so it never becomes part of the stored answer.

A pi tool call follows this path:

1. agy calls a pi tool over MCP. The request is parked.
2. realagy emits a genuine pi `toolCall` and ends the assistant message with `toolUse`.
3. Pi runs the tool under its normal permission policy and hooks.
4. Pi's `toolResult` answers the parked MCP request — appending any user steering messages and images queued while the tool ran as a `<pi-steering>` block — and the same ACP turn continues.

After 20 seconds, a slow tool returns a `STILL RUNNING` handle that the model resolves through `bridge_poll_result`. This avoids upstream MCP timeouts.

## Images

Pi image results go back as ordinary MCP image blocks. agy stores them under its conversation (`brain/<session>/.system_generated/steps/<n>/media_*.png`) and shows them to the model, so the same ACP session continues and no history is replayed. This works with pi's `read` tool on Gemini and Claude. Images in pi's transcript are sent as ACP image blocks when a fresh session starts. GPT-OSS models are text-only (they cannot see images even through agy's native `read_file`), so they are registered without image input.

## Session reuse and prompt caching

Every new user turn is planned from pi's current transcript (`src/transcript.ts`).

- **Warm:** a previous turn on the branch completed cleanly, and the messages that session holds still match (along with the cwd and active tool set). realagy reuses the ACP session and sends only the messages pi added since. Plain user messages go as ordinary prompt text. Anything else (other models' replies, tool results, updated pi system instructions) goes as a `pi://transcript-delta` resource. agy's native history stays an unchanged prompt prefix the provider can cache.
- **Fresh:** after manual `/compact`, a tool or cwd change, or a failed or aborted turn with no matching checkpoint, realagy starts a new session and sends the transcript as `pi://transcript`.

Each completed turn persists a `realagy-warm-session` checkpoint (`sessionId`, `maxStepIdx` in `~/.gemini/antigravity-cli/conversations/<sessionId>.db`, message keys, system prompt, and tools) in the pi session tree. Across `/reload`, `pi -c` / `/resume`, and `/tree` branch switches, realagy restores the checkpoints from the session file and resumes the matching ACP session directly. When `/tree` rewinds to an earlier turn whose `<sessionId>.db` has already advanced past that turn's `maxStepIdx`, realagy forks `<sessionId>.db` into a new `<forkedSessionId>.db` truncated to `idx <= maxStepIdx` (`src/acp/step-usage.ts`) so the resumed session continues from that exact point in history while leaving the other branch's store intact. The stores run in SQLite WAL mode, so the fork is taken with `VACUUM INTO`, a consistent snapshot that includes steps still in the `-wal` file; copying the `.db` file alone would drop them.

Planning compares the transcript against every restored checkpoint. Per-message keys and the fingerprint of every transcript prefix are computed once per turn, and the full `pi://transcript` (also the fallback of a warm plan) is serialized once, so planning stays linear in transcript size however many checkpoints the session has.

`agy acp` truncates a single `session/prompt` payload past 192 KB from the end, which would cut off recent turns and the user's latest prompt on a fresh session. `pi://transcript` and `pi://transcript-delta` therefore cap their serialized body at 160 KB: `<pi-system>`, any leading `<realctx-history>` summaries, and the newest messages are kept intact, while older middle messages collapse into a `<pi-transcript-omitted>` marker.

A remembered session that is not live in the current process is resumed with `session/resume` when agy advertises it (`sessionCapabilities.resume`), which restores the history without replaying it; otherwise `session/load` is used and its replayed history is dropped. `session/load` of an unknown id silently returns an empty session, so a remembered session whose `<sessionId>.db` no longer exists counts as lost before agy is asked. A lost session, or a failed resume or load, makes the driver open a new session and send the full transcript, not the delta. Warm-session matching is designed to coexist with arbitrary pi `context` extensions without per-extension special cases: fingerprints exclude model-private thinking, key `toolResult` messages by structural identity (`toolName`, `toolCallId`, `isError`) rather than mutable body text, key `user` messages by their primary prompt text (tolerating appended `{ type: "text" }` context blocks, dropped historical images, and line-bounded prompt headers/trailers added only while a prompt is active), skip unpersisted transient `user` messages injected alongside a turn's prompt once that turn moves into history, and match the intact suffix of recent turns when a context manager compresses or drops older turns into fewer leading summary messages ($0 \le \text{lead} < \text{drop}$). A continuation after a pi tool result always re-enters the running ACP turn and records its warm checkpoint from the turn's final transcript state.

## Usage, context, and quota

`agy acp` reports usage only once per prompt, summed over all of its internal model calls. Exact per-call counts live in agy's conversation store, `~/.gemini/antigravity-cli/conversations/<sessionId>.db`. Agent steps (`step_type` 15) carry metadata field 9: 2 = uncached input, 3 = output, 5 = cache read. `src/acp/step-usage.ts` reads the steps that are new since the last report, both when a tool call ends a pi message and when the prompt ends.

| pi `Usage` field | Source |
| --- | --- |
| `input`, `cacheRead`, `output` | Sum over the model calls the pi message covers, so pi's footer shows real `↑ R ↓` and `CH` |
| `totalTokens` | Context held by the latest model call. Pi's footer, `ctx.getContextUsage()`, and compaction use it as current occupancy |
| parallel tool calls | One model call can request several tools, and each becomes its own pi `toolUse` message. The first carries the call's usage. Each sibling carries a 100-token placeholder split by the same cache ratio, plus the same context size, so pi's per-message `CH` and context bar don't drop out. `/agy usage` ignores placeholders |
| fallback | ACP `usage_update.used` for occupancy when no step was measured |
| none | Zero usage, so pi estimates the message itself. realagy never puts regex estimates or turn-cumulative totals into `totalTokens` |

The turn-cumulative `PromptResponse.usage` (`inputTokens`, `outputTokens`, `thoughtTokens`, `cachedReadTokens`, `cachedWriteTokens`, `totalTokens`) fills `input`, `output`, `cacheRead`, and `cacheWrite` only for a message that no step measured but that has an occupancy, and its total is kept as `usage.agyCumulativeTotalTokens`. realagy computes no client-side token estimates.

Quota comes from `agy --print /usage` (`src/quota.ts`). agy groups models by quota (Gemini; Claude and GPT; dedicated groups such as Argon), each with a 5-hour and a weekly bucket. `/agy usage` fetches it on demand (~5–10 s): it immediately prints the session cache-hit rate with a loading notice, shows a cancellable `BorderedLoader` in TUI mode, resolves as soon as agy flushes its JSON line to `stdout` (without waiting for its internal language server to finish shutting down), and updates the status message in place with the quota groups. Quota is never polled in the background. When agy replies with its fixed "Usage Limit Reached" notice, the turn fails with an explicit quota error instead of passing it off as an answer. Likewise, when agy's whole reply is its "⚠ Our servers are experiencing high traffic right now…" notice, the turn fails with `Antigravity servers are overloaded: …`, which pi treats as a retryable provider error and retries automatically.
