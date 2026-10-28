#!/usr/bin/env node
// Maquette: one DesignCraft for every session. `maquette` runs the engine (DesignCraft headless
// plus Maquette's tool modules) in the folder it's started in, takes tool calls over HTTP on
// localhost from other sessions and, on a terminal, gives a prompt where sentences go to the
// model and tool calls run directly. Calls run one at a time, all on the same open document.
// `call` and `tools` are its clients. `config` shows and changes the settings, and `ask` and
// `models` talk to the model they name.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { text as readAll } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import type { AgentSession } from "./agent/session.ts";
import { catalogue, clock, describe, gist, paint, shortPath, tilde, toArgs, type Tool } from "./args.ts";
import { bannerText } from "./banner.ts";
import { imageType } from "./images.ts";
import { findDesignCraft, home, installDesignCraft, pin, pinned } from "./install.ts";
import { fill } from "./agent/prompts.ts";
import { createProvider, defaultModels, type ImagePart, type TextPart } from "./providers/index.ts";
import { type Reply, type ServerEvent, type ServerHandle, startServer } from "./server.ts";
import { defaults, ensure, type Loaded, load, parse, schema, SettingsError, write } from "./settings.ts";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
const usage = `Usage (mqt is short for maquette and takes the same commands):
  maquette                               start DesignCraft in this folder, with a prompt: sentences go to the model, tool calls run directly
  maquette call <tool> [--flag value …]  call a tool on the running Maquette
  maquette tools [<tool>]                list the tools, or show one tool's flags
  maquette example                       copy the example report into ./example/
  maquette install-designcraft           install the DesignCraft CLI ${pin.version} (the headless engine, not the app)
  maquette ask "<message>"               ask the model one question; - or a pipe reads it from stdin
  maquette models                        list the models the provider offers
  maquette config                        show the settings and where each comes from
  maquette config set <key> <value>      change one (unset <key> removes it; keys describes them all)
  maquette config edit                   open your settings file in an editor, creating it if needed
A tool's arguments are --flags (render_page --page 0); its required ones can go without the
flag (open_document example/annual-report.designcraft). @file reads a value from a JSON file,
and a single {…} or @file gives all the arguments. Paths are relative to the folder Maquette
runs in, and DesignCraft reads and writes only inside it.
Options: --port <n> (default 8787) for every command; --trace with maquette alone, to start
Phoenix (in Docker, starting Docker if need be) and trace every turn and call to it; --json for
call, tools and models (the raw reply); --designcraft <path> (or DESIGNCRAFT_CLI) to run another
DesignCraft CLI; --from <zip> to install the CLI from a downloaded copy of its release zip;
--provider <name> and --model <id> for ask and models; --image <file> (repeatable) to show the
model an image with ask; --project for config set, unset and edit, to use .maquette/settings.json
here instead of ~/.maquette.`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// Maquette's own options work anywhere on the line; no tool has arguments by these names.
const argv = process.argv.slice(2);
function option(name: string, takesValue = false, from = argv): string | undefined {
  const i = from.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const [a] = from.splice(i, 1);
  if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
  return takesValue ? (from.splice(i, 1)[0] ?? fail(`--${name} needs a value.`)) : "";
}
const portFlag = option("port", true);
const asJson = option("json") !== undefined;
const designcraftFlag = option("designcraft", true);
const fromZip = option("from", true);
const traceFlag = option("trace") !== undefined;
const wantsHelp = option("help") !== undefined || argv.includes("-h");
const wantsVersion = option("version") !== undefined || argv.includes("-v");
const [command, ...rest] = argv;
// Options that only some commands read, taken from their own arguments, so that a tool's
// flags of the same name still reach it through `maquette call`.
const talks = command === "ask" || command === "models";
const modelFlag = talks ? option("model", true, rest) : undefined;
const providerFlag = talks ? option("provider", true, rest) : undefined;
const imageFlags: string[] = [];
for (let image; command === "ask" && (image = option("image", true, rest)) !== undefined; ) imageFlags.push(image);
const projectScope = command === "config" && option("project", false, rest) !== undefined;

let loaded: Loaded;
try {
  loaded = load({ flags: { port: portFlag, designcraft: designcraftFlag, model: modelFlag, provider: providerFlag }, lenient: command === "config" });
} catch (e) {
  fail((e as Error).message);
}
const { settings } = loaded;
const port = settings.port;
const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

