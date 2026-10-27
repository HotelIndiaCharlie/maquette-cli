#!/usr/bin/env node
// Maquette: one DesignCraft for every session. `maquette` runs the engine (DesignCraft headless
// plus Maquette's tool modules) in the folder it's started in, takes tool calls over HTTP on
// localhost from other sessions and, on a terminal, gives a prompt to type them too. Calls
// run one at a time, all on the same open document. `call` and `tools` are its clients.
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { clearLine, createInterface, cursorTo, type Interface } from "node:readline";
import { text as readAll } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import type { ToolResult } from "./designcraft.ts";
import { findDesignCraft, home, installDesignCraft, pin, pinned } from "./install.ts";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
const usage = `Usage:
  maquette                               start DesignCraft in this folder, with a prompt to type tool calls
  maquette call <tool> [--flag value …]  call a tool on the running Maquette
  maquette tools [<tool>]                list the tools, or show one tool's flags
  maquette example                       copy the example report into ./example/
  maquette install-designcraft           install the DesignCraft CLI ${pin.version} (the headless engine, not the app)
A tool's arguments are --flags (render_page --page 0); its required ones can go without the
flag (open_document example/annual-report.designcraft). @file reads a value from a JSON file,
and a single {…} or @file gives all the arguments. Paths are relative to the folder Maquette
runs in, and DesignCraft reads and writes only inside it.
Options: --port <n> (default 8787) for every command; --json for call and tools (the raw
reply); --designcraft <path> (or DESIGNCRAFT_CLI) to run another DesignCraft CLI; --from <zip>
to install the CLI from a downloaded copy of its release zip.`;

type Reply = { id: number; tool: string; ok: boolean; text: string; images: string[] };
type Prop = { type?: string | string[]; description?: string };
type Tool = { name: string; description?: string; inputSchema: { properties?: Record<string, Prop>; required?: string[] } };

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// Maquette's own options work anywhere on the line; no tool has arguments by these names.
const argv = process.argv.slice(2);
function option(name: string, takesValue = false): string | undefined {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const [a] = argv.splice(i, 1);
  if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
  return takesValue ? (argv.splice(i, 1)[0] ?? fail(`--${name} needs a value.`)) : "";
}
const portText = option("port", true) ?? "8787";
const port = Number(portText);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`--port ${portText} isn't a port number.`);
const asJson = option("json") !== undefined;
const designcraftPath = option("designcraft", true);
const fromZip = option("from", true);
const wantsHelp = option("help") !== undefined || argv.includes("-h");
const wantsVersion = option("version") !== undefined || argv.includes("-v");
const [command, ...rest] = argv;

const two = (n: number) => String(n).padStart(2, "0");
const clock = (d = new Date()) => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
const stamp = (d: Date) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${clock(d).replaceAll(":", "")}`;
const gist = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const tilde = (p: string) => (p === homedir() || p.startsWith(`${homedir()}/`) ? `~${p.slice(homedir().length)}` : p);
const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

// The start screen: the name in block letters, shaded cyan to magenta to yellow like the
// process inks, or in spaced capitals when the terminal is too narrow. Colour only on a terminal.
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string | number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const inks = [51, 81, 111, 141, 171, 201, 206, 211, 216, 221, 226];
const shade = (row: string) => [...row].map((ch, i, all) => (ch === " " ? ch : paint(`38;5;${inks[Math.round((i / (all.length - 1)) * (inks.length - 1))]}`, ch))).join("");
const title = [
  "███╗   ███╗ █████╗  ██████╗ ██╗   ██╗███████╗████████╗████████╗███████╗",
  "████╗ ████║██╔══██╗██╔═══██╗██║   ██║██╔════╝╚══██╔══╝╚══██╔══╝██╔════╝",
  "██╔████╔██║███████║██║   ██║██║   ██║█████╗     ██║      ██║   █████╗  ",
  "██║╚██╔╝██║██╔══██║██║▄▄ ██║██║   ██║██╔══╝     ██║      ██║   ██╔══╝  ",
  "██║ ╚═╝ ██║██║  ██║╚██████╔╝╚██████╔╝███████╗   ██║      ██║   ███████╗",
  "╚═╝     ╚═╝╚═╝  ╚═╝ ╚══▀▀═╝  ╚═════╝ ╚══════╝   ╚═╝      ╚═╝   ╚══════╝",
];

function banner() {
  const rows = (process.stdout.columns || 80) < title[0].length + 2 ? ["M A Q U E T T E"] : title;
  const swatches = [51, 201, 226, 244].map((n) => paint(`38;5;${n}`, "■")).join(" ");
  console.log(`\n${rows.map((r) => `  ${shade(r)}`).join("\n")}\n\n  ${swatches}  ${paint(1, "one DesignCraft for every session")}\n`);
}

// Splits a typed line as a shell would: quotes group words, a backslash escapes a character.
function words(line: string): string[] {
  const out: string[] = [];
  let word = "", quote = "", started = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = "";
      else if (ch === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += ch;
    } else if (ch === '"' || ch === "'") [quote, started] = [ch, true];
    else if (ch === "\\" && i + 1 < line.length) [word, started] = [word + line[++i], true];
    else if (/\s/.test(ch)) {
      if (started) out.push(word);
      [word, started] = ["", false];
    } else [word, started] = [word + ch, true];
  }
  if (quote) throw new Error(`a ${quote} isn't closed`);
  if (started) out.push(word);
  return out;
}

