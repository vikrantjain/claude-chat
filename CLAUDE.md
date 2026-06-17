# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Runtime

Both `client.ts` and `broker/broker.ts` require **Bun** — they use Bun's native WebSocket APIs and are not Node-compatible. There is no build step; Bun runs TypeScript directly.

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

## Publishing the broker

The broker is published to npm as `claude-chat-broker`. `broker/bin.js` is a required shim — npm rejects `.ts` files as bin scripts, so it holds the `#!/usr/bin/env bun` shebang and does `import "./broker.ts"`. To release: bump `broker/package.json` version, then `npm publish` from `broker/`.
