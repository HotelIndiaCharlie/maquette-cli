import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionJournal, listSessions } from "../../src/agent/sessions.ts";
import { providerView } from "../../src/agent/context.ts";
import { AgentSession } from "../../src/agent/session.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import { fakeServer, settings } from "./fake-server.ts";
import type { Message } from "../../src/providers/types.ts";
const root = () => mkdtempSync(join(tmpdir(), "maquette-journal-"));
const options = { provider: "anthropic", model: "a" };

test("journal preserves native signatures and images, excludes foreign/model-incompatible native blocks", () => {
  const dir = root(); const j = new SessionJournal(dir, options);
  const messages: Message[] = [
    { role: "user", parts: [{ type: "text", text: "hello" }, { type: "image", mediaType: "image/png", data: "abcd" }] },
    { role: "assistant", parts: [{ type: "text", text: "answer" }], native: { provider: "anthropic", model: "a", content: [{ type: "thinking", signature: "exact +/ bytes", thinking: "kept" }] } },
  ];
  messages.forEach(m => j.append("message", m)); const id = j.id; j.close();
  const resumed = new SessionJournal(dir, { ...options, resume: id });
  assert.deepEqual(resumed.restore().messages, messages);
  assert.deepEqual(providerView(messages, "anthropic", "a"), messages);
  assert.equal((providerView(messages, "other", "a")[1] as any).native, undefined);
  assert.equal((providerView(messages, "anthropic", "b")[1] as any).native, undefined);
  assert.equal(listSessions(dir)[0].first, "hello"); resumed.close();
});
test("writer exclusion, trailing crash line recovered into a copy, internal corruption rejected", () => {
  const dir = root(); const j = new SessionJournal(dir, options); const id = j.id;
  assert.throws(() => new SessionJournal(dir, { ...options, resume: id }), /Already owned/);
  j.close(); appendFileSync(j.path, '{"partial":'); const original = readFileSync(j.path);
  const r = new SessionJournal(dir, { ...options, resume: id });
  assert.notEqual(r.path, j.path); assert.ok(r.warnings.length); assert.deepEqual(readFileSync(j.path), original); r.close();
  writeFileSync(r.path, original.toString().split("\n")[0] + "\nnot json\n");
  assert.throws(() => new SessionJournal(dir, { ...options, resume: r.id }), /Corrupt.*line 2/);
});
test("uncertain calls are paired without execution, partial replies do not become native messages", () => {
  const dir = root(); const j = new SessionJournal(dir, options);
  j.append("message", { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "save_document", input: {} }] });
  j.append("call_start", { id: "c1" }); j.append("interrupted", { partialText: "partial reply" }); const id = j.id; j.close();
  const r = new SessionJournal(dir, { ...options, resume: id }); const view = r.restore();
  assert.equal(view.uncertain, true); assert.equal(view.messages.length, 2);
  assert.match(JSON.stringify(view.messages.at(-1)), /Outcome unknown/); r.close();
});
test("agent saves before effects, resume never replays and resets grants; clear retains old journal", async () => {
  const server = fakeServer(); const p = new FakeProvider([{ calls: [{ name: "save_document", input: {} }] }, { text: "saved" }]);
  const s = new AgentSession({ server, settings: settings(), provider: p, projectFile: join(server.root, "settings.json"), persist: true });
  s.on(e => { if (e.type === "ask_permission") e.reply("a"); });
  await s.submit("save"); const id = s.journal!.id;
  const records = s.journal!.records;
  assert.ok(records.findIndex(r => r.type === "message" && r.data.role === "assistant") < records.findIndex(r => r.type === "call_start"));
  s.close(); const count = server.calls.length;
  const resumed = new AgentSession({ server, settings: settings(), provider: new FakeProvider([{ text: "remembered" }]), projectFile: join(server.root, "settings.json"), persist: true, resume: id });
  assert.equal(server.calls.length, count); assert.equal(resumed.allowed.size, 0); assert.equal(resumed.needsInspection, true);
  await resumed.submit("/clear"); assert.notEqual(resumed.journal!.id, id); assert.equal(listSessions(server.root).length, 2); resumed.close();
});

