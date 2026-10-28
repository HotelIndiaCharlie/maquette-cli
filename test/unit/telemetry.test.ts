// The trace a turn leaves, against the fake provider and server, collected in memory: no
// Phoenix, no network.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { AgentSession } from "../../src/agent/session.ts";
import { FakeProvider, type FakeTurn } from "../../src/providers/fake.ts";
import { template } from "../../src/agent/prompts.ts";
import { endpointOf, gitCommit } from "../../src/telemetry/index.ts";
import { ensurePhoenix, type Run } from "../../src/telemetry/phoenix.ts";
import { messageAttributes, Tracing } from "../../src/telemetry/spans.ts";
import { startLines } from "../../src/ui/app.ts";
import { fakeServer, settings } from "./fake-server.ts";

function traced(turns: FakeTurn[], answer: (name: string) => "y" | "n" = () => "y") {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanLimits: { attributeCountLimit: 10_000 }, spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const tracing = new Tracing(provider.getTracer("test"), "session-1");
  const server = fakeServer();
  const session = new AgentSession({ server, provider: new FakeProvider(turns), settings: settings(), projectFile: join(mkdtempSync(join(tmpdir(), "maquette-settings-")), "settings.json") });
  session.on((e) => {
    tracing.onAgent(e);
    if (e.type === "ask_permission") e.reply(answer(e.name));
  });
  server.on((e) => tracing.onServer(e));
  const spans = () => exporter.getFinishedSpans();
  const named = (name: string) => spans().filter((s) => s.name === name);
  return { session, server, spans, named, tracing };
}

const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId;

