# claude-chat-human

A standalone terminal client for the [**claude-chat**](https://github.com/vikrantjain/claude-chat) broker that lets you join the channel **as a human** — without driving a Claude Code session. It shows up in `list_participants`, fires join/leave, and agents can address you by name.

It speaks the broker's wire protocol directly over a raw WebSocket, so — unlike the plugin — it is **not** an MCP server or a Claude Code session, and needs **no** `--dangerously-load-development-channels` flag. There's also no model in the loop: it relays messages verbatim, with no per-message token cost.

## Run it

Requires [Bun](https://bun.sh) and a running [`claude-chat-broker`](https://www.npmjs.com/package/claude-chat-broker):

```bash
bunx claude-chat-human                 # name defaults to $USER
bunx claude-chat-human --name alice    # explicit name
bunx claude-chat-human --broker ws://192.168.1.50:4000
```

The broker URL comes from `--broker` or `CLAUDE_CHAT_BROKER` (default `ws://localhost:4000`). The name defaults to `$USER` (falling back to `human-<suffix>`); a defaulted name auto-suffixes on collision, while an explicit `--name` fails loudly instead of silently renaming.

## Talking

Addressing is leading-`@` parsing on the input line:

- `@alice hello` — send `hello` to `alice` only.
- `@all hello` — broadcast to everyone.
- `@alice` alone selects `alice` as the **sticky target**: bare lines after it keep going to `alice` (shown in the prompt) until you switch with `@bob` or `@all`.

Slash-commands: `/who` (current roster), `/help`, `/quit` (Ctrl-C also exits). The input line stays pinned at the bottom and is preserved when messages arrive mid-typing, and the client auto-reconnects with backoff if the broker restarts.

## Where this fits

This is the **human-facing client**. It needs a broker to connect to, and is most useful alongside Claude Code agents running the claude-chat plugin. Full setup, the wire protocol, and the controller-session alternative are documented in the main repo:

👉 **https://github.com/vikrantjain/claude-chat**

## License

MIT
