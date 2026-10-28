// The agent loop, routing and permissions, against the fake provider and a fake server: no
// screen, no key, no DesignCraft.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEvent } from "../../src/agent/events.ts";
import { classify, decide } from "../../src/agent/permissions.ts";
import { route } from "../../src/agent/route.ts";
import { AgentSession } from "../../src/agent/session.ts";
import { toAnthropic } from "../../src/providers/anthropic.ts";
import { FakeProvider, type FakeTurn } from "../../src/providers/fake.ts";
import { type ChatEvent, type ChatRequest, ProviderError, systemText, type ToolResultPart } from "../../src/providers/types.ts";
import { fakeServer, settings } from "./fake-server.ts";

function session(turns: FakeTurn[], more: { mode?: "ask" | "auto" | "plan"; answer?: (name: string) => "y" | "n" | "a" } = {}) {
  const server = fakeServer();
  const provider = new FakeProvider(turns);
  const base = mkdtempSync(join(tmpdir(), "maquette-settings-"));
  const s = new AgentSession({ server, provider, settings: settings({ permissions: { mode: more.mode ?? "ask" } }), projectFile: join(base, ".maquette", "settings.json") });
  const events: AgentEvent[] = [];
  s.on((e) => {
    events.push(e);
    if (e.type === "ask_permission") e.reply(more.answer?.(e.name) ?? "y");
  });
  return { s, server, provider, events, projectFile: join(base, ".maquette", "settings.json") };
}

const names = (events: AgentEvent[], type: AgentEvent["type"]) => events.filter((e) => e.type === type);

test("a sentence runs the model's calls through the queue, sends back the results with the render as an image, and ends with the answer", async () => {
  const { s, server, provider, events } = session([{ text: "Opening it. ", calls: [{ name: "open_document", input: { path: "example/report.designcraft" } }, { name: "render_page", input: { page: 0 } }] }, { text: "Page one is rendered." }]);
  await s.submit("open the example report and show me page one");
  assert.deepEqual(server.calls.map((c) => [c.tool, c.source]), [["open_document", "model"], ["render_page", "model"]]);
  assert.deepEqual(names(events, "tool_call").map((e) => (e as { name: string }).name), ["open_document", "render_page"]);
  assert.deepEqual(names(events, "ask_permission").map((e) => (e as { name: string }).name), ["open_document"], "opening asks; the render doesn't");
  assert.equal(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join(""), "Opening it. Page one is rendered.");
  const done = events.at(-2);
  assert.equal(done?.type, "done");
  // The second request carries the results, the render as an image.
  assert.equal(provider.requests.length, 2);
  const results = provider.requests[1].messages.at(-1)!.parts as ToolResultPart[];
  assert.equal(results[1].name, "render_page");
  assert.ok(results[1].content.some((c) => c.type === "image" && c.mediaType === "image/png"));
  assert.match((results[1].content[0] as { text: string }).text, /image: .*002-render_page.png/);
  assert.match(systemText(provider.requests[0].system), /Maquette runs in/);
  assert.equal(provider.requests[0].tools?.length, 5);
  assert.equal(s.history.length, 4);
  assert.equal(s.busy, false);
});

test("routing: tools, prompt commands, slash commands, shell lines and sentences", () => {
  const isTool = (w: string) => w === "render_page";
  assert.deepEqual(route("render_page --page 0", isTool), { kind: "tool", name: "render_page", rest: "--page 0" });
  assert.deepEqual(route("  help chart_create ", isTool), { kind: "command", name: "help", rest: "chart_create" });
  assert.deepEqual(route("/permissions auto", isTool), { kind: "slash", name: "permissions", args: "auto" });
  assert.deepEqual(route("!ls example", isTool), { kind: "shell", command: "ls example" });
  assert.deepEqual(route("render the first page please", isTool), { kind: "message", text: "render the first page please" });
  assert.deepEqual(route("", isTool), { kind: "empty" });
  assert.deepEqual(route("exit", isTool), { kind: "exit" });
});

test("permissions: reads run, changes ask in ask mode, auto runs all, plan denies changes; the engine's readOnlyHint wins", () => {
  const render = { name: "render_page" };
  const create = { name: "chart_create" };
  assert.equal(classify(render), "read");
  assert.equal(classify(create), "change");
  assert.equal(classify({ name: "weird_tool", annotations: { readOnlyHint: true } }), "read");
  assert.equal(classify({ name: "inspect_document", annotations: { readOnlyHint: false } }), "change");
  const none = new Set<string>();
  assert.equal(decide("ask", render, none), "run");
  assert.equal(decide("ask", create, none), "ask");
  assert.equal(decide("ask", create, new Set(["chart_create"])), "run");
  assert.equal(decide("auto", create, none), "run");
  assert.equal(decide("plan", create, none), "deny");
  assert.equal(decide("plan", render, none), "run");
});

