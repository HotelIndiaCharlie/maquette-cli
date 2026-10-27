// The agent loop behind the prompt. One session holds the conversation, the permission mode
// and the provider; `submit` takes a typed line and does what it means, emitting events for
// whoever draws them. Model tool calls go through the server's queue like every other call.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { catalogue, describe, gist, parseCall, words, toArgs } from "../args.js";
import { imageType } from "../images.js";
import { createProvider, defaultModels } from "../providers/index.js";
import { ProviderError, textOf } from "../providers/types.js";
import { providerNames, write } from "../settings.js";
import { dollars, price } from "./cost.js";
import { decide, modeHelp, modes } from "./permissions.js";
import { systemPrompt } from "./prompt.js";
import { route, slashCommands } from "./route.js";
import { runShell } from "./shell.js";
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
  /tools                the tools, one line each`;
export class AgentSession {
    server;
    settings;
    provider;
    projectFile;
    history = [];
    mode;
    allowed = new Set();
    textProtocol = false;
    busy = false;
    totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, priced: 0, turns: 0 };
    #listeners = new Set();
    #abort;
    #interrupted = false;
    #pendingAnswer;
    #chain = Promise.resolve();
    #copyExample;
    constructor(options) {
        this.server = options.server;
        this.settings = options.settings;
        this.provider = options.provider ?? createProvider(options.settings);
        this.projectFile = options.projectFile;
        this.mode = options.settings.permissions.mode;
        this.#copyExample = options.copyExample;
    }
    on(listener) {
        this.#listeners.add(listener);
        return () => void this.#listeners.delete(listener);
    }
    emit(e) {
        for (const l of this.#listeners)
            l(e);
    }
    notice(text, level = "info") {
        this.emit({ type: "notice", text, level });
    }
    get status() {
        const { input, output, cacheRead, cacheWrite, cost, priced, turns } = this.totals;
        const effort = this.provider.name === "anthropic" ? this.settings.providers.anthropic.effort : undefined;
        return { provider: this.provider.name, model: this.provider.model || "(no model)", effort, mode: this.mode, tokens: { input, output, cacheRead, cacheWrite }, cost: priced ? cost : undefined, turns, textProtocol: this.textProtocol };
    }
    sendStatus() {
        this.emit({ type: "status", status: this.status });
    }
    // Lines run one after another; a line typed during a turn waits for it.
    submit(line) {
        const run = this.#chain.then(() => this.handle(line)).catch((e) => this.notice(e.message, "error"));
        this.#chain = run;
        return run;
    }
    // Ctrl-C during a turn: the model stops, a pending permission prompt is answered no, and the
    // calls not yet run are recorded as interrupted so the conversation stays well formed.
    interrupt() {
        if (!this.busy)
            return;
        this.#interrupted = true;
        this.#abort?.abort();
        this.#pendingAnswer?.("n");
    }
    async handle(line) {
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
    command(r) {
        const { byName, tools, root } = this.server;
        if (r.name === "help" && !r.rest)
            this.emit({ type: "output", text: promptHelp });
        else if (r.name === "help") {
            const tool = byName.get(r.rest);
            if (tool)
                this.emit({ type: "output", text: describe(tool) });
            else
                this.emit({ type: "output", text: `There's no tool "${r.rest}". Type tools for their names.`, ok: false });
        }
        else if (r.name === "tools")
            this.emit({ type: "output", text: catalogue(tools) });
        else if (r.name === "example")
            this.emit({ type: "output", text: this.#copyExample ? this.#copyExample(root) : "The example isn't available here." });
        else if (r.name === "open") {
            const last = this.server.lastImage();
            if (last)
                execFile("open", [last]);
            this.emit({ type: "output", text: last ? `Opening ${relative(root, last)}` : "No image yet; render_page --page 0 makes one." });
        }
    }
    // A tool the person typed: no permission prompt, since they asked for it themselves. The
    // model is told what happened, so it can go on from there.
    async directCall(name, rest) {
        const tool = this.server.byName.get(name);
        let args;
        try {
            args = parseCall(tool, rest, this.server.root);
        }
        catch (e) {
            return this.emit({ type: "output", text: e.message, ok: false });
        }
        this.busy = true;
        try {
            const reply = await this.server.enqueue(name, args, "prompt");
            this.emit({ type: "output", text: reply.text, ok: reply.ok, images: reply.images });
            const seen = `The person ran \`${name} ${rest.trim()}\` at the prompt; it ${reply.ok ? "returned" : "failed with"}: ${gist(reply.text, 2000)}${reply.images.map((p) => `\nimage: ${p}`).join("")}`;
            this.history.push({ role: "user", parts: [{ type: "text", text: seen }] });
        }
        finally {
            this.busy = false;
        }
    }
    async shell(command) {
        if (!command)
            return this.emit({ type: "output", text: "What command? !ls, for example.", ok: false });
        this.busy = true;
        this.#abort = new AbortController();
        try {
            const { output, code } = await runShell(command, this.server.root, { signal: this.#abort.signal });
            this.emit({ type: "shell", command, output, code });
            this.history.push({ role: "user", parts: [{ type: "text", text: `The person ran \`${command}\` in the shell, in ${this.server.root}${code === 0 ? "" : ` (exit code ${code ?? "none"})`}:\n${output || "(no output)"}` }] });
        }
        finally {
            this.busy = false;
            this.#abort = undefined;
        }
    }
    async slash(name, args) {
        const { settings } = this;
        if (name === "help")
            return this.emit({ type: "output", text: slashHelp });
        if (name === "tools")
            return this.emit({ type: "output", text: catalogue(this.server.tools) });
        if (name === "clear") {
            this.history = [];
            this.textProtocol = false;
            this.notice("New conversation. The totals in /cost are kept.");
            return this.sendStatus();
        }
        if (name === "cost") {
            const t = this.totals;
            const lines = [`${t.turns} turn${t.turns === 1 ? "" : "s"} with the model this session.`, `Tokens: ${t.input + t.cacheRead + t.cacheWrite} in (${t.cacheRead} read from cache, ${t.cacheWrite} written to it), ${t.output} out.`];
            if (t.priced)
                lines.push(`Cost: ${dollars(t.cost)}${t.priced < t.turns ? ` for the ${t.priced} turns whose model has a known price` : ""}.`);
            else if (t.turns)
                lines.push(`No price is known for ${this.provider.model}, so no dollars.`);
            return this.emit({ type: "output", text: lines.join("\n") });
        }
        if (name === "permissions") {
            if (!args)
                return this.emit({ type: "output", text: `Permission mode: ${this.mode} (${modeHelp[this.mode]}).\n/permissions ${modes.join("|")} changes it, for this folder.` });
            if (!modes.includes(args))
                return this.notice(`There's no permission mode "${args}"; the modes are ${modes.join(", ")}.`, "warn");
            this.mode = args;
            try {
                write(this.projectFile, "permissions.mode", this.mode);
                this.notice(`Permission mode: ${this.mode}, ${modeHelp[this.mode]}. Saved for this folder.`);
            }
            catch (e) {
                this.notice(`Permission mode: ${this.mode}, for this session; it couldn't be saved: ${e.message}`, "warn");
            }
            return this.sendStatus();
        }
        if (name === "model") {
            if (!args) {
                let list;
                try {
                    list = await this.provider.models();
                }
                catch (e) {
                    return this.notice(e.message, "error");
                }
                const marked = list.map((m) => `${m.id === this.provider.model ? "› " : "  "}${m.id}${m.name && m.name !== m.id ? `  ${m.name}` : ""}`);
                return this.emit({ type: "output", text: `${list.length} models from ${this.provider.name}:\n${marked.join("\n")}\n/model <id> switches.` });
            }
            return this.switchProvider({ ...settings, model: args });
        }
        if (name === "provider") {
            if (!args)
                return this.emit({ type: "output", text: `Provider: ${this.provider.name}, model ${this.provider.model || "(none set)"}.\n/provider ${providerNames.join("|")} switches.` });
            if (!providerNames.includes(args))
                return this.notice(`There's no provider "${args}"; the providers are ${providerNames.join(", ")}.`, "warn");
            // The model named in the settings belongs to the provider it was set for, so the new
            // provider starts on its own default.
            return this.switchProvider({ ...settings, provider: args, model: defaultModels[args] });
        }
        this.notice(`There's no /${name}. The slash commands are ${slashCommands.join(", ")}.`, "warn");
    }
    switchProvider(settings) {
        try {
            this.provider = createProvider(settings);
            this.settings = settings;
            this.textProtocol = false;
            this.notice(`Now using ${this.provider.model || "(no model set)"} from ${this.provider.name}.`);
        }
        catch (e) {
            this.notice(e.message, "error");
        }
        this.sendStatus();
    }
    toolSpecs() {
        const tools = this.mode === "plan" ? this.server.tools.filter((t) => decide("plan", t, this.allowed) !== "deny") : this.server.tools;
        return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    }
    system() {
        return systemPrompt({ root: this.server.root, instructions: this.server.instructions, tools: this.server.tools, mode: this.mode, textProtocol: this.textProtocol });
    }
    account(model, usage) {
        const t = this.totals;
        t.turns++;
        if (!usage)
            return;
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
    async turn(text) {
        this.history.push({ role: "user", parts: [{ type: "text", text }] });
        this.emit({ type: "user", text });
        this.busy = true;
        this.#interrupted = false;
        this.#abort = new AbortController();
        let interrupted = false;
        let stop;
        let usage;
        try {
            for (;;) {
                let done;
                let soFar = "";
                try {
                    for await (const event of this.provider.chat({ system: this.system(), messages: this.history, tools: this.textProtocol ? undefined : this.toolSpecs(), signal: this.#abort.signal })) {
                        if (event.type === "text") {
                            soFar += event.text;
                            this.emit(event);
                        }
                        else if (event.type === "notice")
                            this.notice(event.text, "warn");
                        else if (event.type === "tool_call")
                            this.emit({ type: "tool_call", id: event.call.id, name: event.call.name, input: event.call.input, source: "model" });
                        else
                            done = event;
                    }
                }
                catch (e) {
                    if (this.#interrupted || this.#abort.signal.aborted) {
                        if (soFar)
                            this.history.push({ role: "assistant", parts: [{ type: "text", text: soFar }] });
                        interrupted = true;
                        break;
                    }
                    if (!this.textProtocol && e instanceof ProviderError && /can't call tools/.test(e.message)) {
                        this.textProtocol = true;
                        this.notice(`${this.provider.model} can't call tools, so it will write \`maquette call\` lines instead, and Maquette asks before running each.`, "warn");
                        this.sendStatus();
                        continue;
                    }
                    this.notice(e.message, "error");
                    break;
                }
                if (!done)
                    break;
                this.history.push(done.message);
                this.account(done.model, done.usage);
                this.sendStatus();
                ({ stop, usage } = done);
                if (done.stop === "refusal")
                    this.notice(`The model declined to answer${done.detail ? `: ${done.detail}` : "."}`, "error");
                else if (done.stop === "max_tokens")
                    this.notice("The reply was cut off at the token limit.", "warn");
                const calls = this.textProtocol ? this.textCalls(textOf(done.message)) : done.message.parts.filter((p) => p.type === "tool_call");
                if (!calls.length)
                    break;
                const results = await this.runCalls(calls);
                if (this.textProtocol) {
                    const parts = results.flatMap((r) => [{ type: "text", text: `Result of \`maquette call ${r.name}\`:\n${r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")}` }, ...r.content.filter((c) => c.type === "image")]);
                    this.history.push({ role: "user", parts });
                }
                else
                    this.history.push({ role: "user", parts: results });
                if (this.#interrupted) {
                    interrupted = true;
                    break;
                }
            }
        }
        finally {
            this.busy = false;
            this.#abort = undefined;
            this.emit({ type: "done", stop, usage, interrupted });
            this.sendStatus();
        }
    }
    // `maquette call …` lines in a text-protocol answer, as tool calls.
    textCalls(text) {
        const calls = [];
        for (const [i, m] of [...text.matchAll(/^[ \t>`]*(?:maquette|mqt)\s+call\s+(.+?)\s*`*$/gm)].entries()) {
            const id = `text_${this.totals.turns}_${i}`;
            let tokens;
            try {
                tokens = words(m[1]);
            }
            catch (e) {
                calls.push({ type: "tool_call", id, name: "?", input: {}, error: `Couldn't read \`${m[1]}\`: ${e.message}` });
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
            }
            catch (e) {
                calls.push({ type: "tool_call", id, name, input: {}, error: `Couldn't read the arguments of \`${m[1]}\`: ${e.message}` });
            }
        }
        return calls;
    }
    // Runs the model's calls in order, each after its permission check, and gives back one
    // result per call. The permission prompt comes before the queue, so an HTTP caller never
    // waits on a y/n.
    async runCalls(calls) {
        const results = [];
        for (const call of calls) {
            if (this.textProtocol)
                this.emit({ type: "tool_call", id: call.id, name: call.name, input: call.input, source: "model" });
            const fail = (text) => {
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
                const answer = await new Promise((reply) => {
                    this.#pendingAnswer = reply;
                    this.emit({ type: "ask_permission", id: call.id, name: call.name, input: call.input, reply });
                });
                this.#pendingAnswer = undefined;
                if (answer === "a")
                    this.allowed.add(call.name);
                if (answer === "n") {
                    fail(this.#interrupted ? "Interrupted by the person before this ran." : "The person declined this call. Ask what they'd like instead, or go on without it.");
                    continue;
                }
            }
            const reply = await this.server.enqueue(call.name, call.input, "model");
            this.emit({ type: "tool_result", id: call.id, name: call.name, ok: reply.ok, text: reply.text, images: reply.images, ms: reply.ms });
            const content = [{ type: "text", text: `${reply.text}${reply.images.map((p) => `\nimage: ${p}`).join("")}` || "(no output)" }];
            for (const path of reply.images) {
                try {
                    const bytes = readFileSync(path);
                    const mediaType = imageType(bytes);
                    if (mediaType)
                        content.push({ type: "image", mediaType, data: bytes.toString("base64"), path });
                }
                catch { }
            }
            results.push({ type: "tool_result", id: call.id, name: call.name, content, isError: !reply.ok });
        }
        return results;
    }
}
