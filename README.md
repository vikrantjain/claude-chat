# claude-chat

A Claude Code plugin that lets multiple Claude Code instances chat with each other in real time through a shared WebSocket broker — built on the experimental [Channels API](https://code.claude.com/docs/en/channels).

This is the installable plugin version of the [claude-code-chat](https://github.com/vikrantjain/claude-code-chat) proof of concept, explained in [Distributed Claude Code Agents: Collaboration Across Machines](https://vikrantjain.hashnode.dev/distributed-claude-code-agents-across-machines).

> **Note on the similar name:** [`claude-code-chat`](https://github.com/vikrantjain/claude-code-chat) is the original proof-of-concept that accompanies the article. **This** repo (`claude-chat`) is the maintained, reusable plugin — use this one.

> **Note:** Channels are in research preview. Sessions must be started with `--dangerously-load-development-channels server:claude-chat` to use this channel. The API may change.

## What's in this repo

```
claude-chat/
├── .claude-plugin/plugin.json   # plugin manifest
├── .mcp.json                    # registers the MCP client (runs client.ts)
├── client.ts                    # MCP channel server — bridges Claude Code <-> broker
├── package.json                 # client.ts dependencies (auto-installed by bun on first run)
└── broker/                      # the shared broker — published separately as the `claude-chat-broker` npm package
    ├── broker.ts                # standalone WebSocket message router
    ├── package.json             # publishes the `claude-chat-broker` bin (run via bunx)
    └── Dockerfile
```

The **plugin** (repo root) is client-side and installs per machine. The **broker** (`broker/`) is shared infrastructure — *one* instance that every participant connects to, so only the host runs it; everyone else just points `CLAUDE_CHAT_BROKER` at it. Claude Code's plugin loader ignores the `broker/` directory; it's shipped here as source but published independently to npm as [`claude-chat-broker`](https://www.npmjs.com/package/claude-chat-broker).

## Setup

### 1. Run the broker (once, somewhere reachable)

Only **one** person — the host — runs the broker. With [Bun](https://bun.sh) installed, no checkout is needed:

```bash
bunx claude-chat-broker
```

The broker listens on `ws://0.0.0.0:4000` (override with `PORT`, e.g. `PORT=4000 bunx claude-chat-broker`).

<details>
<summary>Alternatives (Docker, or from source)</summary>

Run it as a container:

```bash
docker build -t claude-chat-broker ./broker
docker run --rm -p 4000:4000 claude-chat-broker
```

Or from a checkout of this repo:

```bash
bun run broker/broker.ts
```

</details>

### 2. Install the plugin

This repo is a standalone plugin (no marketplace of its own). Add it to a marketplace you control by listing it as a `github` source in that marketplace's `.claude-plugin/marketplace.json`:

```json
{
  "name": "claude-chat",
  "source": { "source": "github", "repo": "vikrantjain/claude-chat" },
  "description": "Real-time chat between distributed Claude Code instances via a shared WebSocket broker.",
  "version": "0.1.0"
}
```

Then refresh and install:

```
/plugin marketplace update <your-marketplace>
/plugin install claude-chat
```

> The `github` source also accepts an optional `ref` (branch/tag) or `sha` (exact commit) to pin a version.

### 3. Point each instance at the broker

The plugin reads two environment variables (both optional):

| Env var | Default | Description |
|---------|---------|-------------|
| `CLAUDE_CHAT_BROKER` | `ws://localhost:4000` | Broker WebSocket URL |
| `CLAUDE_CHAT_NAME` | the project directory name (a random suffix is added if it's already taken) | This instance's display name |

Set them before launching Claude Code, e.g.:

```bash
export CLAUDE_CHAT_NAME=alice
export CLAUDE_CHAT_BROKER=ws://192.168.1.50:4000
claude --dangerously-load-development-channels server:claude-chat
```

Start a second instance (e.g. `bob`) the same way, pointed at the same broker.

## MCP Tools

- **`send_message`** — Send a message. Set `to` for a directed message, omit to broadcast.
- **`list_participants`** — List currently connected instances.

## Message flow

1. Claude calls `send_message` with text (and optional recipient).
2. `client.ts` sends it over WebSocket to the broker.
3. The broker routes it to the target (or broadcasts).
4. The receiving client emits an MCP channel notification.
5. Claude sees it as `<channel source="claude-chat" from="...">`.

Join/leave events are broadcast automatically as instances connect and disconnect.

## Reliability

- **Automatic reconnection** — if the broker restarts or the network blips, each client reconnects with exponential backoff (1s up to 30s) and re-registers. The broker may also be started *after* the clients; they'll connect as soon as it's reachable. While disconnected, `send_message` and `list_participants` return an error instead of hanging.
- **Reconnect takeover** — each client carries a stable per-process id, so a client reconnecting reclaims its own name without tripping the duplicate-name guard. A genuinely different instance claiming a name that's already in use is still rejected (`name already taken`).
- **Dead-connection cleanup** — the broker pings clients periodically and reaps connections that stop responding, so stale names don't linger in the participant list.
- **Case-insensitive names** — `Alice` and `alice` are treated as the same name for registration, routing, and listing, so directed messages reach the recipient regardless of case.

## Limitations

- Messages are ephemeral — no history or catch-up for late joiners.
- No authentication — all connections to the broker are trusted. Run the broker on a trusted network.
