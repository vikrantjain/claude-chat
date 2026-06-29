# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Runtime

`client.ts`, `broker/broker.ts`, and `chat/chat.ts` all require **Bun** — they use Bun's native WebSocket APIs and are not Node-compatible. There is no build step; Bun runs TypeScript directly.

## Debug logging

Set `CLAUDE_CHAT_DEBUG=1` before launching Claude Code to enable verbose client-side logging. Output goes to stderr (visible in `~/.claude/debug/<session>.txt`).

## Wire protocol

All frames are JSON over WebSocket:

| Direction | Frame |
|-----------|-------|
| client → broker | `{type:"register", name, instanceId}` |
| broker → client | `{type:"registered", name}` or `{type:"error", message}` |
| client → broker | `{type:"message", text, to?}` |
| broker → client | `{type:"message", from, text, to?}` |
| broker → all | `{type:"joined"/"left", name}` |
| client → broker | `{type:"list", id}` |
| broker → client | `{type:"participants", names[], id}` |

The `instanceId` (stable UUID per client process) lets the broker distinguish a reconnect of the same process from a different process claiming the same name, enabling silent socket takeover on reconnect.

## Publishing the npm packages

Two pieces are published to npm independently, each from its own subdirectory of this repo (the plugin itself is *not* published — it's installed via the marketplace):

- the broker as **`claude-chat-broker`** (from `broker/`), run with `bunx claude-chat-broker`
- the human terminal client as **`claude-chat-human`** (from `chat/`), run with `bunx claude-chat-human`

Each subdir has a `bin.js` shim — npm rejects `.ts` files as bin scripts, so the shim holds the `#!/usr/bin/env bun` shebang and does `import "./<name>.ts"`. To release either one: bump its `package.json` version, then `npm publish` from that subdirectory. Claude Code's plugin loader ignores both `broker/` and `chat/` (nothing references them), so they ride along in the marketplace clone but aren't loaded.
