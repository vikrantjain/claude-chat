#!/usr/bin/env bun
import type { ServerWebSocket } from "bun";

const port = Number(process.env.PORT || 4000);

type Client = { name: string; instanceId: string };
const clients = new Map<ServerWebSocket, Client>();

function broadcast(msg: object, exclude?: ServerWebSocket) {
  const data = JSON.stringify(msg);
  for (const [sock] of clients) {
    if (sock !== exclude) sock.send(data);
  }
}

Bun.serve({
  port: port,
  hostname: "0.0.0.0",
  fetch(req, server) {
    if (server.upgrade(req)) return undefined;
    return new Response("expected a websocket upgrade", { status: 426 });
  },
  websocket: {
    // Seconds with no incoming data/pong before Bun reaps the socket. Combined
    // with the periodic ping below, this evicts dead connections so their names
    // don't linger in the participant list.
    idleTimeout: 120,
    message(ws, raw) {
      let msg: any;
      try {
        msg = JSON.parse(raw as string);
      } catch {
        return; // ignore malformed frames instead of crashing the handler
      }

      if (msg.type === "register") {
        const name = msg.name || "agent-" + Math.random().toString(36).slice(2, 5);
        const instanceId = typeof msg.instanceId === "string" ? msg.instanceId : "";

        // Name matching is case-insensitive everywhere (registration, routing,
        // and the participant list), so "Alice" and "alice" are the same name.
        let reconnect = false;
        for (const [sock, entry] of clients) {
          if (sock === ws) continue;
          if (entry.name.toLowerCase() !== name.toLowerCase()) continue;
          if (instanceId && entry.instanceId === instanceId) {
            // Same client process reconnecting — evict its stale socket and let
            // the new one take over the name. Delete before close() so the
            // close handler doesn't broadcast a spurious "left".
            clients.delete(sock);
            try { sock.close(); } catch {}
            reconnect = true;
          } else {
            ws.send(JSON.stringify({ type: "error", message: "name already taken" }));
            return;
          }
        }

        clients.set(ws, { name, instanceId });
        console.log(`${reconnect ? "~" : "+"} ${name} ${reconnect ? "reconnected" : "connected"} (${clients.size} online)`);
        ws.send(JSON.stringify({ type: "registered", name }));
        if (!reconnect) broadcast({ type: "joined", name }, ws);
        return;
      }

      const self = clients.get(ws);
      if (!self) return;
      const from = self.name;

      if (msg.type === "list") {
        ws.send(JSON.stringify({
          type: "participants",
          names: [...clients.values()].map((c) => c.name),
          ...(msg.id != null && { id: msg.id }),
        }));
        return;
      }

      if (msg.type === "message") {
        const target = msg.to?.toLowerCase();
        if (target) {
          for (const [sock, entry] of clients) {
            if (entry.name.toLowerCase() === target) {
              // Echo the recipient's real (display-case) name back as `to`.
              sock.send(JSON.stringify({ type: "message", from, text: msg.text, to: entry.name }));
              return;
            }
          }
          ws.send(JSON.stringify({ type: "error", message: `unknown recipient: ${msg.to}` }));
        } else {
          broadcast({ type: "message", from, text: msg.text }, ws);
        }
      }
    },
    close(ws) {
      const self = clients.get(ws);
      if (self) {
        clients.delete(ws);
        console.log(`- ${self.name} disconnected (${clients.size} online)`);
        broadcast({ type: "left", name: self.name });
      }
    },
  },
});

// Ping every client periodically. Alive clients auto-respond with a pong, which
// resets Bun's idleTimeout; genuinely dead connections stay silent and get reaped.
setInterval(() => {
  for (const [sock] of clients) {
    try { sock.ping(); } catch {}
  }
}, 30000);

console.log(`broker listening on ws://0.0.0.0:${port}`);

process.on("SIGINT", () => {
  console.log("\nbroker shutting down");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("\nbroker shutting down");
  process.exit(0);
});
