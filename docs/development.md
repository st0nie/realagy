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
| `FAKE_ACP_DB_DIR` | Writes one agent step per prompt to `<dir>/<sessionId>.db`, the way agy's conversation store does |
| session id `missing` | `session/load` fails, which exercises the fresh-session fallback |

## Live smokes

These need a signed-in `agy` and spend account quota.

```sh
npm run smoke:live -- gemini-3-8-flash
npm run smoke:live -- claude-sonnet-5-5
npm run smoke:live -- gpt-oss-120b
REALAGY_TRACE_USAGE=/tmp/trace.jsonl pi      # turn plans, usage_update, step tokens; counts only
```

`scripts/probe-*.mts` cover context usage and image delivery.

## Conventions

- Keep the extension minimal: one command (`/agy setup`, `/agy usage`), no installers, sign-in flows, config panel, fallback engine, delegation framework, or global agy/MCP mutation.
- agy decides which tools to use, its own or pi's. Pi owns the transcript and rendering.
- Small functional modules, explicit types, early returns.
- `agy acp` ignores `enabledTools`/`disabledTools`, so realagy sends neither. `eagerMcpServers: ["pi-bridge"]` avoids agy's lazy `call_mcp_tool` loop.
- agy refuses native reads inside its own data dir (`~/.gemini`), so never hand the model files there.
- Never write estimates or turn-cumulative totals into `usage.totalTokens`. See [architecture.md](architecture.md#usage-context-and-quota).
- Background work in `extensions/index.ts` checks the shutdown flag after every `await` before touching `ctx` or `pi`. Pi replaces the extension runtime on `/new`, `/resume`, `/fork`, and `/reload`.

## Pitfalls

- An aborted `npm install` leaves a corrupt `node_modules`, and `tsc`/`vitest` then die with "Bus error". Delete `node_modules` and run `bun install`.
- `node:sqlite` prints an ExperimentalWarning on Node 22. `src/acp/step-usage.ts` silences it for that one `require`, because it would corrupt pi's TUI.
- The conversation store is agy's internal format. Every read degrades to "no measurement" rather than failing a turn.
- `agy --print /usage` takes about 10 s. Run it only from `/agy usage`, never on a turn's path or in the background.
