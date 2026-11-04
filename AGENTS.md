Project: **realagy**

Minimal TypeScript / Node.js ESM extension for `pi` (`@earendil-works/pi-coding-agent`) targeting Node.js 22+. Uses Google's official `agy_acp_server.par` over ACP JSON-RPC stdio. The provider id remains `antigravity`; the package, display name, and `/realagy` command use `realagy`.

## STRUCTURE

- `extensions/index.ts`: small composition root. Starts the pi MCP bridge, registers `antigravity/*` models, installs/refreshes ACP, and handles `/realagy auth`.
- `src/provider.ts`: pi assistant event stream and MCP → `toolUse` → `toolResult` round-trips. Native text/thinking blocks, slow-tool polling, fresh ACP session per new user turn.
- `src/models.ts`: ACP `availableModels` parsing, effort grouping, family limits, and offline fallback catalog. Supports Gemini, Claude, and GPT-OSS.
- `src/mcp-server.ts`: loopback-only, shared-secret MCP HTTP transport for pi's currently active tools.
- `src/bridge-catalog.ts`: live active-tool filtering, including pi builtins.
- `src/acp/connection.ts`: ACP process/protocol, `clientInfo` third-party model enablement, `enabledTools: []`, eager `pi-bridge` MCP tools, session model listing.
- `src/acp/driver.ts`: serialized ACP turns, full-slug model/effort selection, timers, abort handling, native thought/text activities.
- `src/acp/events.ts`, `jsonrpc.ts`, `usage-estimate.ts`: ACP frame mapping, NDJSON JSON-RPC, token estimates.
- `src/acp/setup.ts`, `auth.ts`, `browser-capture.ts`: official-server installation and Google sign-in.
- `scripts/smoke-acp.mts`: live catalog and model-turn smoke.

## COMMANDS

| Action | Command |
| --- | --- |
| Install dependencies | `npm install` |
| Typecheck/build | `npm run build` |
| Test | `npm test` |
| Full local validation | `npm run check` |
| pi loader/model smoke | `npm run smoke:pi` |
| Live ACP smoke (spends quota) | `npm run smoke:live -- claude-sonnet-5-5` |

## CODING STANDARDS

- TypeScript strict mode, native ESM, `.js` import specifiers, `noEmit: true`.
- Functional, utility-oriented modules; explicit types; early returns.
- Vitest for unit/integration tests. Use fake ACP servers for protocol tests; live smokes are explicit and spend quota.
- Keep the extension minimal. No config panel, fallback engine, delegation framework, global agy/MCP mutation, or Antigravity-native tools.
- Pi owns tools, permissions, transcript, rendering, and diffs. ACP owns only model generation.

## BEHAVIORAL INVARIANTS

- `enabledTools: []` disables all Antigravity builtins while retaining MCP.
- `eagerMcpServers: ["pi-bridge"]` exposes pi tools directly and avoids agy's lazy `call_mcp_tool` helper loop.
- `clientInfo.name = "zed"` is required by the current ACP server to include Claude/GPT models. Generation still uses official ACP and account quotas.
- Every new user turn uses pi's current transcript. Only an in-flight tool continuation re-enters the active ACP turn.
- Model ids with thinking tiers collapse to base pi models; GPT-OSS exposes only medium.
