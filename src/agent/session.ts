// The agent loop behind the prompt. One session holds the conversation, the permission mode
// and the provider; `submit` takes a typed line and does what it means, emitting events for
// whoever draws them. Model tool calls go through the server's queue like every other call.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { catalogue, describe, gist, parseCall, type Tool, words, toArgs } from "../args.ts";
import { imageType } from "../images.ts";
import { createProvider, defaultModels } from "../providers/index.ts";
import { type ImagePart, type Message, type Provider, ProviderError, type SystemBlock, type TextPart, textOf, type ToolCallPart, type ToolResultPart, type ToolSpec, type Usage } from "../providers/types.ts";
import type { Reply, Source } from "../server.ts";
import { providerNames, type Settings, write } from "../settings.ts";
import { dollars, price } from "./cost.ts";
import type { AgentEvent, Choice, PermissionAnswer, Status } from "./events.ts";
import { decide, type Mode, modeHelp, modes } from "./permissions.ts";
import { projectInstructions, systemPrompt } from "./prompt.ts";
import { type Route, route, slashCommands } from "./route.ts";
import { runShell } from "./shell.ts";

// What the session needs from the running server: a fake stands in for it in tests.
export type ServerLike = {
  root: string;
  tools: Tool[];
  byName: Map<string, Tool>;
  instructions: string;
  lastImage(): string | undefined;
  enqueue(tool: string, args: Record<string, unknown>, source: Source): Promise<Reply>;
};

export type SessionOptions = {
  server: ServerLike;
  settings: Settings;
  provider?: Provider; // in place of the one the settings name, for tests
  projectFile: string; // the project's settings file, where /permissions persists the mode
  copyExample?: (root: string) => string;
};

const promptHelp = `Type a sentence and the model does the job, calling tools as it goes. Or type a tool's name and
its arguments as flags, to call it yourself:
  open_document example/annual-report.designcraft
  chart_create firstlight:slot:01 @example/specs/01-revenue.json
  render_page --page 0
Required arguments can go without their flag. @file reads JSON from a file. Paths are relative
to this folder. Quote values with spaces: --text "Two words".

  !<command>     run a shell command here; the model sees its output
  /help          the slash commands: /model, /provider, /permissions, /clear, /cost, /tools
  tools          the tools, one line each; help <tool> shows one tool's flags
  example        copy the example report into ./example/
  open           open the last image in Preview
  exit           stop Maquette (also Ctrl-D, or Ctrl-C on an empty line)

Keys: Tab completes tools, flags, /commands and paths; ↑ ↓ recall lines; shift+enter or \\ at the
end of a line adds a line; Ctrl-C stops the model's turn; ctrl+o expands the last tool line;
esc dismisses notices; ? on an empty line shows this.`;

const slashHelp = `  /help                 this list
  /model [id]           the model in use, or switch to another; alone, lists the provider's models
  /provider [name]      switch between ${providerNames.join(" and ")}
  /permissions [mode]   ${modes.map((m) => `${m}: ${modeHelp[m]}`).join("; ")}
  /clear                start a new conversation (the totals in /cost are kept)
  /cost                 tokens and, when the price is known, dollars this session
  /tools                the tools, one line each
  /init                 survey the document and write MAQUETTE.md (coming: for now, says what it will do)`;

// What /init says until it's built. The real /init replaces this constant.
const initStub = `/init isn't built yet. When it is, it will survey the open document, render its pages, ask what
the document is for and what may change, and write MAQUETTE.md: the project's design memory,
read into the model's instructions on every turn.
Until then, write MAQUETTE.md by hand in this folder, short: purpose and audience, voice, palette
and type by role, conventions, decisions, do and don't.`;
const initNeedsVision = "/init will need a model with vision to describe the look and feel; this one can't see images.";

