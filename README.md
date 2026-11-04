# realagy

Minimal Antigravity provider for [pi](https://github.com/earendil-works/pi-coding-agent). Uses Google's official ACP server and exposes the account's Gemini, Claude, and GPT models as ordinary `antigravity/*` pi models.

## What it does

- Discovers the live ACP model catalog, including Claude Opus/Sonnet and GPT-OSS alongside Gemini.
- Streams text and reasoning into pi's native assistant/thinking blocks.
- Disables every Antigravity built-in tool with `enabledTools: []`.
- Exposes pi's active tools through a loopback, token-protected MCP bridge. Pi executes them with its normal cards, permissions, hooks, and diffs.
- Uses pi's transcript as the source of truth for every new user turn.
- Installs the official ACP server automatically when needed.

There is no settings panel, engine switch, stream-json fallback, delegation tool, global MCP registration, or plugin config file.

## Install and sign in

```sh
pi install git:github.com/st0nie/pi-antigravity-bridge
/realagy auth
```

Select a model through pi's normal `/model` picker, for example:

- `antigravity/gemini-4-argon`
- `antigravity/gemini-3-8-flash`
- `antigravity/claude-opus-5-5`
- `antigravity/claude-sonnet-5-5`
- `antigravity/gpt-oss-120b`

The exact catalog depends on the account and the current ACP response. GPT-OSS currently supports medium thinking; Claude 5.5 supports low/medium/high.

## How tools work

ACP is only the model transport. Antigravity's native tools are disabled, while the `pi-bridge` MCP server is marked eager so models see pi tools directly instead of going through agy's lazy `call_mcp_tool` helper.

A tool call follows this path:

1. ACP requests a pi tool over loopback MCP.
2. realagy emits a genuine pi `toolCall` and ends the assistant turn with `toolUse`.
3. Pi executes the tool and applies its normal permission policy.
4. The resulting pi `toolResult` answers the parked MCP request and the ACP turn continues.

Slow tools return a `STILL RUNNING` handle after 20 seconds and complete through `bridge_poll_result`, avoiding upstream MCP timeouts.

## Protocol note

The current ACP server offers third-party models only to recognized client surfaces. realagy declares `clientInfo.name = "zed"` to enable the same Claude/GPT catalog that ACP exposes to Zed. Credentials, account quotas, model requests, and generation still use Google's official ACP server; realagy does not call the private generation endpoint directly or bypass quota checks.

## Development

```sh
npm install
npm run check          # TypeScript + unit/integration tests
npm run smoke:pi      # register the provider through pi's real extension loader
npm run smoke:live -- claude-sonnet-5-5   # live turn; spends account quota
npm run smoke:live -- gpt-oss-120b
npm run smoke:live -- gemini-3-8-flash
```
