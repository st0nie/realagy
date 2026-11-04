# Changelog

## 2.0.0 — realagy minimal rewrite

- Renamed the package and command to `realagy` / `/realagy auth`; provider model ids remain `antigravity/*`.
- Replaced the dual-engine/configurable plugin with one official-ACP provider.
- Added live Claude Opus/Sonnet and GPT-OSS catalog entries alongside Gemini.
- Added accurate family context/output limits and thinking tiers; GPT-OSS exposes medium.
- Disabled all Antigravity native tools. Pi's active builtins and extension tools now run through the eager, loopback-only `pi-bridge` MCP server with genuine pi tool cards and permissions.
- Streams model reasoning as native pi thinking blocks.
- Removed stream-json, AskAntigravity, web tools, approval hooks, global MCP registration, session binding files, runtime config, and the settings UI.
- Removed legacy documentation, tests, and unused dependencies; replaced them with focused minimal-provider tests.