export class AgentSession {
  server: ServerLike;
  settings: Settings;
  provider: Provider;
  projectFile: string;
  history: Message[] = [];
  mode: Mode;
  allowed = new Set<string>();
  textProtocol = false;
  busy = false;
  totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, priced: 0, turns: 0 };
  #listeners = new Set<(e: AgentEvent) => void>();
  #abort?: AbortController;
  #interrupted = false;
  #pendingAnswer?: (answer: PermissionAnswer) => void;
  #chain: Promise<unknown> = Promise.resolve();
  #copyExample?: (root: string) => string;
  // MAQUETTE.md as read for this turn, and as the model last had it (unset before the first
  // turn of a conversation), so a change between turns can be pointed out.
  #project: string | undefined;
  #sentProject?: { text: string | undefined };

  constructor(options: SessionOptions) {
    this.server = options.server;
    this.settings = options.settings;
    this.provider = options.provider ?? createProvider(options.settings);
    this.projectFile = options.projectFile;
    this.mode = options.settings.permissions.mode;
    this.#copyExample = options.copyExample;
  }

  on(listener: (e: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  emit(e: AgentEvent) {
    for (const l of this.#listeners) l(e);
  }

  notice(text: string, level: "info" | "warn" | "error" = "info") {
    this.emit({ type: "notice", text, level });
  }

  get status(): Status {
    const { input, output, cacheRead, cacheWrite, cost, priced, turns } = this.totals;
    const effort = this.provider.name === "anthropic" ? this.settings.providers.anthropic.effort : undefined;
    return { provider: this.provider.name, model: this.provider.model || "(no model)", effort, mode: this.mode, tokens: { input, output, cacheRead, cacheWrite }, cost: priced ? cost : undefined, turns, textProtocol: this.textProtocol };
  }

  sendStatus() {
    this.emit({ type: "status", status: this.status });
  }

  // Lines run one after another; a line typed during a turn waits for it.
  submit(line: string): Promise<void> {
    const run = this.#chain.then(() => this.handle(line)).catch((e) => this.notice((e as Error).message, "error"));
    this.#chain = run;
    return run;
  }

  // Ctrl-C during a turn: the model stops, a pending permission prompt is answered no, and the
  // calls not yet run are recorded as interrupted so the conversation stays well formed.
  interrupt() {
    if (!this.busy) return;
    this.#interrupted = true;
    this.#abort?.abort();
    this.#pendingAnswer?.("n");
  }

  async handle(line: string) {
    const r = route(line, (w) => this.server.byName.has(w));
    switch (r.kind) {
      case "empty":
        return;
      case "exit":
        return this.emit({ type: "exit" });
      case "command":
        return this.command(r);
      case "tool":
        return this.directCall(r.name, r.rest);
      case "shell":
        return this.shell(r.command);
      case "slash":
        return this.slash(r.name, r.args);
      case "message":
        return this.turn(r.text);
    }
  }

  command(r: Extract<Route, { kind: "command" }>) {
    const { byName, tools, root } = this.server;
    if (r.name === "help" && !r.rest) this.emit({ type: "output", text: promptHelp });
    else if (r.name === "help") {
      const tool = byName.get(r.rest);
      if (tool) this.emit({ type: "output", text: describe(tool) });
      else this.emit({ type: "output", text: `There's no tool "${r.rest}". Type tools for their names.`, ok: false });
    } else if (r.name === "tools") this.emit({ type: "output", text: catalogue(tools) });
    else if (r.name === "example") this.emit({ type: "output", text: this.#copyExample ? this.#copyExample(root) : "The example isn't available here." });
    else if (r.name === "open") {
      const last = this.server.lastImage();
      if (last) execFile("open", [last]);
      this.emit({ type: "output", text: last ? `Opening ${relative(root, last)}` : "No image yet; render_page --page 0 makes one." });
    }
  }

  // A tool the person typed: no permission prompt, since they asked for it themselves. The
  // model is told what happened, so it can go on from there.
  async directCall(name: string, rest: string) {
    const tool = this.server.byName.get(name)!;
    let args: Record<string, unknown>;
    try {
      args = parseCall(tool, rest, this.server.root);
    } catch (e) {
      return this.emit({ type: "output", text: (e as Error).message, ok: false });
    }
    this.busy = true;
    try {
      const reply = await this.server.enqueue(name, args, "prompt");
      this.emit({ type: "output", text: reply.text, ok: reply.ok, images: reply.images });
      const seen = `The person ran \`${name} ${rest.trim()}\` at the prompt; it ${reply.ok ? "returned" : "failed with"}: ${gist(reply.text, 2000)}${reply.images.map((p) => `\nimage: ${p}`).join("")}`;
      this.history.push({ role: "user", parts: [{ type: "text", text: seen }] });
    } finally {
      this.busy = false;
    }
  }

  async shell(command: string) {
    if (!command) return this.emit({ type: "output", text: "What command? !ls, for example.", ok: false });
    this.busy = true;
    this.#abort = new AbortController();
    try {
      const { output, code } = await runShell(command, this.server.root, { signal: this.#abort.signal });
      this.emit({ type: "shell", command, output, code });
      this.history.push({ role: "user", parts: [{ type: "text", text: `The person ran \`${command}\` in the shell, in ${this.server.root}${code === 0 ? "" : ` (exit code ${code ?? "none"})`}:\n${output || "(no output)"}` }] });
    } finally {
      this.busy = false;
      this.#abort = undefined;
    }
  }

  async slash(name: string, args: string) {
    const { settings } = this;
    if (name === "help") return this.emit({ type: "output", text: slashHelp });
    if (name === "tools") return this.emit({ type: "output", text: catalogue(this.server.tools) });
    if (name === "clear") {
      this.history = [];
      this.textProtocol = false;
      this.#sentProject = undefined;
      this.notice("New conversation. The totals in /cost are kept.");
      return this.sendStatus();
    }
    if (name === "cost") {
      const t = this.totals;
      const lines = [`${t.turns} turn${t.turns === 1 ? "" : "s"} with the model this session.`, `Tokens: ${t.input + t.cacheRead + t.cacheWrite} in (${t.cacheRead} read from cache, ${t.cacheWrite} written to it), ${t.output} out.`];
      if (t.priced) lines.push(`Cost: ${dollars(t.cost)}${t.priced < t.turns ? ` for the ${t.priced} turns whose model has a known price` : ""}.`);
      else if (t.turns) lines.push(`No price is known for ${this.provider.model}, so no dollars.`);
      return this.emit({ type: "output", text: lines.join("\n") });
    }
    if (name === "permissions") {
      if (!args) args = (await this.choose("Permission mode", modes.map((m) => ({ id: m, label: m, hint: modeHelp[m] })), this.mode)) ?? "";
      if (!args) return;
      if (!modes.includes(args as Mode)) return this.notice(`There's no permission mode "${args}"; the modes are ${modes.join(", ")}.`, "warn");
      this.mode = args as Mode;
      try {
        write(this.projectFile, "permissions.mode", this.mode);
        this.notice(`Permission mode: ${this.mode}, ${modeHelp[this.mode]}. Saved for this folder.`);
      } catch (e) {
        this.notice(`Permission mode: ${this.mode}, for this session; it couldn't be saved: ${(e as Error).message}`, "warn");
      }
      return this.sendStatus();
    }
    if (name === "model") {
      if (!args) {
        let list;
        try {
          list = await this.provider.models();
        } catch (e) {
          return this.notice((e as Error).message, "error");
        }
        args = (await this.choose(`Model, from ${this.provider.name}`, list.map((m) => ({ id: m.id, label: m.id, hint: m.name && m.name !== m.id ? m.name : undefined })), this.provider.model)) ?? "";
        if (!args) return;
      }
      return this.switchProvider({ ...settings, model: args });
    }
    if (name === "provider") {
      if (!args) args = (await this.choose("Provider", [{ id: "anthropic", label: "anthropic", hint: "Claude, through the Anthropic API" }, { id: "openai-compatible", label: "openai-compatible", hint: "Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, …" }], this.provider.name)) ?? "";
      if (!args) return;
      if (!providerNames.includes(args as Settings["provider"])) return this.notice(`There's no provider "${args}"; the providers are ${providerNames.join(", ")}.`, "warn");
      // The model named in the settings belongs to the provider it was set for, so the new
      // provider starts on its own default.
      return this.switchProvider({ ...settings, provider: args as Settings["provider"], model: defaultModels[args as Settings["provider"]] });
    }
    if (name === "init") {
      if (projectInstructions(this.server.root) !== undefined) return this.notice("MAQUETTE.md exists. /init will update it in a later release; edit it by hand for now.");
      return this.emit({ type: "output", text: this.provider.vision ? initStub : `${initStub}\n${initNeedsVision}` });
    }
    this.notice(`There's no /${name}. The slash commands are ${slashCommands.join(", ")}.`, "warn");
  }

  // A list to pick from. The screen answers it; with no screen listening, the first option
  // that is current stays and nothing changes.
  choose(title: string, options: Choice[], current?: string): Promise<string | null> {
    if (!this.#listeners.size) return Promise.resolve(null);
    return new Promise((reply) => this.emit({ type: "choose", title, options, current, reply }));
  }

  switchProvider(settings: Settings) {
    try {
      this.provider = createProvider(settings);
      this.settings = settings;
      this.textProtocol = false;
      this.notice(`Now using ${this.provider.model || "(no model set)"} from ${this.provider.name}.`);
    } catch (e) {
      this.notice((e as Error).message, "error");
    }
    this.sendStatus();
  }

  toolSpecs(): ToolSpec[] {
    const tools = this.mode === "plan" ? this.server.tools.filter((t) => decide("plan", t, this.allowed) !== "deny") : this.server.tools;
    return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));
  }

  system(): SystemBlock[] {
    return systemPrompt({ root: this.server.root, instructions: this.server.instructions, tools: this.server.tools, mode: this.mode, textProtocol: this.textProtocol, project: this.#project });
  }

  // Reads MAQUETTE.md for this turn. A change since the model last had it, deletion included,
  // gets a notice on the screen and a line in front of the person's message: a system block
  // that changes silently in turn forty is easy to miss.
  readProject(): TextPart[] {
    this.#project = projectInstructions(this.server.root);
    const before = this.#sentProject;
    this.#sentProject = { text: this.#project };
    if (!before || before.text === this.#project) return [];
    this.notice(this.#project === undefined ? "MAQUETTE.md was removed; the model no longer has it." : "MAQUETTE.md changed; the model has the new version.");
    return [{ type: "text", text: this.#project === undefined ? "MAQUETTE.md was removed since your last turn; this project has no design memory now." : "MAQUETTE.md changed since your last turn; the new version is in your instructions." }];
  }

  account(model: string, usage?: Usage) {
    const t = this.totals;
    t.turns++;
    if (!usage) return;
    t.input += usage.input;
    t.output += usage.output;
    t.cacheRead += usage.cacheRead ?? 0;
    t.cacheWrite += usage.cacheWrite ?? 0;
    const p = price(model, usage);
    if (p !== undefined) {
      t.cost += p;
      t.priced++;
    }
  }

  // A sentence for the model: the loop of asking, running its calls and sending back the
  // results, until it answers without calling anything.
  async turn(text: string) {
    this.history.push({ role: "user", parts: [...this.readProject(), { type: "text", text }] });
    this.emit({ type: "user", text });
    this.busy = true;
    this.#interrupted = false;
    this.#abort = new AbortController();
    let interrupted = false;
    let stop;
    let usage: Usage | undefined;
    try {
      for (;;) {
        let done;
        let soFar = "";
        try {
          for await (const event of this.provider.chat({ system: this.system(), messages: this.history, tools: this.textProtocol ? undefined : this.toolSpecs(), signal: this.#abort.signal })) {
            if (event.type === "text") {
              soFar += event.text;
              this.emit(event);
            } else if (event.type === "notice") this.notice(event.text, "warn");
            else if (event.type === "tool_call") this.emit({ type: "tool_call", id: event.call.id, name: event.call.name, input: event.call.input, source: "model" });
            else done = event;
          }
        } catch (e) {
          if (this.#interrupted || this.#abort.signal.aborted) {
            if (soFar) this.history.push({ role: "assistant", parts: [{ type: "text", text: soFar }] });
            interrupted = true;
            break;
          }
          if (!this.textProtocol && e instanceof ProviderError && /can't call tools/.test(e.message)) {
            this.textProtocol = true;
            this.notice(`${this.provider.model} can't call tools, so it will write \`maquette call\` lines instead, and Maquette asks before running each.`, "warn");
            this.sendStatus();
            continue;
          }
          this.notice((e as Error).message, "error");
          break;
        }
        if (!done) break;
        this.history.push(done.message);
        this.account(done.model, done.usage);
        this.sendStatus();
        ({ stop, usage } = done);
        if (done.stop === "refusal") this.notice(`The model declined to answer${done.detail ? `: ${done.detail}` : "."}`, "error");
        else if (done.stop === "max_tokens") this.notice("The reply was cut off at the token limit.", "warn");
        const calls = this.textProtocol ? this.textCalls(textOf(done.message)) : done.message.parts.filter((p): p is ToolCallPart => p.type === "tool_call");
        if (!calls.length) break;
        const results = await this.runCalls(calls);
        if (this.textProtocol) {
          const parts = results.flatMap((r) => [{ type: "text", text: `Result of \`maquette call ${r.name}\`:\n${r.content.filter((c) => c.type === "text").map((c) => (c as TextPart).text).join("\n")}` } as TextPart, ...r.content.filter((c): c is ImagePart => c.type === "image")]);
          this.history.push({ role: "user", parts });
        } else this.history.push({ role: "user", parts: results });
        if (this.#interrupted) {
          interrupted = true;
          break;
        }
      }
    } finally {
      this.busy = false;
      this.#abort = undefined;
      this.emit({ type: "done", stop, usage, interrupted });
      this.sendStatus();
    }
  }

  // `maquette call …` lines in a text-protocol answer, as tool calls.
  textCalls(text: string): ToolCallPart[] {
    const calls: ToolCallPart[] = [];
    for (const [i, m] of [...text.matchAll(/^[ \t>`]*(?:maquette|mqt)\s+call\s+(.+?)\s*`*$/gm)].entries()) {
      const id = `text_${this.totals.turns}_${i}`;
      let tokens: string[];
      try {
        tokens = words(m[1]);
      } catch (e) {
        calls.push({ type: "tool_call", id, name: "?", input: {}, error: `Couldn't read \`${m[1]}\`: ${(e as Error).message}` });
        continue;
      }
      const [name, ...rest] = tokens;
      const tool = this.server.byName.get(name);
      if (!tool) {
        calls.push({ type: "tool_call", id, name, input: {}, error: `There's no tool "${name}".` });
        continue;
      }
      try {
        calls.push({ type: "tool_call", id, name, input: toArgs(tool, rest, this.server.root) });
      } catch (e) {
        calls.push({ type: "tool_call", id, name, input: {}, error: `Couldn't read the arguments of \`${m[1]}\`: ${(e as Error).message}` });
      }
    }
    return calls;
  }

  // Runs the model's calls in order, each after its permission check, and gives back one
  // result per call. The permission prompt comes before the queue, so an HTTP caller never
  // waits on a y/n.
  async runCalls(calls: ToolCallPart[]): Promise<ToolResultPart[]> {
    const results: ToolResultPart[] = [];
    for (const call of calls) {
      if (this.textProtocol) this.emit({ type: "tool_call", id: call.id, name: call.name, input: call.input, source: "model" });
      const fail = (text: string) => {
        this.emit({ type: "tool_result", id: call.id, name: call.name, ok: false, text, images: [], ms: 0 });
        results.push({ type: "tool_result", id: call.id, name: call.name, content: [{ type: "text", text }], isError: true });
      };
      if (this.#interrupted) {
        fail("Interrupted by the person before this ran.");
        continue;
      }
      if (call.error) {
        fail(call.error);
        continue;
      }
      const tool = this.server.byName.get(call.name);
      if (!tool) {
        fail(`There's no tool "${call.name}".`);
        continue;
      }
      const decision = this.textProtocol ? "ask" : decide(this.mode, tool, this.allowed);
      if (decision === "deny") {
        fail("Plan mode: this call would change something, so it wasn't run. Describe it in your plan instead.");
        continue;
      }
      if (decision === "ask") {
        const answer = await new Promise<PermissionAnswer>((reply) => {
          this.#pendingAnswer = reply;
          this.emit({ type: "ask_permission", id: call.id, name: call.name, input: call.input, reply });
        });
        this.#pendingAnswer = undefined;
        if (answer === "a") this.allowed.add(call.name);
        if (answer === "n") {
          fail(this.#interrupted ? "Interrupted by the person before this ran." : "The person declined this call. Ask what they'd like instead, or go on without it.");
          continue;
        }
      }
      const reply = await this.server.enqueue(call.name, call.input, "model");
      this.emit({ type: "tool_result", id: call.id, name: call.name, ok: reply.ok, text: reply.text, images: reply.images, ms: reply.ms });
      const content: (TextPart | ImagePart)[] = [{ type: "text", text: `${reply.text}${reply.images.map((p) => `\nimage: ${p}`).join("")}` || "(no output)" }];
      for (const path of reply.images) {
        try {
          const bytes = readFileSync(path);
          const mediaType = imageType(bytes);
          if (mediaType) content.push({ type: "image", mediaType, data: bytes.toString("base64"), path });
        } catch {}
      }
      results.push({ type: "tool_result", id: call.id, name: call.name, content, isError: !reply.ok });
    }
    return results;
  }
}