test("a process crash releases ownership on recovery; unsupported versions and corrupt message shapes fail usefully", async () => {
  const { spawnSync } = await import("node:child_process"); const { pathToFileURL } = await import("node:url");
  const dir = root();
  const script = `import { SessionJournal } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/agent/sessions.ts")).href)}; const j = new SessionJournal(${JSON.stringify(dir)}, { provider: "fake", model: "fake" }); j.append("call_start", {id:"crash"}); process.stdout.write(j.id); process.exit(0);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }); assert.equal(child.status, 0, child.stderr);
  const recovered = new SessionJournal(dir, { provider: "fake", model: "fake", resume: child.stdout }); assert.equal(recovered.restore().uncertain, true); const path = recovered.path; recovered.close();
  const raw = readFileSync(path, "utf8"); writeFileSync(path, raw.replace('"v":1', '"v":99'));
  assert.throws(() => new SessionJournal(dir, { ...options, resume: child.stdout }), /Unsupported session version/);
  writeFileSync(path, raw + JSON.stringify({ v: 1, seq: raw.trim().split("\n").length + 1, at: "today", type: "message", data: { role: "assistant", parts: [{ type: "tool_call", id: "bad" }] } }) + "\n");
  assert.throws(() => new SessionJournal(dir, { ...options, resume: child.stdout }), /Invalid message/);
});

test("twenty image renders keep base64 outside the journal and rehydrate verified snapshots", async () => {
  const { statSync, readdirSync, unlinkSync } = await import("node:fs");
  const dir = root(), j = new SessionJournal(dir, options);
  const data = Buffer.alloc(512 * 1024, 7).toString("base64");
  for (let i = 0; i < 20; i++) {
    j.append("call_result", { id: String(i), reply: { tool: "render_page", ok: true, text: "rendered", images: [], result: { content: [{ type: "image", mimeType: "image/png", data }] } } });
    j.append("message", { role: "user", parts: [{ type: "image", mediaType: "image/png", data }] });
  }
  assert.ok(statSync(j.path).size < 1_000_000); assert.ok(JSON.stringify(j.records).length < 1_000_000);
  assert.ok(!readFileSync(j.path, "utf8").includes(data));
  assert.equal((j.restore().messages[0].parts[0] as any).data, data);
  const assetDir = join(dir, ".maquette/sessions/assets");
  assert.equal(readdirSync(assetDir).length, 1); unlinkSync(join(assetDir, readdirSync(assetDir)[0]));
  assert.match(JSON.stringify(j.restore().messages[0]), /image no longer available/); j.close();
});

test("latest resume skips locked conversations and repeated recovery reuses its copy without changing dates", async () => {
  const dir = root(); const a = new SessionJournal(dir, options); a.append("message", { role: "user", parts: [{ type: "text", text: "earlier task" }] }); a.close();
  const b = new SessionJournal(dir, options); b.append("message", { role: "user", parts: [{ type: "text", text: "current task" }] });
  const resumed = await SessionJournal.open(dir, { ...options, resume: true }); assert.equal(resumed.id, a.id); resumed.close(); b.close();
  const date = listSessions(dir).find(s => s.id === b.id)!.date; const size = readFileSync(b.path).length;
  const reopened = await SessionJournal.open(dir, { ...options, resume: b.id }); reopened.close();
  assert.equal(readFileSync(b.path).length, size); assert.equal(listSessions(dir).find(s => s.id === b.id)!.date, date);
  appendFileSync(a.path, '{"partial":');
  const recovered = await SessionJournal.open(dir, { ...options, resume: a.id }); recovered.close();
  const twice = await SessionJournal.open(dir, { ...options, resume: a.id }); assert.equal(twice.id, recovered.id); twice.close();
  assert.equal(listSessions(dir).find(s => s.id === a.id)!.recoveredAs, recovered.id);
});

test("inspection guard covers document changes while allowing opening, workspace and external tools", async () => {
  const server = fakeServer(); server.tools = [...server.tools, { name: "bash", inputSchema: { type: "object" } }, { name: "app__write", inputSchema: { type: "object" }, _maquette: { builtin: false, server: "app", identity: "1" } }];
  server.byName = new Map(server.tools.map(t => [t.name, t]));
  const provider = new FakeProvider([{ calls: [{ name: "bash" }, { name: "app__write" }, { name: "save_document" }, { name: "open_document", input: { path: "example.designcraft" } }, { name: "save_document" }] }, { text: "done" }]);
  const s = new AgentSession({ server, provider, settings: settings({ permissions: { mode: "auto" } }), projectFile: join(server.root, "settings.json"), persist: true });
  const failures: string[] = []; s.on(e => { if (e.type === "tool_result" && e.failure) failures.push(e.failure); }); s.needsInspection = true;
  await s.submit("continue");
  assert.deepEqual(server.calls.map(c => c.tool), ["bash", "app__write", "open_document", "save_document"]);
  assert.ok(failures.includes("policy.inspect_required")); assert.equal(s.needsInspection, false); s.close();
});

test("MCP diagnostics stay out of the journal and provider history; first external reads ask", async () => {
  const server = fakeServer(); server.mcpLogs = async () => "PRIVATE_STDERR_DIAGNOSTIC";
  server.tools = [...server.tools, { name: "app__fetch", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _maquette: { server: "app", identity: "external-1" } }]; server.byName = new Map(server.tools.map(t => [t.name, t]));
  const provider = new FakeProvider([{ calls: [{ name: "app__fetch" }, { name: "app__fetch" }] }, { text: "done" }]);
  const s = new AgentSession({ server, provider, settings: settings(), projectFile: join(server.root, "settings.json"), persist: true });
  let prompts = 0; s.on(e => { if (e.type === "ask_permission") { prompts++; e.reply("y"); } });
  await s.submit("/mcp logs app"); assert.doesNotMatch(readFileSync(s.journal!.path, "utf8"), /PRIVATE_STDERR_DIAGNOSTIC/); assert.equal(s.history.length, 0);
  await s.submit("fetch"); assert.equal(prompts, 1); assert.doesNotMatch(JSON.stringify(provider.requests), /PRIVATE_STDERR_DIAGNOSTIC/); s.close();
});

test("a durable render outcome rehydrates images even if the process crashed before committing results", () => {
  const dir = root(), j = new SessionJournal(dir, options), data = Buffer.from("saved image bytes").toString("base64");
  j.append("message", { role: "assistant", parts: [{ type: "tool_call", id: "render", name: "render_page", input: { page: 0 } }] });
  j.append("call_start", { id: "render" });
  j.append("call_result", { id: "render", reply: { tool: "render_page", ok: true, text: "Rendered", images: [] }, normalized: { type: "tool_result", id: "render", name: "render_page", content: [{ type: "text", text: "Rendered" }, { type: "image", mediaType: "image/png", data }] } });
  const restored = j.restore(); assert.equal(restored.uncertain, false);
  assert.equal((restored.messages.at(-1)!.parts[0] as any).content[1].data, data); j.close();
});
