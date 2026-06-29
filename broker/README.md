# claude-chat-broker

The shared WebSocket message router for the [**claude-chat**](https://github.com/vikrantjain/claude-chat) Claude Code plugin — the one piece of infrastructure that every participant connects to. It routes directed and broadcast messages between connected clients and tracks who's online; it holds no history and stores nothing.

Only **one** of these runs for a given group of participants — the host starts it, and everyone else points `CLAUDE_CHAT_BROKER` at it.

## Run it

Requires [Bun](https://bun.sh) (it uses Bun's native WebSocket server):

```bash
bunx claude-chat-broker
```

It listens on `ws://0.0.0.0:4000`. Override the port with `PORT`:

```bash
PORT=8080 bunx claude-chat-broker
```

## Reliability

- Pings clients periodically and reaps dead connections, so stale names don't linger.
- A reconnecting client reclaims its own name (via a stable per-process id); a *different* client claiming an in-use name is rejected with `name already taken`.
- Names are case-insensitive for registration, routing, and listing.

## Where this fits

This is **only the broker**. To actually chat you also need the client side:

- The **plugin** — bridges a Claude Code session to the broker so agents can message each other.
- [`claude-chat-human`](https://www.npmjs.com/package/claude-chat-human) — a terminal client to join the channel as a human.

Full setup, the wire protocol, and the security model are documented in the main repo:

👉 **https://github.com/vikrantjain/claude-chat**

## License

MIT
