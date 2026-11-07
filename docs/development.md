# Development

TypeScript in strict mode, native ESM with `.js` import specifiers, `noEmit`; Node.js 22+ (pi runs the sources through its loader).

## Build and test

```sh
bun install            # or npm install
npm run check          # tsc --noEmit + vitest
npm run smoke:pi       # load the extension through pi's real loader and list the models
```

Protocol tests run against `tests/helpers/fake-acp-server.mjs` instead of agy. It records every request it receives and supports:

| Variable | Effect |
| --- | --- |
| `FAKE_ACP_DB_DIR` | Writes each prompt to `<dir>/<sessionId>.db` the way agy's conversation store does: its user-input step (14) on arrival, kept when the prompt is cancelled, and one agent step (15) when it completes |
| `FAKE_ACP_RESUME` | Advertises `sessionCapabilities.resume` and answers `session/resume`; without it `session/load` replays a canned history first |
| session id `missing` | `session/load` and `session/resume` fail, which exercises the fresh-session fallback |
| prompt text containing `[hang]` | The prompt never ends on its own; a `session/cancel` notification ends it with `stopReason: "cancelled"` |
| prompt text containing `[silent-cancel]` | Like `[hang]`, but `session/cancel` is ignored, which exercises the teardown safety net |
| `session/set_config_option` mode | Only agy 1.5's advertised modes (`default`, `accept-edits`, `plan`); others fail with `-32602 Unknown mode` |
| `FAKE_ACP_RECORD_ARGV` | Records the server's extra argv (such as `--agent <name>`) as a request with method `argv` |
| `FAKE_ACP_BRAIN_DIR` | Where background work reports completion, as agy does in `brain/<sessionId>/.system_generated/messages/<id>.json` |
| any prompt | Echoed as `user_message_chunk` first, after the leftovers of earlier background work, as agy does; `[no-echo]` skips the echo |
| prompt text containing `[native]` | agy's own `read_file` (completed) and `run_command` (failed) plus one `mcp_pi-bridge_bash` call |
| prompt text containing `[native-slow:<ms>]` | A native `run_command` that runs `<ms>` without any frames; `[overlap]` adds a quick `read_file` inside it |
| prompt text containing `[background]` | A native command still running when the prompt ends; it reports to the brain directory and leaves leftovers for the next prompt |
| prompt text containing `[subagent]` | An `invoke_subagent` call whose subagent replies through the brain directory |
| prompt text containing `[invalid]` | agy's `⚠ Model produced invalid output.` retry notice as a message chunk |
| prompt text containing `[exit]` | The server writes a stderr line and exits with code 3 mid-prompt |

## Live smokes

These need a signed-in `agy` and spend account quota.

```sh
npm run smoke:live -- gemini-3-8-flash
npm run smoke:live -- claude-sonnet-5-5
npm run smoke:live -- gpt-oss-120b
REALAGY_TRACE_USAGE=/tmp/trace.jsonl pi      # turn plans, usage_update, step tokens; counts only
```

`scripts/probe-context-usage.mts` checks that pi's context count matches agy's occupancy.

## Conventions

- Keep the extension minimal: one command (`/realagy settings`, `/realagy setup`, `/realagy usage`), one TUI settings view, no installers, sign-in flows, fallback engine, delegation framework, or global agy/MCP mutation. The exceptions are realagy's config file in `~/.pi/agent/realagy/config.json` (`src/settings.ts`) and hidden agent profile in `~/.gemini/config/agents/realagy-<hash>.md` (`src/agent-profile.ts`): the profile affects only processes started with `--agent`, and stale copies are pruned.
- Under the profile (`agentProfile: true`, default) the model has only pi's tools; without it (`agentProfile: false` in `/realagy settings`) agy decides which tools to use, its own or pi's. Compaction bypass (`noAutoCompaction: true`, default) rewrites Agy's catalog over loopback so Pi owns compaction across each model's full context window. Pi owns the transcript and rendering.
- Small functional modules, explicit types, early returns.
- `agy acp` ignores `enabledTools`/`disabledTools`, so realagy sends neither. `eagerMcpServers: ["pi-bridge"]` avoids agy's lazy `call_mcp_tool` loop under the default agent; a custom agent ignores it, so the profile lists every bridged tool as `eager`.
- agy refuses native reads inside its own data dir (`~/.gemini`), so never hand the model files there.
- Never write estimates or turn-cumulative totals into `usage.totalTokens`. See [architecture.md](architecture.md#usage-context-and-quota).
- Background work in `extensions/index.ts` checks the shutdown flag after every `await` before touching `ctx` or `pi`. Pi replaces the extension runtime on `/new`, `/resume`, `/fork`, and `/reload`.

## Pitfalls

- agy's ACP `_meta.antigravity.systemPrompt` supports only `append`; replacing the prompt needs a custom agent (`--agent`, per process). agy loads only Markdown agents, `mcpServers` only in list form (`- name: pi-bridge`), tool `eager` flags only per name (no wildcard), and `tools:` only accepts agy's registry tool names (an MCP name makes every turn fail). Inspect the real system prompt in the `gen_metadata` blob of `<sessionId>.db`.

- An aborted `npm install` leaves a corrupt `node_modules`, and `tsc`/`vitest` then die with "Bus error". Delete `node_modules` and run `bun install`.
- `node:sqlite` prints an ExperimentalWarning on Node 22. `src/acp/step-usage.ts` silences it for that one `require`, because it would corrupt pi's TUI.
- The conversation store is agy's internal format. Every read degrades to "no measurement" rather than failing a turn. The stores are in WAL mode: never copy a `.db` file by itself (use `VACUUM INTO`).
- ACP `session/cancel` is a notification. Sent as a request, agy cancels the prompt but never answers the request.
- `session/load` of an unknown session id succeeds with an empty session. Check that `<sessionId>.db` exists before trusting a load.
- `agy --print /usage` takes about 10 s. Run it only from `/realagy usage`, never on a turn's path or in the background.