test("a turn is one trace: the turn, a span per request to the model with its input, output and thinking, and a span per tool call", async () => {
  const { session, spans, named } = traced([{ text: "Opening it. ", thinking: "Open first, then render.", calls: [{ name: "open_document", input: { path: "example/report.designcraft" } }, { name: "render_page", input: { page: 0 } }] }, { text: "Done." }]);
  await session.submit("open the report and show me page one");

  const [turn] = named("turn");
  assert.equal(turn.attributes["openinference.span.kind"], "AGENT");
  assert.equal(turn.attributes["input.value"], "open the report and show me page one");
  assert.equal(turn.attributes["output.value"], "Opening it. Done.");
  assert.equal(turn.attributes["session.id"], "session-1");
  assert.equal(turn.attributes["maquette.steps"], 2);
  assert.equal(turn.attributes["maquette.tool_calls"], 2);
  assert.equal(turn.status.code, SpanStatusCode.UNSET);
  assert.ok(spans().every((s) => s.spanContext().traceId === turn.spanContext().traceId), "everything is in the turn's trace");

  const llm = named("llm fake");
  assert.equal(llm.length, 2);
  assert.ok(llm.every((s) => parentOf(s) === turn.spanContext().spanId));
  const [first, second] = llm;
  assert.equal(first.attributes["openinference.span.kind"], "LLM");
  assert.equal(first.attributes["llm.input_messages.0.message.role"], "system");
  assert.equal(first.attributes["llm.input_messages.1.message.content"], "open the report and show me page one");
  assert.match(String(first.attributes["llm.tools.0.tool.json_schema"]), /open_document/);
  assert.equal(first.attributes["llm.output_messages.0.message.tool_calls.1.tool_call.function.name"], "render_page");
  assert.equal(first.attributes["maquette.thinking"], "Open first, then render.");
  assert.equal(JSON.parse(String(first.attributes["output.value"])).thinking, "Open first, then render.");
  // The second request carries the results: the render goes in as its path, never its bytes.
  assert.equal(second.attributes["llm.input_messages.3.message.role"], "tool");
  assert.match(String(second.attributes["llm.input_messages.4.message.content"]), /^Rendered page 0\.\nimage: .*002-render_page\.png\n\[image .*002-render_page\.png\]$/);
  assert.ok(!Object.values(second.attributes).some((v) => String(v).includes("iVBOR")), "no image data in the trace");

  // Which prompts the request was built from, and their versions.
  assert.match(String(first.attributes["llm.prompt_template.version"]), /^[0-9a-f]{8}$/);
  assert.equal(first.attributes["maquette.prompt.core.version"], template("core").version);
  assert.deepEqual(first.attributes["maquette.prompt.environment.files"], ["prompts/environment.md", "prompts/engine.md"]);
  assert.ok(String(first.attributes["llm.prompt_template.template"]).includes("{{root}}"), "the template, before it's filled");
  assert.match(String(first.attributes["llm.prompt_template.variables"]), /"root":"\//);
  assert.equal(first.attributes["llm.prompt_template.version"], second.attributes["llm.prompt_template.version"]);

  const [thinking] = named("thinking");
  assert.equal(parentOf(thinking), first.spanContext().spanId);
  assert.equal(thinking.attributes["output.value"], "Open first, then render.");

  const [open] = named("tool open_document");
  assert.equal(parentOf(open), turn.spanContext().spanId);
  assert.equal(open.attributes["openinference.span.kind"], "TOOL");
  assert.equal(open.attributes["input.value"], '{"path":"example/report.designcraft"}');
  assert.equal(open.attributes["output.value"], "Opened example/report.designcraft.");
  assert.equal(open.attributes["maquette.permission"], "y");
  const phases = spans().filter((s) => parentOf(s) === open.spanContext().spanId).map((s) => s.name);
  assert.ok(phases.includes("permission") && phases.includes("engine"), `the call's time is split: ${phases}`);
  assert.equal(named("tool render_page")[0].attributes["maquette.permission"], "allowed");
});

test("failures are marked with their reason, and the turn says which happened", async () => {
  const { session, named } = traced(
    [{ calls: [{ name: "no_such_tool" }, { name: "open_document", input: { path: "a.designcraft" } }, { name: "chart_bad" }] }, { text: "Sorry.", stop: "max_tokens" }],
    () => "n",
  );
  await session.submit("do it");
  const reasons = Object.fromEntries(named("tool no_such_tool").concat(named("tool open_document"), named("tool chart_bad")).map((s) => [s.name, [s.attributes["maquette.failure"], s.status.code]]));
  assert.deepEqual(reasons, { "tool no_such_tool": ["model.unknown_tool", SpanStatusCode.ERROR], "tool open_document": ["user.declined", SpanStatusCode.ERROR], "tool chart_bad": ["model.unknown_tool", SpanStatusCode.ERROR] });
  assert.equal(named("llm fake")[1].attributes["maquette.failure"], "model.max_tokens");
  const [turn] = named("turn");
  assert.deepEqual(turn.attributes["maquette.failures"], ["model.unknown_tool", "user.declined", "model.max_tokens"]);
  assert.equal(turn.status.code, SpanStatusCode.ERROR);
  assert.equal(turn.status.message, "model.unknown_tool, model.max_tokens", "the person declining isn't the agent's failure");
});

test("the same call three times in a turn is flagged as a loop", async () => {
  const again = { calls: [{ name: "inspect_document" }] };
  const { session, named } = traced([again, again, again, { text: "Stuck." }]);
  await session.submit("look");
  const [turn] = named("turn");
  assert.deepEqual(turn.attributes["maquette.failures"], ["loop.repeat"]);
  assert.ok(turn.events.some((e) => e.name === "loop.repeat"));
});

test("a provider error ends the request's span in error", async () => {
  const { tracing, named } = traced([]);
  tracing.onAgent({ type: "user", text: "hi" });
  tracing.onAgent({ type: "step_start", step: 1, provider: "anthropic", model: "claude-opus-5-5", request: { system: [], messages: [] } });
  tracing.onAgent({ type: "step_end", step: 1, ms: 3, failure: "provider.error", error: "Anthropic is rate-limiting these requests (429)." });
  tracing.onAgent({ type: "done" });
  const [llm] = named("llm claude-opus-5-5");
  assert.equal(llm.status.message, "provider.error: Anthropic is rate-limiting these requests (429).");
  assert.equal(named("turn")[0].status.code, SpanStatusCode.ERROR);
});

test("calls from the prompt and from other sessions get a trace of their own, with the engine's stderr", async () => {
  const { server, tracing, named } = traced([]);
  tracing.onServer({ type: "engine_log", text: "warning: font fallback" });
  server.emitHttp("render_page", { page: 1 });
  const [call] = named("tool render_page");
  assert.equal(call.parentSpanContext, undefined);
  assert.equal(call.attributes["maquette.source"], "http");
  assert.deepEqual(call.events.map((e) => [e.name, e.attributes?.text]), [["engine stderr", "warning: font fallback"]]);
});

test("the engine's stderr from before a tool call stays for the turn, not dropped by the call", () => {
  const { tracing, named } = traced([]);
  tracing.logs = [{ at: 100, text: "written while the model thought" }, { at: 250, text: "written during the call" }, { at: 500, text: "written after" }];
  const call = tracing.start("tool render_page", {});
  tracing.attachLogs(call, 200, 300);
  call.end(300);
  assert.deepEqual(named("tool render_page")[0].events.map((e) => e.attributes?.text), ["written during the call"]);
  assert.deepEqual(tracing.logs.map((l) => l.text), ["written while the model thought", "written after"], "the rest wait for the turn");
});

test("the endpoint: 1 means Phoenix on its usual port; a URL gets /v1/traces once", () => {
  assert.equal(endpointOf("1"), "http://localhost:6006/v1/traces");
  assert.equal(endpointOf("http://127.0.0.1:4318/"), "http://127.0.0.1:4318/v1/traces");
  assert.equal(endpointOf("http://phoenix:6006/v1/traces"), "http://phoenix:6006/v1/traces");
});

test("the conversation flattens the way OpenInference reads it", () => {
  const attrs = messageAttributes("llm.input_messages", "Be brief.", [
    { role: "user", parts: [{ type: "text", text: "Hi" }] },
    { role: "assistant", parts: [{ type: "text", text: "Rendering." }, { type: "tool_call", id: "c1", name: "render_page", input: { page: 0 } }] },
    { role: "user", parts: [{ type: "tool_result", id: "c1", name: "render_page", content: [{ type: "text", text: "Failed." }], isError: true }] },
  ]);
  assert.deepEqual(attrs, {
    "llm.input_messages.0.message.role": "system",
    "llm.input_messages.0.message.content": "Be brief.",
    "llm.input_messages.1.message.role": "user",
    "llm.input_messages.1.message.content": "Hi",
    "llm.input_messages.2.message.role": "assistant",
    "llm.input_messages.2.message.content": "Rendering.",
    "llm.input_messages.2.message.tool_calls.0.tool_call.id": "c1",
    "llm.input_messages.2.message.tool_calls.0.tool_call.function.name": "render_page",
    "llm.input_messages.2.message.tool_calls.0.tool_call.function.arguments": '{"page":0}',
    "llm.input_messages.3.message.role": "tool",
    "llm.input_messages.3.message.tool_call_id": "c1",
    "llm.input_messages.3.message.name": "render_page",
    "llm.input_messages.3.message.content": "Error: Failed.",
  });
});

// A fake docker: answers from a script and records what was run.
function fakeDocker(script: { daemon?: "up" | "down" | "missing"; startsDaemon?: boolean; container?: "" | "running" | "exited"; comesUp?: boolean; psFails?: boolean }) {
  const ran: string[] = [];
  let daemon = script.daemon ?? "up";
  let up = false;
  const run: Run = async (command, args) => {
    ran.push(`${command} ${args.join(" ")}`);
    if (command === "docker" && daemon === "missing") return { code: null, out: "", missing: true };
    if (command === "open" || command === "systemctl") {
      if (script.startsDaemon === false) return { code: 1, out: "Unit docker.service not found." };
      daemon = "up";
      return { code: 0, out: "" };
    }
    if (args[0] === "info") return daemon === "up" ? { code: 0, out: "29.9.2" } : { code: 1, out: "Cannot connect to the Docker daemon" };
    if (args[0] === "ps") return script.psFails ? { code: 1, out: "permission denied while trying to connect to the Docker daemon socket" } : { code: 0, out: script.container ?? "" };
    if (args[0] === "run" || args[0] === "start") {
      up = script.comesUp ?? true;
      return { code: 0, out: "" };
    }
    return { code: 1, out: `unexpected: ${command} ${args.join(" ")}` };
  };
  const options = { say: () => {}, run, isHealthy: async () => up, sleep: async () => {}, platform: "darwin" as const };
  return { ran, options };
}

test("--trace uses a Phoenix that's already running, and touches nothing", async () => {
  const { ran, options } = fakeDocker({});
  assert.equal(await ensurePhoenix({ ...options, isHealthy: async () => true }), "Phoenix already running");
  assert.deepEqual(ran, []);
});

test("--trace starts Docker when its daemon is down, then creates Phoenix's container", async () => {
  const { ran, options } = fakeDocker({ daemon: "down" });
  assert.equal(await ensurePhoenix(options), "Docker started, Phoenix in Docker");
  assert.ok(ran.includes("open -a Docker"));
  const create = ran.find((r) => r.startsWith("docker run"));
  assert.match(create!, /--name maquette-phoenix -p 127\.0\.0\.1:6006:6006 -v maquette-phoenix:\/mnt\/data .* arizephoenix\/phoenix:version-\d+\.\d+\.\d+$/);
});

test("--trace restarts a stopped container rather than making another", async () => {
  const { ran, options } = fakeDocker({ container: "exited" });
  assert.equal(await ensurePhoenix({ ...options, platform: "linux" }), "Phoenix in Docker");
  assert.ok(ran.includes("docker start maquette-phoenix"));
  assert.ok(!ran.some((r) => r.startsWith("docker run")));
});

test("--trace says why tracing is off when Phoenix can't be started", async () => {
  await assert.rejects(ensurePhoenix(fakeDocker({ daemon: "missing" }).options), /Docker isn't installed/);
  await assert.rejects(ensurePhoenix({ ...fakeDocker({ daemon: "down", startsDaemon: false }).options, platform: "linux" }), /couldn't be started \(Unit docker.service not found\.\)/);
  await assert.rejects(ensurePhoenix(fakeDocker({ comesUp: false }).options), /nothing answers on http:\/\/localhost:6006/);
  const failing = fakeDocker({ psFails: true });
  await assert.rejects(ensurePhoenix(failing.options), /couldn't list its containers: permission denied/);
  assert.ok(!failing.ran.some((r) => r.startsWith("docker start") || r.startsWith("docker run")), "a failed docker ps starts nothing");
  const windows = fakeDocker({ daemon: "down" });
  await assert.rejects(ensurePhoenix({ ...windows.options, platform: "win32" }), /Start Docker Desktop, then run again/);
  assert.ok(!windows.ran.some((r) => r.startsWith("systemctl") || r.startsWith("open")));
});

test("the line under the title says tracing is on, or why it's off", () => {
  const status = { provider: "fake", model: "fake", mode: "ask", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, turns: 0, textProtocol: false };
  const info = { version: "t", engineName: "Engine", toolCount: 5, port: 8787, images: "maquette-renders/x" };
  const strip = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(!strip(startLines(info, "/tmp", status)).some((l) => l.includes("Tracing")));
  assert.ok(strip(startLines({ ...info, trace: { ok: true, text: "Tracing to http://localhost:6006 (Phoenix in Docker), project maquette" } }, "/tmp", status)).includes("  ✓ Tracing to http://localhost:6006 (Phoenix in Docker), project maquette"));
  assert.ok(strip(startLines({ ...info, trace: { ok: false, text: "Tracing is off: Docker isn't installed." } }, "/tmp", status)).includes("  ! Tracing is off: Docker isn't installed."));
});

test("traces carry the commit the code and prompts are from, marked when there are uncommitted changes", () => {
  assert.match(gitCommit() ?? "", /^[0-9a-f]{7,}(\+changes)?$/);
  assert.equal(gitCommit("/"), undefined, "outside a clone there's none");
});