const kind = (p?: Prop) => [p?.type].flat()[0];

// One argument's value, by its type in the tool's schema. @file reads JSON from a file, found
// from `base` (the folder Maquette runs in).
function value(raw: string, type: string | undefined, base: string): unknown {
  if (type === "string") return raw;
  if (raw.startsWith("@")) return JSON.parse(readFileSync(resolve(base, raw.slice(1).replace(/^~(?=\/|$)/, homedir())), "utf8"));
  if (type === "number" || type === "integer") {
    if (raw.trim() === "" || Number.isNaN(Number(raw))) throw new Error(`"${raw}" isn't a number`);
    return Number(raw);
  }
  if (type === "boolean") {
    if (raw !== "true" && raw !== "false") throw new Error(`"${raw}" isn't true or false`);
    return raw === "true";
  }
  try {
    return JSON.parse(raw);
  } catch {
    if (type === "object" || type === "array") throw new Error(`"${gist(raw, 40)}" isn't JSON; give it as JSON or @file`);
    return raw;
  }
}

// A tool's arguments from what was typed after its name: --flag value (or --flag=value), a
// bare --flag for true and --no-flag for false, a dotted --params.label for a nested field, and
// bare words for the required arguments in order. A single {…} or @file is the whole set.
function toArgs(tool: Tool, tokens: string[], base: string): Record<string, unknown> {
  if (tokens.length === 1 && /^[{@]/.test(tokens[0])) {
    const all = value(tokens[0], "object", base);
    if (typeof all !== "object" || all === null || Array.isArray(all)) throw new Error("the arguments must be a JSON object");
    return all as Record<string, unknown>;
  }
  const props = tool.inputSchema.properties ?? {};
  const known = Object.keys(props).length ? `its flags are ${Object.keys(props).map((k) => `--${k}`).join(", ")}` : "it takes no arguments";
  const args: Record<string, unknown> = {};
  const bare: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = /^--(no-)?([^=]+)(?:=(.*))?$/s.exec(tokens[i]);
    if (!m) {
      bare.push(tokens[i]);
      continue;
    }
    const [, no, key, inline] = m;
    const path = key.split(".");
    if (!(path[0] in props)) throw new Error(`${tool.name} has no --${path[0]}; ${known}`);
    const type = no ? "boolean" : path.length === 1 ? kind(props[key]) : undefined;
    let raw = no ? "false" : inline;
    if (raw === undefined) {
      const next = tokens[i + 1];
      const hasNext = next !== undefined && !next.startsWith("--");
      if (type === "boolean") raw = hasNext && (next === "true" || next === "false") ? tokens[++i] : "true";
      else if (hasNext) raw = tokens[++i];
      else if (type === undefined) raw = "true";
      else throw new Error(`--${key} needs a value`);
    }
    let into = args;
    for (const k of path.slice(0, -1)) into = (into[k] ??= {}) as Record<string, unknown>;
    into[path.at(-1)!] = value(raw, type, base);
  }
  const open = (tool.inputSchema.required ?? []).filter((k) => !(k in args));
  for (const word of bare) {
    const key = open.shift();
    if (!key) throw new Error(`there's no argument left for "${word}"; give it as --flag value (${known})`);
    args[key] = value(word, kind(props[key]), base);
  }
  return args;
}

