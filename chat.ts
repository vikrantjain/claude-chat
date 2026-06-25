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

// Complete a leading @<prefix> token against the live roster (plus @all).
// Only fires while typing the leading token (no whitespace yet), so normal
// message typing is unaffected.
function completer(line: string): [string[], string] {
  if (!line.startsWith("@") || /\s/.test(line)) return [[], line];
  const prefix = line.slice(1).toLowerCase();
  const hits = rosterNames()
    .filter((n) => n.toLowerCase().startsWith(prefix))
    .map((n) => "@" + n);
  if ("all".startsWith(prefix)) hits.unshift("@all");
  return [hits, line];
}

// --- sticky addressing target ---
// null target with broadcast=false => unset (a bare line is rejected).
let target: string | null = null;
let broadcast = false;

// Mirror of the prompt string currently shown, so we can measure how many
// physical rows the echoed input line occupied (it may have wrapped).
let currentPrompt = "(no target) ❯ ";
function updatePrompt() {
  if (broadcast) currentPrompt = "(broadcast) ❯ ";
  else if (target) currentPrompt = `${target} ❯ `;
  else currentPrompt = "(no target) ❯ ";
  rl.setPrompt(currentPrompt);
}

type Parsed = { kind: "all" | "name" | "none"; target?: string; text: string; selectOnly: boolean };
// Leading-only @-parsing: only a leading @token routes; the rest is verbatim.
function parseLine(input: string): Parsed {
  if (input.startsWith("@")) {
    const m = input.match(/^@(\S+)\s*(.*)$/s);
    if (m) {
      const token = m[1];
      const text = m[2];
      const selectOnly = text === "";
      if (token.toLowerCase() === "all") return { kind: "all", text, selectOnly };
      return { kind: "name", target: token, text, selectOnly };
    }
  }
  return { kind: "none", text: input, selectOnly: false };
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  completer,
  prompt: "(no target) ❯ ",
});

// Print a line *above* the pinned input, then redraw the in-progress input
// buffer + cursor intact so async arrivals never mangle what's being typed.
function printAbove(text: string) {
  readline.cursorTo(process.stdout, 0);
  readline.clearLine(process.stdout, 0);
  process.stdout.write(text + "\n");
  rl.prompt(true);
}

// Erase readline's own echo of a just-submitted line. The prompt+input may have
// wrapped across several terminal rows, so walk up and clear each one — clearing
// only a single row would leave orphaned wrapped fragments on screen.
function eraseSubmittedEcho(input: string) {
  const cols = process.stdout.columns || 80;
  const rows = Math.max(1, Math.ceil((currentPrompt.length + input.length) / cols));
  for (let i = 0; i < rows; i++) {
    readline.moveCursor(process.stdout, 0, -1);
    readline.clearLine(process.stdout, 0);
  }
}

// --- WebSocket lifecycle ---
let ws: WebSocket;
let registered = false;
let everRegistered = false;
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
      // Banner once on first connect; later reconnects get a quiet confirmation
      // (the "connection lost — reconnecting" line already announced the blip).
      if (!everRegistered) {
        everRegistered = true;
        printAbove(dim(`* connected to ${brokerUrl} as "${name}"  (/help for commands)`));
      } else {
        printAbove(dim(`* reconnected as "${name}"`));
      }
      send({ type: "list", id: 0 }); // seed/re-seed the roster
      break;

    case "participants":
      roster.clear();
      for (const n of msg.names || []) {
        if (typeof n === "string" && n.toLowerCase() !== name.toLowerCase()) {
          roster.set(n.toLowerCase(), n);
        }
      }
      // If our sticky target vanished while we were disconnected, we never saw
      // its "left" frame. Drop it now so a bare line can't hit the broker's
      // unknown-recipient error.
      if (target && !roster.has(target.toLowerCase())) {
        const gone = target;
        target = null;
        updatePrompt();
        printAbove(dim(`* target ${gone} is no longer here — target cleared`));
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
      // If the sticky target just left, clear it so a bare line can't silently
      // hit the broker's unknown-recipient error.
      if (target && msg.name && msg.name.toLowerCase() === target.toLowerCase()) {
        target = null;
        updatePrompt();
        printAbove(dim(`* target ${msg.name} left — target cleared`));
      }
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

let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
let shuttingDown = false;

function connect() {
  ws = new WebSocket(brokerUrl);
  ws.onopen = () => {
    reconnectDelay = 1000; // reset backoff on a successful open
    registered = false;
    // Re-register with the same stable instanceId so the broker takes the name
    // over silently on a transient reconnect. The roster is re-seeded by the
    // `list` sent on `registered`.
    ws.send(JSON.stringify({ type: "register", name, instanceId }));
  };
  ws.onmessage = handleMessage;
  // onclose fires right after and prints the actionable "reconnecting" line, so
  // keep onerror quiet (debug only) to avoid a double diagnostic per failure.
  ws.onerror = () => log("websocket error");
  ws.onclose = () => {
    registered = false;
    if (shuttingDown) return;
    printAbove(dim(`! connection lost — reconnecting in ${reconnectDelay}ms`));
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  };
}

// --- input handling ---
function handleCommand(line: string) {
  const cmd = line.slice(1).trim().split(/\s+/)[0];
  switch (cmd) {
    case "help":
      printAbove(dim("commands:  /help  /who  /quit   (Ctrl-C also exits)"));
      break;
    case "who": {
      const names = rosterNames();
      printAbove(dim(names.length ? `/who — ${names.join(", ")}` : "/who — (no other participants)"));
      break;
    }
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
  eraseSubmittedEcho(input);

  if (input.startsWith("/")) {
    handleCommand(input);
    rl.prompt();
    return;
  }
  if (input.trim() === "") {
    rl.prompt();
    return;
  }

  const p = parseLine(input);

  // Apply sticky-target selection from a leading @token.
  if (p.kind === "all") {
    broadcast = true;
    target = null;
    updatePrompt();
  } else if (p.kind === "name") {
    target = p.target!;
    broadcast = false;
    updatePrompt();
  }

  // A leading @token alone just selects the target — send nothing.
  if (p.kind !== "none" && p.selectOnly) {
    rl.prompt();
    return;
  }

  // Resolve the destination for the text we are about to send.
  if (p.kind === "none" && !broadcast && !target) {
    printAbove(dim("! no target — start with @name or @all (or select one first)"));
    rl.prompt();
    return;
  }
  if (!isOpen()) {
    printAbove(dim("! not connected — message not sent"));
    rl.prompt();
    return;
  }

  const toName = p.kind === "name" ? p.target! : p.kind === "all" ? null : target;
  if (toName) {
    send({ type: "message", text: p.text, to: toName });
    printAbove(`${dim(`me → ${toName} ❯`)} ${p.text}`);
  } else {
    send({ type: "message", text: p.text });
    printAbove(`${dim("me → all ❯")} ${p.text}`);
  }
  rl.prompt();
});

function shutdown() {
  shuttingDown = true;
  try {
    ws?.close();
  } catch {}
  process.exit(0);
}
rl.on("SIGINT", shutdown);
rl.on("close", shutdown);

connect();
rl.prompt();
