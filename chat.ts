// Standalone human-facing terminal chat client for the claude-chat broker.
//
// NOT an MCP server and NOT a Claude Code session — it speaks the broker's wire
// protocol directly over a raw WebSocket, so it needs no
// `--dangerously-load-development-channels` flag. Run it with:
//
//   bun run chat.ts [--name <name>] [--broker <ws-url>]
//
// Reuses the connection patterns from client.ts (stable instanceId, broker URL
// from CLAUDE_CHAT_BROKER, derived-name collision self-heal).
import * as readline from "node:readline";

function randSuffix() {
  return Math.random().toString(36).slice(2, 5);
}

// --- CLI args ---
const argv = process.argv.slice(2);
function getFlag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
const nameFlag = getFlag("--name");
const brokerFlag = getFlag("--broker");

// An explicit --name is treated as intentional (fail loudly on collision); a
// derived/defaulted name self-heals with a random suffix, mirroring client.ts.
const nameExplicit = !!nameFlag;
const baseName = nameFlag || process.env.USER || "human-" + randSuffix();
let name = baseName;
const brokerUrl = brokerFlag || process.env.CLAUDE_CHAT_BROKER || "ws://localhost:4000";
// Stable for this process's lifetime so the broker treats a reconnect as a
// silent takeover instead of "name already taken".
const instanceId = crypto.randomUUID();

const debug = !!process.env.CLAUDE_CHAT_DEBUG;
function log(...args: unknown[]) {
  if (debug) console.error("[chat]", ...args);
}

// --- terminal UI ---
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

// Local roster of *other* participants: lower-case key -> display name.
const roster = new Map<string, string>();
function rosterNames(): string[] {
  return [...roster.values()];
}

function completer(line: string): [string[], string] {
  // Stub for Feature 1 — Feature 3 wires this to the roster. Returning no
  // candidates keeps normal typing unaffected.
  return [[], line];
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  completer,
  prompt: "❯ ",
});

// Print a line *above* the pinned input, then redraw the in-progress input
// buffer + cursor intact so async arrivals never mangle what's being typed.
function printAbove(text: string) {
  readline.cursorTo(process.stdout, 0);
  readline.clearLine(process.stdout, 0);
  process.stdout.write(text + "\n");
  rl.prompt(true);
}

// --- WebSocket lifecycle ---
let ws: WebSocket;
let registered = false;
let nameAttempts = 0;

function isOpen() {
  return ws && ws.readyState === WebSocket.OPEN;
}
function send(obj: unknown) {
  if (isOpen()) ws.send(JSON.stringify(obj));
}

function handleMessage(event: MessageEvent) {
  let msg: any;
  try {
    msg = JSON.parse(event.data as string);
  } catch {
    return; // ignore malformed frames
  }

  switch (msg.type) {
    case "registered":
      registered = true;
      nameAttempts = 0;
      name = msg.name || name;
      printAbove(dim(`* connected to ${brokerUrl} as "${name}"  (/help for commands)`));
      send({ type: "list", id: 0 }); // seed the roster
      break;

    case "participants":
      roster.clear();
      for (const n of msg.names || []) {
        if (typeof n === "string" && n.toLowerCase() !== name.toLowerCase()) {
          roster.set(n.toLowerCase(), n);
        }
      }
      break;

    case "message": {
      const direct = typeof msg.to === "string" && msg.to.toLowerCase() === name.toLowerCase();
      if (direct) printAbove(`${cyan(`${msg.from} → you ❯`)} ${msg.text}`);
      else printAbove(`${msg.from} ❯ ${msg.text}`);
      break;
    }

    case "joined":
      if (msg.name && msg.name.toLowerCase() !== name.toLowerCase()) {
        roster.set(msg.name.toLowerCase(), msg.name);
      }
      printAbove(dim(`* ${msg.name} joined`));
      break;

    case "left":
      if (msg.name) roster.delete(msg.name.toLowerCase());
      printAbove(dim(`* ${msg.name} left`));
      break;

    case "error":
      // A pre-registration error means registration failed (almost always a
      // name collision); the `registered` flag is the discriminator. A
      // post-registration error (e.g. unknown recipient) is non-fatal.
      if (!registered) {
        if (!nameExplicit && msg.message === "name already taken" && nameAttempts < 5) {
          nameAttempts++;
          name = `${baseName}-${randSuffix()}`;
          send({ type: "register", name, instanceId });
          return;
        }
        console.error(`registration failed: ${msg.message} (name="${name}") — pass a unique --name`);
        process.exit(1);
      }
      printAbove(dim(`! ${msg.message}`));
      break;
  }
}

function connect() {
  ws = new WebSocket(brokerUrl);
  ws.onopen = () => {
    registered = false;
    ws.send(JSON.stringify({ type: "register", name, instanceId }));
  };
  ws.onmessage = handleMessage;
  ws.onerror = () => printAbove(dim("! websocket error — is the broker running?"));
  ws.onclose = () => {
    registered = false;
    printAbove(dim("! broker connection closed"));
  };
}

// --- input handling ---
function handleCommand(line: string) {
  const cmd = line.slice(1).trim().split(/\s+/)[0];
  switch (cmd) {
    case "help":
      printAbove(dim("commands:  /help  /who  /quit   (Ctrl-C also exits)"));
      break;
    case "who":
      // Stubbed for Feature 1 — real roster output arrives with Feature 3.
      printAbove(dim("/who — roster not available yet"));
      break;
    case "quit":
      shutdown();
      break;
    default:
      printAbove(dim(`! unknown command: /${cmd}`));
  }
}

rl.on("line", (input) => {
  // Erase readline's own echo of the just-submitted line so we can re-render it
  // (formatted) via printAbove instead of showing it twice.
  readline.moveCursor(process.stdout, 0, -1);
  readline.clearLine(process.stdout, 0);

  if (input.startsWith("/")) {
    handleCommand(input);
    rl.prompt();
    return;
  }
  if (input.trim() === "") {
    rl.prompt();
    return;
  }
  if (!isOpen()) {
    printAbove(dim("! not connected — message not sent"));
    rl.prompt();
    return;
  }
  send({ type: "message", text: input });
  printAbove(`${dim("me → all ❯")} ${input}`);
  rl.prompt();
});

function shutdown() {
  try {
    ws?.close();
  } catch {}
  process.exit(0);
}
rl.on("SIGINT", shutdown);
rl.on("close", shutdown);

connect();
rl.prompt();