test("in ask mode a change asks: y runs it, n sends the model an error, a stops asking for that tool", async () => {
  const answers: Record<string, "y" | "n" | "a"> = { chart_create: "n", save_document: "a" };
  const { s, server, provider, events } = session(
    [
      { calls: [{ name: "chart_create", input: { frame: "slot:01", spec: {} } }] },
      { calls: [{ name: "save_document", input: {} }] },
      { calls: [{ name: "save_document", input: {} }] },
      { text: "Saved twice." },
    ],
    { answer: (name) => answers[name] },
  );
  await s.submit("make the chart and save");
  assert.deepEqual(names(events, "ask_permission").map((e) => (e as { name: string }).name), ["chart_create", "save_document"]);
  assert.deepEqual(server.calls.map((c) => c.tool), ["save_document", "save_document"]);
  const declined = provider.requests[1].messages.at(-1)!.parts[0] as ToolResultPart;
  assert.equal(declined.isError, true);
  assert.match((declined.content[0] as { text: string }).text, /declined/);
  assert.ok(s.allowed.has("save_document"));
});

test("auto mode never asks; plan mode offers only reading tools and refuses a change", async () => {
  const auto = session([{ calls: [{ name: "chart_create", input: { frame: "slot:01", spec: {} } }] }, { text: "Done." }], { mode: "auto" });
  await auto.s.submit("make the chart");
  assert.equal(names(auto.events, "ask_permission").length, 0);
  assert.equal(auto.server.calls.length, 1);

  const plan = session([{ calls: [{ name: "inspect_document", input: {} }, { name: "chart_create", input: { frame: "slot:01", spec: {} } }] }, { text: "Here is the plan." }], { mode: "plan" });
  await plan.s.submit("make the chart");
  assert.deepEqual(plan.provider.requests[0].tools?.map((t) => t.name), ["inspect_document", "render_page"]);
  assert.match(systemText(plan.provider.requests[0].system), /Plan mode/);
  assert.deepEqual(plan.server.calls.map((c) => c.tool), ["inspect_document"]);
  const refused = plan.provider.requests[1].messages.at(-1)!.parts[1] as ToolResultPart;
  assert.match((refused.content[0] as { text: string }).text, /Plan mode/);
});