// Copies the example report, its data and five chart specs into <folder>/example/, leaving
// any file already there alone.
function copyExample(folder: string): string {
  const to = join(folder, "example");
  cpSync(join(pkg, "examples"), to, { recursive: true, force: false });
  return `Copied the example report, its data and five chart specs into ${tilde(to)}/. Try:
  open_document example/annual-report.designcraft
  chart_create firstlight:slot:01 @example/specs/01-revenue.json
or just say what you want done with it.`;
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

// One call's log line, for the plain output when there's no screen.
function logLine(e: Extract<ServerEvent, { type: "call" }>, root: string): string {
  const { reply, args, at } = e;
  const outcome = reply.ok ? paint(32, "ok") : paint(31, `error: ${gist(reply.text.split("\n")[0], 100)}`);
  const from = reply.source === "http" ? [paint(35, "http")] : reply.source === "model" ? [paint(34, "model")] : [];
  return `  ${[paint(2, clock(at)), `#${reply.id}`, ...from, paint(1, reply.tool), gist(JSON.stringify(args), 60), outcome, `${reply.ms} ms`, ...reply.images.map((p) => relative(root, p))].join("  ")}`;
}

async function serve() {
  const running = await fetch(`http://127.0.0.1:${port}/tools`).then((r) => r.json(), () => undefined);
  if (running) fail(`Maquette is already running on port ${port}, in ${tilde(running.root ?? "another folder")}. Send it calls with \`maquette call\`, or start another with --port.`);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  // With a screen, the banner is the first thing the screen draws, so nothing is drawn twice.
  if (!interactive) console.log(bannerText());
  // MAQUETTE_ENGINE names another engine script to run instead of src/engine.ts; the tests
  // use one that needs no DesignCraft.
  const engine = process.env.MAQUETTE_ENGINE || undefined;
  let cli: string | undefined;
  if (!engine) {
    try {
      cli = findDesignCraft(settings.designcraft);
    } catch (e) {
      fail(`  ${(e as Error).message}`);
    }
    cli ??= await offerInstall();
  }
  const server = await startServer({ port, version, cli, engine }).catch((e: Error) => fail(`  ${e.message}`));
  const root = server.root;
  let stopping = false;
  let tracing: { shutdown(): Promise<void> } | undefined;
  const stop = async (code = 0) => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("\n  Stopping DesignCraft.");
    await tracing?.shutdown();
    await server.stop();
    process.exit(code);
  };
  server.on((e) => {
    if (e.type === "engine_closed" && !stopping) fail("The engine has stopped, so Maquette stops too.");
  });
  const engineName = engine ? `Engine ${shortPath(engine)}` : cli === pinned ? `DesignCraft ${pin.version} CLI` : `DesignCraft CLI at ${tilde(cli!)}`;
  const hint = !readdirSync(root).some((f) => f.endsWith(".designcraft")) ? `No document here yet? ${paint(36, "example")} copies in an example report.` : undefined;

  if (!interactive) {
    const tick = paint(32, "✓");
    const traced = await trace(server, undefined, (text, level) => console.log(`  ${level === "warn" ? paint(33, "!") : tick} ${text}`));
    tracing = traced.tracing;
    console.log(`\n  ${tick} ${engineName}, headless, with Maquette's tools (${server.tools.length} tools)`);
    console.log(`  ${tick} Working in ${paint(1, tilde(root))}: DesignCraft reads and writes only here`);
    console.log(`  ${tick} Listening on ${paint(1, `http://127.0.0.1:${port}`)} for other sessions`);
    console.log(`  ${tick} Renders go to ${relative(root, server.images)}/`);
    if (traced.line) console.log(`  ${traced.line.ok ? tick : paint(33, "!")} ${traced.line.text}`);
    console.log();
    console.log(`  From another terminal: ${paint(36, "maquette tools")}, then ${paint(36, "maquette call <tool> --flag value")}`);
    console.log(`  ${paint(2, "Ctrl-C stops it; unsaved changes to the document are lost.")}\n`);
    server.on((e) => {
      if (e.type === "call") console.log(logLine(e, root));
      else if (e.type === "engine_log") process.stderr.write(paint(2, e.text.replace(/^(?=.)/gm, "  ")));
    });
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
    return;
  }

  const { AgentSession } = await import("./agent/session.ts");
  const { runApp } = await import("./ui/app.ts");
  const session = new AgentSession({ server, settings, projectFile: loaded.files.project, copyExample });
  const traced = await trace(server, session, (text, level) => session.notice(text, level));
  tracing = traced.tracing;
  process.on("SIGTERM", () => void stop());
  // Clear the screen first, so the title starts at the top; what was there stays in the scrollback.
  process.stdout.write("\x1b[2J\x1b[H");
  await runApp(session, server, { version, engineName, toolCount: server.tools.length, port, images: relative(root, server.images), hint, trace: traced.line });
  await stop();
}

// --trace starts Phoenix on localhost:6006 (and Docker, if need be) and traces to it;
// MAQUETTE_TRACE traces to a collector that's already running. For development: docs/telemetry.md.
// The line it returns goes under the title, so it's clear tracing is on, or why it isn't.
async function trace(server: ServerHandle, session: AgentSession | undefined, say: (text: string, level: "info" | "warn") => void): Promise<{ tracing?: { shutdown(): Promise<void> }; line?: { ok: boolean; text: string } }> {
  const value = traceFlag ? "1" : process.env.MAQUETTE_TRACE;
  if (!value || /^(0|false|no|off)$/i.test(value.trim())) return {};
  let telemetry: typeof import("./telemetry/index.ts");
  try {
    telemetry = await import("./telemetry/index.ts");
  } catch (e) {
    return { line: { ok: false, text: `Tracing is off: it needs the dev dependencies, so run from a clone after npm install (${(e as Error).message})` } };
  }
  let how = "";
  if (traceFlag) {
    try {
      how = await telemetry.ensurePhoenix({ say: (text) => console.log(`  ${paint(2, text)}`) });
    } catch (e) {
      return { line: { ok: false, text: `Tracing is off: ${(e as Error).message}` } };
    }
  }
  const tracing = telemetry.startTracing({ value, server, session, say, version });
  return { tracing, line: { ok: true, text: `Tracing to ${paint(1, tracing.url.replace(/\/v1\/traces$/, ""))}${how ? ` (${how})` : ""}, project maquette` } };
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
  const { instructions, project, tools, root }: { instructions: string; project?: string | null; tools: Tool[]; root: string } = await request("/tools");
  const tool = name === undefined ? undefined : tools.find((t) => t.name === name) ?? fail(`There's no tool "${name}".`);
  if (asJson) return console.log(JSON.stringify(tool ?? { root, instructions, project: project ?? null, tools }, null, 2));
  if (tool) return console.log(describe(tool));
  const memory = project ? `\n\nThe project's MAQUETTE.md:\n\n${project}` : "";
  console.log(`Maquette is working in ${tilde(root)}.\n\n${instructions}${memory}\n\n${catalogue(tools)}\n\n\`maquette tools <name>\` shows a tool's description and flags.`);
}

// Opens a file in $VISUAL or $EDITOR in this terminal, waiting until it's closed, or else in
// the system's text editor. Returns true when it waited.
function openInEditor(path: string): boolean {
  const editor = (process.env.VISUAL || process.env.EDITOR || "").trim();
  if (editor) {
    const [cmd, ...args] = editor.split(/\s+/);
    const r = spawnSync(cmd, [...args, path], { stdio: "inherit" });
    if (r.error) fail(`Couldn't run your editor, ${editor}: ${r.error.message}`);
    return true;
  }
  const opener = process.platform === "darwin" ? ["open", "-t"] : process.platform === "win32" ? ["notepad"] : ["xdg-open"];
  const r = spawnSync(opener[0], [...opener.slice(1), path], { stdio: "ignore" });
  if (r.error || r.status) fail(`Couldn't open an editor. Set EDITOR, or open ${path} yourself.`);
  return false;
}

// `maquette config edit`: makes sure the settings file exists, writes the defaults beside it
// for reference, and opens it. With an editor in the terminal, checks the file once it's closed.
function editSettings(scope: "user" | "project") {
  const file = loaded.files[scope];
  const made = ensure(file);
  const reference = join(dirname(loaded.files.user), "settings.defaults.json");
  writeFileSync(reference, `${JSON.stringify(defaults({ model: defaultModels.anthropic }), null, 2)}\n`);
  console.log(`${made ? "Created" : "Opening"} ${shortPath(file)}${made ? ", empty, and opening it" : ""}.`);
  console.log(paint(2, `Put in only the keys you want to change; the rest keep their defaults, and get newer ones as Maquette improves.
Every key with its default is in ${tilde(reference)}, which Maquette rewrites and never reads;
\`maquette config keys\` describes them.`));
  if (!openInEditor(file)) return console.log(`When you've saved it, \`maquette config\` shows the result and any mistakes.`);
  const after = load({ lenient: true });
  if (after.warnings.length) for (const w of after.warnings) console.log(paint(33, w));
  else console.log(`${paint(32, "✓")} ${shortPath(file)} is valid. \`maquette config\` shows the result.`);
}

// `maquette config`: the settings, each with where its value comes from; `set`, `unset` and
// `get` one key; `keys` describes every key; `edit` opens the file.
function config(args: string[]) {
  const [action = "list", key, ...words] = args;
  const scope = projectScope ? "project" : "user";
  const file = loaded.files[scope];
  const shown = (v: unknown) => (v === undefined ? "unset" : typeof v === "string" ? v : JSON.stringify(v));
  const origin = (k: string) => {
    const o = loaded.origins.get(k);
    return !o ? "" : o.source === "env" ? `env ${o.path}` : o.source === "flag" ? `--${k}` : o.source === "default" ? "default" : `${o.source} ${shortPath(o.path!)}`;
  };
  const value = (k: string) => k.split(".").reduce<any>((v, part) => v?.[part], settings);
  const known = (k: string | undefined) => (k && schema[k] ? k : fail(k ? `There's no setting "${k}". \`maquette config keys\` describes them.` : "Which setting? `maquette config keys` describes them."));
  try {
    if (action === "list") {
      const keys = Object.keys(schema);
      const width = Math.max(...keys.map((k) => k.length));
      const values = keys.map((k) => shown(k === "model" ? (value(k) ?? defaultModels[settings.provider]) : value(k)));
      const vwidth = Math.max(...values.map((v) => v.length));
      console.log(`Settings come from ${shortPath(loaded.files.user)}, then ${shortPath(loaded.files.project)},\nthen environment variables and flags; each overrides the one before.\n`);
      keys.forEach((k, i) => {
        const note = k === "model" && value(k) === undefined ? (defaultModels[settings.provider] ? `${settings.provider}'s default` : "") : origin(k);
        const v = values[i].padEnd(vwidth);
        console.log(`  ${k.padEnd(width)}  ${values[i] === "unset" ? paint(2, v) : v}  ${paint(2, note)}`);
      });
      const p = settings.providers[settings.provider];
      const keyEnv = p.apiKeyEnv;
      const has = (name: string) => Boolean(process.env[name]);
      const credentials =
        has(keyEnv) ? `${keyEnv} is set`
        : settings.provider === "anthropic" && has("ANTHROPIC_AUTH_TOKEN") ? "ANTHROPIC_AUTH_TOKEN is set"
        : settings.provider === "anthropic" ? `${keyEnv} isn't set; the SDK will look for an \`ant auth login\` profile`
        : `${keyEnv} isn't set, which is fine for a local server`;
      console.log(`\n  Credentials for ${settings.provider}: ${credentials}.`);
      console.log(`\n\`maquette config set <key> <value>\` writes ${tilde(loaded.files.user)}, and \`maquette config edit\` opens it;\nadd --project for this folder's. \`maquette config keys\` describes every key.`);
    } else if (action === "edit") editSettings(scope);
    else if (action === "keys") {
      for (const [k, spec] of Object.entries(schema)) {
        const extra = [spec.choices ? `one of ${spec.choices.join(", ")}` : spec.kind, spec.default !== undefined ? `default ${JSON.stringify(spec.default)}` : "", spec.env ? `env ${spec.env}` : ""].filter(Boolean).join("; ");
        console.log(`${paint(1, k)}  ${paint(2, extra)}\n  ${spec.about}`);
      }
    } else if (action === "get") {
      const v = value(known(key));
      if (v !== undefined) console.log(typeof v === "string" ? v : JSON.stringify(v));
    } else if (action === "set") {
      if (!words.length) fail(`What value? maquette config set ${known(key)} <value>`);
      const v = parse(known(key), words.join(" "), "maquette config set");
      write(file, key!, v);
      console.log(`Set ${key} to ${JSON.stringify(v)} in ${shortPath(file)}.`);
      const now = load({ lenient: true }).origins.get(key!);
      if (now && now.source !== scope) console.log(paint(33, `It doesn't take effect here: ${now.source === "env" ? `the environment variable ${now.path}` : `${shortPath(now.path!)}`} overrides it.`));
      if (key === "provider" && v === "openai-compatible" && !settings.model) console.log(`Now pick a model: \`maquette models\` lists what the server offers, then \`maquette config set model <id>\`.`);
    } else if (action === "unset") {
      console.log(write(file, known(key), undefined) ? `Removed ${key} from ${shortPath(file)}.` : `${key} isn't set in ${shortPath(file)}.`);
    } else fail(`maquette config takes list, keys, edit, get <key>, set <key> <value> or unset <key>, not "${action}".`);
  } catch (e) {
    if (e instanceof SettingsError) fail(e.message);
    throw e;
  }
}

async function listModels() {
  const provider = createProvider(settings);
  let list;
  try {
    list = await provider.models();
  } catch (e) {
    fail((e as Error).message);
  }
  if (asJson) return console.log(JSON.stringify(list, null, 2));
  const where = settings.provider === "openai-compatible" ? ` at ${settings.providers["openai-compatible"].baseUrl}` : "";
  console.log(`${list.length} models from ${provider.name}${where}:\n`);
  for (const m of list) console.log(`${m.id === provider.model ? paint(32, "›") : " "} ${m.id}${m.name && m.name !== m.id ? paint(2, `  ${m.name}`) : ""}`);
  console.log(`\n${provider.model ? `Using ${paint(1, provider.model)}. ` : "No model is set. "}Change it with \`maquette config set model <id>\`.`);
}

// What the model is told in `maquette ask`, from prompts/ask*.md: where it is, and Maquette's
// tools when it's running.
function askPrompt(running?: { root: string; instructions: string; project?: string | null; tools: Tool[] }): string {
  const where = running
    ? fill("ask-running", { root: running.root, instructions: running.instructions, project: running.project ? `\n\n${fill("ask-project", { memory: running.project })}` : "", tools: catalogue(running.tools) })
    : fill("ask-not-running");
  return `${fill("ask")}\n\n${where}`;
}

async function ask(tokens: string[]) {
  let text = tokens.join(" ").trim();
  if (text === "-" || (!text && !process.stdin.isTTY)) text = (await readAll(process.stdin)).trim();
  if (!text) fail('What should Maquette ask? maquette ask "<message>", or pipe the message in.');
  const parts: (TextPart | ImagePart)[] = imageFlags.map((p) => {
    const path = resolve(p.replace(/^~(?=\/|$)/, homedir()));
    if (!existsSync(path)) fail(`--image ${p}: there's no such file.`);
    const bytes = readFileSync(path);
    const mediaType = imageType(bytes) ?? fail(`--image ${p}: that isn't a PNG, JPEG, GIF or WebP image, which are what models can see.`);
    return { type: "image", mediaType, data: bytes.toString("base64"), path };
  });
  parts.push({ type: "text", text });
  const provider = createProvider(settings);
  const reply = await fetch(`http://127.0.0.1:${port}/tools`).then((r) => r.json(), () => undefined);
  const running = Array.isArray(reply?.tools) && typeof reply.root === "string" ? reply : undefined;
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  let last = "\n";
  let done;
  try {
    for await (const event of provider.chat({ system: [{ name: "ask", text: askPrompt(running) }], messages: [{ role: "user", parts }], signal: controller.signal })) {
      if (event.type === "text") {
        process.stdout.write(event.text);
        last = event.text.at(-1) ?? last;
      } else if (event.type === "notice") process.stderr.write(`${last === "\n" ? "" : "\n"}${paint(2, event.text)}\n`);
      else if (event.type === "done") done = event;
    }
  } catch (e) {
    if (last !== "\n") process.stdout.write("\n");
    if (controller.signal.aborted) {
      console.error(paint(2, "Stopped."));
      process.exit(130);
    }
    fail((e as Error).message);
  }
  if (last !== "\n") process.stdout.write("\n");
  if (!done) fail("The reply ended without finishing.");
  const u = done.usage;
  const cached = (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
  if (u) console.error(paint(2, `${done.model} · ${u.input + cached} tokens in${u.cacheRead ? `, ${u.cacheRead} from cache` : ""} · ${u.output} out`));
  if (done.stop === "refusal") {
    console.error(paint(31, `The model declined to answer${done.detail ? `: ${done.detail}` : "."}`));
    process.exitCode = 1;
  } else if (done.stop === "max_tokens") console.error(paint(33, `The reply was cut off at the token limit (providers.${provider.name}.maxTokens).`));
}

for (const warning of loaded.warnings) console.error(paint(33, warning));
if (wantsVersion) console.log(`maquette ${version} (DesignCraft CLI ${pin.version} pinned)`);
else if (wantsHelp || command === "help") console.log(usage);
else if (!command || command === "serve") await serve();
else if (command === "call") await call(rest[0], rest.slice(1));
else if (command === "tools") await listTools(rest[0]);
else if (command === "example") console.log(copyExample(process.cwd()));
else if (command === "config") config(rest);
else if (command === "models") await listModels();
else if (command === "ask") await ask(rest);
else if (command === "install-designcraft") {
  if (existsSync(pinned) && !fromZip) console.log(`DesignCraft CLI ${pin.version} is already installed in ${tilde(home)}.`);
  else await install(fromZip);
} else fail(`Unknown command ${command}.\n\n${usage}`);