// A tool's description and flags, for `help <tool>` and `maquette tools <tool>`.
function describe(tool: Tool): string {
  const props = Object.entries(tool.inputSchema.properties ?? {});
  const required = tool.inputSchema.required ?? [];
  const placeholder: Record<string, string> = { string: "<text>", integer: "<n>", number: "<n>", boolean: "", object: "<json|@file>", array: "<json|@file>" };
  const flags = props.map(([k, p]) => [`--${k} ${placeholder[kind(p) ?? ""] ?? "<value>"}${required.includes(k) ? " (required)" : ""}`, p.description ?? ""]);
  const width = Math.max(0, ...flags.map(([f]) => f.length));
  const form = `${tool.name}${required.map((k) => ` <${k}>`).join("")}${props.length > required.length ? " [--flags]" : ""}`;
  return [`${paint(1, form)}\n`, tool.description ?? "", flags.length ? `\nFlags:\n${flags.map(([f, d]) => `  ${f.padEnd(width)}  ${d}`).join("\n")}` : "\nNo arguments."].join("\n");
}

function catalogue(tools: Tool[]): string {
  const width = Math.max(...tools.map((t) => t.name.length));
  return tools.map((t) => `${t.name.padEnd(width)}  ${gist((t.description ?? "").split("\n")[0].split(/(?<=[a-z]\.)\s(?=[A-Z])/)[0], 110)}`).join("\n");
}

// Copies the example report, its data and five chart specs into <folder>/example/, leaving
// any file already there alone.
function copyExample(folder: string): string {
  const to = join(folder, "example");
  cpSync(join(pkg, "examples"), to, { recursive: true, force: false });
  return `Copied the example report, its data and five chart specs into ${tilde(to)}/. Try:
  open_document example/annual-report.designcraft
  chart_create firstlight:slot:01 @example/specs/01-revenue.json`;
}

async function install(from?: string): Promise<string> {
  let shown = -1;
  const progress = (bytes: number) => {
    const now = Math.round(bytes / 1e6);
    if (process.stdout.isTTY && now !== shown) process.stdout.write(`\r  ${from ? "Reading" : "Downloading"} DesignCraft CLI ${pin.version}: ${(shown = now)} of ${mb(pin.cli.bytes)}`);
  };
  try {
    const path = await installDesignCraft(from, progress);
    console.log(`${process.stdout.isTTY ? "\n" : ""}  ${paint(32, "✓")} Checked its SHA-256 and installed it in ${tilde(home)}\n`);
    return path;
  } catch (e) {
    fail(`\n  ${(e as Error).message}`);
  }
}

// On the first run the DesignCraft CLI isn't there yet: say what Maquette needs and offer to
// install it.
async function offerInstall(): Promise<string> {
  console.log(`  Maquette runs on the DesignCraft CLI, DesignCraft's headless engine (not the desktop app),
  and it isn't installed yet. Maquette can download version ${pin.version} (${mb(pin.cli.bytes)}) from DesignCraft's
  GitHub release, check its SHA-256 and keep it in ${tilde(home)}.`);
  if (!process.stdin.isTTY) fail("\n  Install it with: maquette install-designcraft");
  const ask = createInterface({ input: process.stdin, output: process.stdout });
  ask.on("SIGINT", () => fail("\n\n  Not installed."));
  const answer = await new Promise<string>((done) => ask.question(`\n  Install it now? ${paint(2, "[Y/n]")} `, done));
  ask.close();
  if (/^n/i.test(answer.trim())) fail("\n  Maquette can't start without it. Install it later with: maquette install-designcraft");
  return install();
}

