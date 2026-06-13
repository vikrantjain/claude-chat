import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { basename } from "node:path";

function randSuffix() {
  return Math.random().toString(36).slice(2, 5);
}
// Default chat name is the current project's directory name, falling back to a
// random "agent-xxx" when it can't be determined. Override with CLAUDE_CHAT_NAME.
function projectName() {
  const dir = basename(process.cwd());
  return dir && dir !== "/" && dir !== "." ? dir : "";
}
const nameOverride = process.env.CLAUDE_CHAT_NAME;
const baseName = nameOverride || projectName() || "agent-" + randSuffix();
let name = baseName;
const brokerUrl = process.env.CLAUDE_CHAT_BROKER || "ws://localhost:4000";
// Stable for this process's lifetime so the broker can tell a reconnect of the
// same client from a genuinely different client claiming the same name.
const instanceId = crypto.randomUUID();

// MCP server
const mcp = new McpServer(
  { name: "claude-chat", version: "1.0.0" },
  {
    capabilities: { experimental: { "claude/channel": {} } },
    instructions:
      'Messages from other Claude Code instances arrive as <channel source="claude-chat" from="name">. ' +
      "To reply or send any message, you MUST use the mcp tool send_message (set 'to' for a specific recipient, omit to broadcast). " +
      "To see who is online, use the mcp tool list_participants. " +
      'Join/leave notifications arrive as <channel source="claude-chat" event="joined|left">.',
  }
);

// WebSocket state — `ws` is (re)assigned by connect() on every (re)connection.
let ws: WebSocket;
let registered = false;
let nameAttempts = 0;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

// Outstanding list_participants requests, keyed by request id, so concurrent
// calls don't clobber each other's resolver.
let nextListId = 0;
const pendingLists = new Map<number, { resolve: (names: string[]) => void; reject: (err: Error) => void }>();

function isOpen() {
  return ws && ws.readyState === WebSocket.OPEN;
}

// Tools
mcp.registerTool("send_message", {
  description: "Send a message to other Claude Code instances. Omit 'to' to broadcast to all.",
  inputSchema: {
    text: z.string().describe("Message text"),
    to: z.string().optional().describe("Recipient name (optional, omit to broadcast)"),
  },
}, async ({ text, to }) => {
  if (!isOpen()) {
    return { content: [{ type: "text", text: "not connected to broker — try again shortly" }], isError: true };
  }
  ws.send(JSON.stringify({ type: "message", text, ...(to && { to }) }));
  return { content: [{ type: "text", text: to ? `sent to ${to}` : "broadcast sent" }] };
});

mcp.registerTool("list_participants", {
  description: "List all currently connected Claude Code instances.",
}, async () => {
  if (!isOpen()) {
    return { content: [{ type: "text", text: "not connected to broker — try again shortly" }], isError: true };
  }
  const id = nextListId++;
  const names = await new Promise<string[]>((resolve, reject) => {
    pendingLists.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: "list", id }));
    setTimeout(() => {
      if (pendingLists.delete(id)) reject(new Error("list_participants timed out"));
    }, 5000);
  });
  return { content: [{ type: "text", text: names.join(", ") || "(no participants)" }] };
});

async function handleMessage(event: MessageEvent) {
  let msg: any;
  try {
    msg = JSON.parse(event.data as string);
  } catch {
    return; // ignore malformed frames
  }

  if (msg.type === "registered") {
    registered = true;
    nameAttempts = 0;
    return;
  }

  if (msg.type === "participants") {
    const pending = pendingLists.get(msg.id);
    if (pending) {
      pendingLists.delete(msg.id);
      pending.resolve(msg.names);
    }
    return;
  }

  if (msg.type === "message") {
    await mcp.server.notification({
      method: "notifications/claude/channel",
      params: {
        content: msg.text,
        meta: { from: msg.from, ...(msg.to && { to: msg.to }) },
      },
    });
    return;
  }

  if (msg.type === "joined" || msg.type === "left") {
    await mcp.server.notification({
      method: "notifications/claude/channel",
      params: {
        content: msg.name,
        meta: { event: msg.type },
      },
    });
    return;
  }

  if (msg.type === "error") {
    // An error before we've registered means registration failed — almost
    // always a name collision.
    if (!registered) {
      // For an auto-derived name, retry with a random suffix rather than giving
      // up. An explicit CLAUDE_CHAT_NAME is treated as intentional, so we fail
      // loudly instead of silently renaming it.
      if (!nameOverride && msg.message === "name already taken" && nameAttempts < 5) {
        nameAttempts++;
        name = `${baseName}-${randSuffix()}`;
        ws.send(JSON.stringify({ type: "register", name, instanceId }));
        return;
      }
      console.error(`registration failed: ${msg.message} (name="${name}") — set a unique CLAUDE_CHAT_NAME`);
      process.exit(1);
    }
    console.error("broker error:", msg.message);
  }
}

function connect() {
  ws = new WebSocket(brokerUrl);

  ws.onopen = () => {
    reconnectDelay = 1000;
    registered = false;
    ws.send(JSON.stringify({ type: "register", name, instanceId }));
  };

  ws.onmessage = handleMessage;

  ws.onerror = () => {
    // The WebSocket fires 'error' then 'close'; reconnection is handled in
    // onclose so we don't schedule it twice.
    console.error("WebSocket error — is the broker running?");
  };

  ws.onclose = () => {
    registered = false;
    // Fail any in-flight list requests so their tool calls don't hang.
    for (const { reject } of pendingLists.values()) reject(new Error("broker connection lost"));
    pendingLists.clear();
    console.error(`broker connection closed — reconnecting in ${reconnectDelay}ms`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  };
}

// Start the MCP transport first so tools are available, then connect to the broker.
const transport = new StdioServerTransport();
await mcp.connect(transport);
connect();
