# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Runtime

Both `client.ts` and `broker/broker.ts` require **Bun** — they use Bun's native WebSocket APIs and are not Node-compatible. The broker is run directly as TypeScript; the client ships as a prebuilt bundle (below).

## Client bundle (rebuild before every release)

`.mcp.json` runs **`client.bundle.js`**, not `client.ts` — a self-contained bundle of `client.ts` plus its deps (`@modelcontextprotocol/sdk`, `zod`). This is deliberate: Claude Code installs a plugin by copying its files into the plugin cache **without running `bun install`**, so a freshly installed plugin has no `node_modules`. Relying on Bun's runtime auto-install meant the MCP server fetched deps from npm on first launch — slow enough to risk Claude Code's 30s MCP startup timeout, and a hard failure offline. The committed bundle removes that: startup is instant with zero runtime dependency resolution.

Rebuild after any change to `client.ts` (or a dependency bump) and commit the result:

```bash
bun run build      # = bun build client.ts --target=bun --outfile=client.bundle.js
```

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