test("a tool line typed by the person runs at once, in any mode, and the model is told", async () => {
  const { s, server, events } = session([], { mode: "plan" });
  await s.submit("chart_create slot:01 {}");
  assert.deepEqual(server.calls.map((c) => [c.tool, c.source]), [["chart_create", "prompt"]]);
  const out = names(events, "output")[0] as { text: string; images: string[] };
  assert.match(out.text, /Chart drawn/);
  assert.equal(out.images.length, 1);
  assert.match((s.history[0].parts[0] as { text: string }).text, /The person ran `chart_create slot:01 \{\}`/);
  await s.submit("render_page --page x");
  assert.match((names(events, "output").at(-1) as { text: string }).text, /isn't a number/);
});

test("a ! line runs in Maquette's folder and its output goes into the conversation", async () => {
  const { s, server, events, provider } = session([{ text: "It has a file." }]);
  await s.submit("!echo hello from $PWD; exit 3");
  const shell = names(events, "shell")[0] as { command: string; output: string; code: number };
  assert.equal(shell.output, `hello from ${server.root}`);
  assert.equal(shell.code, 3);
  await s.submit("what did that print?");
  assert.match((provider.requests[0].messages[0].parts[0] as { text: string }).text, /ran `echo hello.*\(exit code 3\):\nhello from/s);
});

test("Ctrl-C mid-stream stops the turn and leaves the history well formed", async () => {
  class Slow extends FakeProvider {
    override async *chat(request: ChatRequest): AsyncIterable<ChatEvent> {
      yield { type: "text", text: "Let me " };
      await new Promise((_, reject) => request.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
  }
  const server = fakeServer();
  const s = new AgentSession({ server, provider: new Slow([]), settings: settings(), projectFile: "/nonexistent/settings.json" });
  const events: AgentEvent[] = [];
  s.on((e) => {
    events.push(e);
    if (e.type === "text") setTimeout(() => s.interrupt(), 5);
  });
  await s.submit("tell me a long story");
  const done = names(events, "done")[0] as { interrupted: boolean };
  assert.equal(done.interrupted, true);
  assert.equal(s.busy, false);
  assert.deepEqual(s.history.map((m) => m.role), ["user", "assistant"]);
  assert.equal((s.history[1].parts[0] as { text: string }).text, "Let me ");
  assert.doesNotThrow(() => toAnthropic([...s.history, { role: "user", parts: [{ type: "text", text: "go on" }] }]));
});

test("Ctrl-C while the model's calls run: the rest are recorded as interrupted, so every call has a result", async () => {
  const { s, server, events } = session([{ calls: [{ name: "render_page", input: { page: 0 } }, { name: "render_page", input: { page: 1 } }, { name: "render_page", input: { page: 2 } }] }, { text: "unreachable" }]);
  s.on((e) => {
    if (e.type === "tool_result") s.interrupt();
  });
  await s.submit("render every page");
  assert.equal(server.calls.length, 1);
  const results = s.history.at(-1)!.parts as ToolResultPart[];
  assert.equal(results.length, 3);
  assert.match((results[2].content[0] as { text: string }).text, /Interrupted/);
  assert.equal((names(events, "done")[0] as { interrupted: boolean }).interrupted, true);
  assert.doesNotThrow(() => toAnthropic(s.history));
});

test("a model that can't call tools falls back to `maquette call` lines, which are run after asking", async () => {
  class NoTools extends FakeProvider {
    override async *chat(request: ChatRequest): AsyncIterable<ChatEvent> {
      if (request.tools) throw new ProviderError("qwen can't call tools, which Maquette needs (400).");
      yield* super.chat(request);
    }
  }
  const server = fakeServer();
  const provider = new NoTools([{ text: "I'll render it:\n```\nmaquette call render_page --page 0\n```\nThen look." }, { text: "Page one looks fine." }]);
  const s = new AgentSession({ server, provider, settings: settings(), projectFile: "/nonexistent/settings.json" });
  const events: AgentEvent[] = [];
  s.on((e) => {
    events.push(e);
    if (e.type === "ask_permission") e.reply("y");
  });
  await s.submit("show me page one");
  assert.equal(s.textProtocol, true);
  assert.ok(names(events, "notice").some((e) => /can't call tools/.test((e as { text: string }).text)));
  assert.equal(provider.requests[0].tools, undefined);
  assert.match(systemText(provider.requests[0].system), /maquette call <tool> --flag value/);
  assert.deepEqual(names(events, "ask_permission").map((e) => (e as { name: string }).name), ["render_page"], "the text protocol always asks, even for a render");
  assert.deepEqual(server.calls.map((c) => c.tool), ["render_page"]);
  const back = provider.requests[1].messages.at(-1)!;
  assert.match((back.parts[0] as { text: string }).text, /Result of `maquette call render_page`:\nRendered page 0\./);
  assert.equal(back.parts[1].type, "image");
  assert.equal(s.status.textProtocol, true);
});

test("/permissions persists to the project file, /model and /provider switch, /clear and /cost report", async () => {
  const { s, events, projectFile } = session([{ text: "hi" }]);
  await s.submit("/permissions auto");
  assert.equal(s.mode, "auto");
  assert.deepEqual(JSON.parse(readFileSync(projectFile, "utf8")), { permissions: { mode: "auto" } });
  await s.submit("/permissions sideways");
  assert.match((names(events, "notice").at(-1) as { text: string }).text, /no permission mode "sideways"/);
  await s.submit("hello");
  assert.equal(s.history.length, 2);
  await s.submit("/clear");
  assert.equal(s.history.length, 0);
  await s.submit("/cost");
  assert.match((names(events, "output").at(-1) as { text: string }).text, /1 turn with the model/);
  await s.submit("/model claude-sonnet-5-5");
  assert.equal(s.provider.name, "anthropic");
  assert.equal(s.provider.model, "claude-sonnet-5-5");
  assert.equal(s.status.effort, "high");
  await s.submit("/provider openai-compatible");
  assert.equal(s.provider.name, "openai-compatible");
  assert.equal(s.status.effort, undefined);
  await s.submit("/nope");
  assert.match((names(events, "notice").at(-1) as { text: string }).text, /no \/nope/);
  await s.submit("/help");
  assert.match((names(events, "output").at(-1) as { text: string }).text, /\/permissions/);
  assert.ok(!existsSync(join(projectFile, "..", "nothing")));
});

test("MAQUETTE.md in the folder goes into the model's instructions; /init is a stub that touches nothing", async () => {
  const { s, server, provider, events } = session([{ text: "ok" }, { text: "ok" }]);
  await s.submit("/init");
  const stub = names(events, "output").at(-1) as { text: string };
  assert.match(stub.text, /MAQUETTE\.md/);
  assert.match(stub.text, /isn't built yet/);
  assert.doesNotMatch(stub.text, /vision/, "the fake provider can see");
  assert.equal(server.calls.length, 0);
  assert.ok(!existsSync(join(server.root, "MAQUETTE.md")));
  await s.submit("hello");
  assert.doesNotMatch(systemText(provider.requests[0].system), /MAQUETTE\.md, as the person keeps it/);

  writeFileSync(join(server.root, "MAQUETTE.md"), "# Annual report\nVoice: plain and warm. Palette: process inks.\n");
  await s.submit("/init");
  assert.match((names(events, "notice").at(-1) as { text: string }).text, /MAQUETTE\.md exists/);
  assert.equal(server.calls.length, 0);
  await s.submit("again");
  assert.match(systemText(provider.requests[1].system), /MAQUETTE\.md, as the person keeps it:\n~~~markdown\n# Annual report\nVoice: plain and warm\. Palette: process inks\.\n~~~$/);

  // Without vision, the stub says /init will need it.
  const blind = session([]);
  Object.defineProperty(blind.provider, "vision", { value: false });
  await blind.s.submit("/init");
  assert.match((names(blind.events, "output").at(-1) as { text: string }).text, /need a model with vision/);
});

test("the instructions are three blocks: the same core everywhere, the session's environment, and the project last and uncached", async () => {
  const a = session([{ text: "ok" }]);
  const b = session([{ text: "ok" }], { mode: "plan" });
  writeFileSync(join(b.server.root, "MAQUETTE.md"), "Charts use the Chart styles only.\n");
  await a.s.submit("hello");
  await b.s.submit("hello");
  const [first, second] = [a.provider.requests[0].system, b.provider.requests[0].system];
  assert.deepEqual(first.map((x) => [x.name, Boolean(x.cache)]), [["core", true], ["environment", true], ["project", false]]);
  assert.deepEqual(second.map((x) => x.name), ["core", "environment", "project"]);
  assert.equal(first[0].text, second[0].text, "the core is the same in two folders");
  assert.notEqual(a.server.root, b.server.root);
  assert.match(first[1].text, new RegExp(`Maquette runs DesignCraft headless in ${a.server.root}`));
  assert.match(first[1].text, /The engine's instructions:\n\nStub instructions\./);
  assert.doesNotMatch(first[1].text, /Plan mode/);
  assert.match(second[1].text, /Plan mode/);
  assert.match(first[2].text, /no design memory yet.*\/init/s);
  assert.doesNotMatch(first[2].text, /Follow it over your own defaults/);
  assert.match(second[2].text, /Follow it over your own defaults/);
  assert.match(second[2].text, /Charts use the Chart styles only\./);
  assert.doesNotMatch(first[0].text, /\/tmp|maquette-agent-/, "nothing about the session in the core");
});

test("MAQUETTE.md edited or removed between turns: the model gets the new text, the screen a notice, the message a line in front", async () => {
  const { s, server, provider, events } = session([{ text: "ok" }, { text: "ok" }, { text: "ok" }, { text: "ok" }]);
  const file = join(server.root, "MAQUETTE.md");
  writeFileSync(file, "Palette: emphasis is Brand Red.\n");
  await s.submit("first");
  assert.equal(names(events, "notice").length, 0, "the first turn never says it changed");
  assert.equal(provider.requests[0].messages[0].parts.length, 1);
  await s.submit("second");
  assert.equal(names(events, "notice").length, 0, "unchanged, so nothing to say");
  writeFileSync(file, "Palette: emphasis is Brand Teal.\n");
  await s.submit("third");
  assert.match(provider.requests[2].system.at(-1)!.text, /Brand Teal/);
  assert.equal((names(events, "notice").at(-1) as { text: string }).text, "MAQUETTE.md changed; the model has the new version.");
  const third = provider.requests[2].messages.at(-1)!.parts as { text: string }[];
  assert.equal(third[0].text, "MAQUETTE.md changed since your last turn; the new version is in your instructions.");
  assert.equal(third[1].text, "third");
  rmSync(file);
  await s.submit("fourth");
  assert.match(provider.requests[3].system.at(-1)!.text, /no design memory yet/);
  assert.match((names(events, "notice").at(-1) as { text: string }).text, /MAQUETTE\.md was removed/);
  assert.match((provider.requests[3].messages.at(-1)!.parts[0] as { text: string }).text, /removed since your last turn/);
  assert.equal(names(events, "user").length, 4);
  assert.equal((names(events, "user").at(-1) as { text: string }).text, "fourth", "the transcript shows what the person typed");
});