const promptHelp = `Type a tool's name and its arguments as flags, for example:
  open_document example/annual-report.designcraft
  save_document --path my-report.designcraft
  chart_create firstlight:slot:01 @example/specs/01-revenue.json
  render_page --page 0
Required arguments can go without their flag. @file reads JSON from a file. Paths are relative
to this folder. Quote values with spaces: --text "Two words". Tab completes tools and flags.

  tools          the tools, one line each
  help <tool>    a tool's description and flags
  example        copy the example report into ./example/
  open           open the last image in Preview
  exit           stop Maquette (also Ctrl-D, or Ctrl-C on an empty line)`;

async function serve() {
  const running = await fetch(`http://127.0.0.1:${port}/tools`).then((r) => r.json(), () => undefined);
  if (running) fail(`Maquette is already running on port ${port}, in ${tilde(running.root ?? "another folder")}. Send it calls with \`maquette call\`, or start another with --port.`);
  banner();
  let cli: string | undefined;
  try {
    cli = findDesignCraft(designcraftPath);
  } catch (e) {
    fail(`  ${(e as Error).message}`);
  }
  cli ??= await offerInstall();
  const root = process.cwd();
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "maquette", version });
  // The engine runs under this same Node, as source (.ts) or built (.js) like this file.
  const engine = fileURLToPath(new URL(`./engine${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
  const transport = new StdioClientTransport({ command: process.execPath, args: [...process.execArgv, engine, "--designcraft", cli, "--root", root], cwd: root, stderr: "pipe" });
  transport.stderr?.on("data", (d: Buffer) => process.stderr.write(paint(2, d.toString().replace(/^(?=.)/gm, "  "))));
  await client.connect(transport);
  const tools = (await client.listTools()).tools as Tool[];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const instructions = client.getInstructions() ?? "";
  const images = join(root, "maquette-renders", stamp(new Date()));
  let count = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let lastImage: string | undefined;
  let prompt: Interface | undefined;
  let busy = 0;

  // Prints a line above the prompt, keeping whatever is being typed there.
  function say(line: string) {
    const live = prompt && !busy;
    if (live) {
      clearLine(process.stdout, 0);
      cursorTo(process.stdout, 0);
    }
    console.log(line);
    if (live) prompt!.prompt(true);
  }

  // Calls the tool and saves any images under maquette-renders/<start>/, so the reply carries paths.
  async function run(id: number, tool: string, args: Record<string, unknown>, remote: boolean): Promise<Reply> {
    const t0 = Date.now();
    const reply: Reply = { id, tool, ok: false, text: "", images: [] };
    try {
      const r = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 600_000 })) as ToolResult;
      const texts: string[] = [];
      for (const c of r.content) {
        if (c.type === "text") texts.push(c.text ?? "");
        else if (c.type === "image" && c.data) {
          mkdirSync(images, { recursive: true });
          const n = reply.images.length ? `-${reply.images.length + 1}` : "";
          const path = join(images, `${String(id).padStart(3, "0")}-${tool}${n}.${c.mimeType === "image/jpeg" ? "jpg" : "png"}`);
          writeFileSync(path, Buffer.from(c.data, "base64"));
          reply.images.push(path);
          lastImage = path;
        } else texts.push(JSON.stringify(c));
      }
      reply.ok = !r.isError;
      reply.text = texts.join("\n");
    } catch (e) {
      reply.text = e instanceof Error ? e.message : String(e);
    }
    const outcome = reply.ok ? paint(32, "ok") : paint(31, `error: ${gist(reply.text.split("\n")[0], 100)}`);
    const from = remote ? [paint(35, "http")] : [];
    say(`  ${[paint(2, clock()), `#${id}`, ...from, paint(1, tool), gist(JSON.stringify(args), 60), outcome, `${Date.now() - t0} ms`, ...reply.images.map((p) => relative(root, p))].join("  ")}`);
    return reply;
  }

  // DesignCraft holds one document, so calls from the prompt and over HTTP run one at a
  // time, in arrival order.
  function enqueue(tool: string, args: Record<string, unknown>, remote: boolean): Promise<Reply> {
    const id = ++count;
    const reply = queue.then(() => run(id, tool, args, remote));
    queue = reply;
    return reply;
  }

  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    // Local clients sending JSON only: the Host check stops DNS rebinding, and a web page
    // can't post JSON here without a CORS preflight, which this server never answers.
    if (!hosts.has(req.headers.host ?? "")) return send(403, { ok: false, text: "Only local clients may call this server." });
    if (req.method === "GET" && req.url === "/tools") return send(200, { root, instructions, tools });
    if (req.method !== "POST" || req.url !== "/call") return send(404, { ok: false, text: "POST /call {tool, arguments}, or GET /tools." });
    if (!req.headers["content-type"]?.startsWith("application/json")) return send(415, { ok: false, text: "Send the call as application/json." });
    let body: { tool?: unknown; arguments?: unknown };
    try {
      body = JSON.parse(await readAll(req));
    } catch {
      return send(400, { ok: false, text: "The body isn't JSON." });
    }
    const { tool, arguments: args = {} } = body;
    if (typeof tool !== "string" || !byName.has(tool)) return send(400, { ok: false, text: `No tool named ${JSON.stringify(tool)}; GET /tools lists them.` });
    if (typeof args !== "object" || args === null || Array.isArray(args)) return send(400, { ok: false, text: "arguments must be a JSON object." });
    send(200, await enqueue(tool, args as Record<string, unknown>, true));
  });

  // One line typed at the prompt: a tool call or one of the prompt's own commands.
  async function typed(line: string) {
    const [, word = "", after = ""] = /^\s*(\S*)\s*(.*)$/s.exec(line) ?? [];
    const tool = byName.get(word);
    busy++;
    try {
      if (!word) return;
      if (word === "exit" || word === "quit") return void stop();
      if (word === "help" && !after) console.log(promptHelp);
      else if (word === "help") console.log(byName.has(after.trim()) ? describe(byName.get(after.trim())!) : paint(31, `There's no tool "${after.trim()}". Type tools for their names.`));
      else if (word === "tools") console.log(catalogue(tools));
      else if (word === "example") console.log(copyExample(root));
      else if (word === "open") {
        if (lastImage) execFile("open", [lastImage]);
        console.log(lastImage ? `Opening ${relative(root, lastImage)}` : "No image yet; render_page --page 0 makes one.");
      } else if (!tool) console.log(paint(31, `There's no tool or command "${word}". Type help, or tools for the tool names.`));
      else {
        const args = toArgs(tool, after.trimStart().startsWith("{") ? [after.trim()] : words(after), root);
        const reply = await enqueue(tool.name, args, false);
        if (reply.text) console.log(reply.ok ? reply.text : paint(31, reply.text));
        for (const p of reply.images) console.log(`${paint(36, "image")} ${p}  ${paint(2, "(open shows it)")}`);
      }
    } catch (e) {
      console.log(paint(31, (e as Error).message));
    } finally {
      busy--;
      if (!stopping && !busy) prompt?.prompt();
    }
  }

  const commands = ["help", "tools", "example", "open", "exit"];
  function complete(line: string): [string[], string] {
    const parts = line.trimStart().split(/\s+/);
    const last = parts.at(-1) ?? "";
    const props = byName.get(parts[0])?.inputSchema.properties ?? {};
    const options =
      parts.length === 1 ? [...commands, ...byName.keys()]
      : parts[0] === "help" && parts.length === 2 ? [...byName.keys()]
      : last.startsWith("-") ? Object.keys(props).map((k) => `--${k}`)
      : [];
    return [options.filter((o) => o.startsWith(last)), last];
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("\n  Stopping DesignCraft.");
    server.close();
    server.closeAllConnections();
    await client.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  client.onclose = () => {
    if (!stopping) fail("The engine has stopped, so Maquette stops too.");
  };
  server.on("error", async (e: NodeJS.ErrnoException) => {
    stopping = true;
    await client.close();
    fail(e.code === "EADDRINUSE" ? `Port ${port} is in use by another program. Pick another port with --port.` : e.message);
  });
  server.listen(port, "127.0.0.1", () => {
    const tick = paint(32, "✓");
    const engineName = cli === pinned ? `DesignCraft ${pin.version} CLI` : `DesignCraft CLI at ${tilde(cli)}`;
    console.log(`\n  ${tick} ${engineName}, headless, with Maquette's tools (${tools.length} tools)`);
    console.log(`  ${tick} Working in ${paint(1, tilde(root))}: DesignCraft reads and writes only here`);
    console.log(`  ${tick} Listening on ${paint(1, `http://127.0.0.1:${port}`)} for other sessions`);
    console.log(`  ${tick} Renders go to ${relative(root, images)}/\n`);
    if (!process.stdin.isTTY) {
      console.log(`  From another terminal: ${paint(36, "maquette tools")}, then ${paint(36, "maquette call <tool> --flag value")}`);
      console.log(`  ${paint(2, "Ctrl-C stops it; unsaved changes to the document are lost.")}\n`);
      return;
    }
    console.log(`  Type a tool and its flags, e.g. ${paint(36, "render_page --page 0")}. ${paint(36, "help")} shows how.`);
    if (!readdirSync(root).some((f) => f.endsWith(".designcraft"))) console.log(`  No document here yet? ${paint(36, "example")} copies in an example report.`);
    console.log(`  Other terminals and sessions: ${paint(36, "maquette call <tool> --flag value")}`);
    console.log(`  ${paint(2, "exit or Ctrl-D stops it; unsaved changes to the document are lost.")}\n`);
    prompt = createInterface({ input: process.stdin, output: process.stdout, prompt: `${paint(35, "maquette ›")} `, completer: complete, historySize: 500 });
    prompt.on("line", (line) => void typed(line));
    prompt.on("close", () => void stop());
    // Ctrl-C clears what's typed, as in Claude Code; on an empty line it stops Maquette.
    prompt.on("SIGINT", () => {
      if (!prompt!.line) return void stop();
      prompt!.write(null, { ctrl: true, name: "e" });
      prompt!.write(null, { ctrl: true, name: "u" });
    });
    prompt.prompt();
  });
}

async function request(path: string, body?: unknown): Promise<any> {
  try {
    const init = body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
    return await (await fetch(`http://127.0.0.1:${port}${path}`, init)).json();
  } catch (e) {
    if ((e as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED") fail(`Maquette isn't running on port ${port}. Start it in another terminal: maquette`);
    throw e;
  }
}

async function call(name: string | undefined, tokens: string[]) {
  if (!name) fail(usage);
  let args: Record<string, unknown>;
  try {
    if (tokens.length === 1 && tokens[0] === "-") args = JSON.parse(await readAll(process.stdin));
    else {
      const { tools, root }: { tools: Tool[]; root: string } = await request("/tools");
      const tool = tools.find((t) => t.name === name) ?? fail(`There's no tool "${name}". \`maquette tools\` lists them.`);
      args = toArgs(tool, tokens, root);
    }
  } catch (e) {
    fail(`Can't read the arguments: ${(e as Error).message}`);
  }
  const r: Partial<Reply> = await request("/call", { tool: name, arguments: args });
  if (asJson) console.log(JSON.stringify(r, null, 2));
  else {
    if (r.text) (r.ok ? console.log : console.error)(r.text);
    for (const p of r.images ?? []) console.log(`image: ${p}`);
  }
  process.exitCode = r.ok ? 0 : 1;
}

async function listTools(name: string | undefined) {
  const { instructions, tools, root }: { instructions: string; tools: Tool[]; root: string } = await request("/tools");
  const tool = name === undefined ? undefined : tools.find((t) => t.name === name) ?? fail(`There's no tool "${name}".`);
  if (asJson) return console.log(JSON.stringify(tool ?? { root, instructions, tools }, null, 2));
  if (tool) return console.log(describe(tool));
  console.log(`Maquette is working in ${tilde(root)}.\n\n${instructions}\n\n${catalogue(tools)}\n\n\`maquette tools <name>\` shows a tool's description and flags.`);
}

if (wantsVersion) console.log(`maquette ${version} (DesignCraft CLI ${pin.version} pinned)`);
else if (wantsHelp || command === "help") console.log(usage);
else if (!command || command === "serve") await serve();
else if (command === "call") await call(rest[0], rest.slice(1));
else if (command === "tools") await listTools(rest[0]);
else if (command === "example") console.log(copyExample(process.cwd()));
else if (command === "install-designcraft") {
  if (existsSync(pinned) && !fromZip) console.log(`DesignCraft CLI ${pin.version} is already installed in ${tilde(home)}.`);
  else await install(fromZip);
} else fail(`Unknown command ${command}.\n\n${usage}`);
