import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { readdirSync, writeFileSync } from "node:fs";
import { render } from "ink-testing-library";
import { AgentSession } from "../../src/agent/session.ts";
import { SessionJournal, listSessionsAsync } from "../../src/agent/sessions.ts";
import { collapseTools, restorePresentation, titleFromInput, type DisplayTool, type DisplayItem } from "../../src/agent/presentation.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import type { ChatEvent, ChatRequest } from "../../src/providers/types.ts";
import { App } from "../../src/ui/app.ts";
import { h } from "../../src/ui/h.ts";
import { fakeServer, settings } from "./fake-server.ts";
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const info = { version: "ux", engineName: "Stub", toolCount: 5, port: 8787, images: "renders" };
function screen(session: AgentSession, server: ReturnType<typeof fakeServer>) {
  let exited = false; const ui = render(h(App, { session, server, info, onExit: () => { exited = true; } }));
  const frame = () => (ui.lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const until = async (pattern: RegExp) => { for (let i = 0; i < 100 && !pattern.test(frame()); i++) await tick(20); assert.match(frame(), pattern); };
  return { ui, frame, until, exited: () => exited, close() { ui.unmount(); ui.cleanup(); session.close(); } };
}
function seed(root: string, name: string) {
  const j = new SessionJournal(root, { provider: "fake", model: "fake" });
  j.append("message", { role: "user", parts: [{ type: "text", text: name }] });
  j.append("message", { role: "assistant", parts: [{ type: "text", text: `Answer for ${name}` }], native: { provider: "fake", model: "fake", content: [{ type: "thinking", text: "DO_NOT_SHOW_NATIVE" }] } });
  j.append("notice", { sessionTitle: name }); const id = j.id; j.close(); return id;
}
test("each submitted input is echoed once, including slash, direct tools and invalid commands", async () => {
  const server = fakeServer(); const s = new AgentSession({ server, settings: settings(), provider: new FakeProvider([{ text: "Hello" }]), projectFile: join(server.root, "settings.json") }); const v = screen(s, server);
  try {
    await tick(); for (const input of ["hello", "/sessions", "inspect_document", "render_page --page bad", "/unknown"]) await s.submit(input); await tick();
    for (const input of ["hello", "/sessions", "inspect_document", "render_page --page bad", "/unknown"]) assert.equal(v.frame().split(`❯ ${input}`).length - 1, 1, input);
  } finally { v.close(); }
});
test("real Ctrl-C and Esc keys interrupt compact, keep context and never enqueue exit", async () => {
  for (const key of ["\x03", "\x1b"]) {
    let aborted = false;
    class Slow extends FakeProvider { override async *chat(r: ChatRequest): AsyncIterable<ChatEvent> { await new Promise((_, reject) => r.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, { once: true })); } }
    const server = fakeServer(); const s = new AgentSession({ server, settings: settings(), provider: new Slow([]), projectFile: join(server.root, "settings.json") });
    s.history = Array.from({ length: 6 }, (_, i) => [{ role: "user" as const, parts: [{ type: "text" as const, text: `question ${i}` }] }, { role: "assistant" as const, parts: [{ type: "text" as const, text: "answer" }] }]).flat(); const before = JSON.stringify(s.history); const v = screen(s, server);
    try {
      await tick(); v.ui.stdin.write("/compact"); await tick(); v.ui.stdin.write("\r"); await v.until(/Compacting conversation/); const first = v.frame(); await tick(110); assert.notEqual(v.frame(), first, "spinner advances");
      assert.match(v.frame(), /❯ \/compact/); assert.match(v.frame(), /esc to interrupt/);
      v.ui.stdin.write(key); await v.until(/Previous context kept/); assert.equal(aborted, true); assert.equal(v.exited(), false); assert.equal(JSON.stringify(s.history), before);
    } finally { v.close(); }
  }
});
test("direct non-cancellable tool remains visibly busy after Ctrl-C until its actual result", async () => {
  const server = fakeServer(); let release!: () => void; const original = server.enqueue.bind(server);
  server.enqueue = async (...args) => { await new Promise<void>(r => { release = r; }); return original(...args); };
  const s = new AgentSession({ server, settings: settings(), provider: new FakeProvider([]), projectFile: join(server.root, "settings.json") }); const v = screen(s, server);
  try {
    await tick(); const pending = s.submit("inspect_document"); await v.until(/Calling inspect_document/); v.ui.stdin.write("\x0f"); await v.until(/Tool output: inspect_document/); v.ui.stdin.write("\x03"); await v.until(/Stopping after the current call/); assert.equal(v.exited(), false);
    release(); await pending; await tick(); assert.equal(s.busy, false); assert.match(v.frame(), /Tool output: inspect_document[\s\S]*✓ inspect_document/);
  } finally { v.close(); }
});
test("resume and runtime-gap warnings are in the header before restored and new answers", async () => {
  const server = fakeServer(); const id = seed(server.root, "Old topic");
  const j = new SessionJournal(server.root, { resume: id, provider: "fake", model: "fake" }); j.append("cursor", { runtime: "old", after: 7 }); j.close();
  Object.assign(server, { identity: { runtimeId: "new" }, changeSequence: 0, changes: async () => ({ runtime: "new", sequence: 0, gap: true, changes: [] }) });
  const provider = new FakeProvider([{ text: "NEW_ANSWER" }]); const s = new AgentSession({ server, settings: settings(), provider, projectFile: join(server.root, "settings.json"), persist: true, resume: id }); const v = screen(s, server);
  try {
    await v.until(/Resumed /); assert.ok(v.frame().indexOf("Resumed ") < v.frame().indexOf("Answer for Old topic")); assert.match(v.frame(), /Runtime restarted/); assert.doesNotMatch(v.frame(), /DO_NOT_SHOW_NATIVE/); assert.equal(provider.requests.length, 0); assert.equal(server.calls.length, 0);
    await s.submit("continue"); await tick(); assert.ok(v.frame().indexOf("Runtime restarted") < v.frame().indexOf("NEW_ANSWER"));
  } finally { v.close(); }
});
test("startup offers three recent conversations with new as default and creates no premature journal", async () => {
  const server = fakeServer(); for (let i = 0; i < 4; i++) seed(server.root, `Topic ${i}`);
  const s = new AgentSession({ server, settings: settings(), provider: new FakeProvider([]), projectFile: join(server.root, "settings.json"), persist: true, deferPersistence: true }); const v = screen(s, server);
  try {
    await v.until(/Continue a recent conversation/); assert.equal(s.journal, undefined); assert.equal(readdirSync(join(server.root, ".maquette/sessions")).filter(f => f.endsWith(".jsonl")).length, 4);
    assert.match(v.frame(), /New conversation/); assert.match(v.frame(), /Topic 3/); assert.doesNotMatch(v.frame(), /Topic 0/);
    v.ui.stdin.write("\r"); await v.until(/Conversation: Empty conversation/); assert.ok(s.journal); assert.equal(server.calls.length, 0);
  } finally { v.close(); }
});
test("resume menu has ten entries then next page, previous page and cancellation", async () => {
  const server = fakeServer(); const ids: string[] = []; for (let i = 0; i < 23; i++) ids.push(seed(server.root, `Topic ${i}`));
  const provider = new FakeProvider([]); const s = new AgentSession({ server, settings: settings(), provider, projectFile: join(server.root, "settings.json"), persist: true }); const original = s.journal!.id;
  let pages = 0; s.on(e => { if (e.type === "choose") { pages++; if (pages === 1) { assert.equal(e.options.length, 11); assert.equal(e.options[10].id, "next"); e.reply("next"); } else if (pages === 2) { assert.equal(e.options[10].id, "next"); assert.equal(e.options[11].id, "previous"); e.reply("next"); } else { assert.equal(e.options.length, 4); assert.equal(e.options[3].id, "previous"); e.reply(null); } } });
  try { await s.submit("/resume"); assert.equal(pages, 3); assert.equal(s.journal!.id, original); assert.equal(provider.requests.length, 0); assert.equal(server.calls.length, 0); } finally { s.close(); }
});
test("failed or locked resume retains the current writer; successful resume resets grants without replay", async () => {
  const server = fakeServer(); const id = seed(server.root, "Saved topic"); const held = new SessionJournal(server.root, { resume: id, provider: "fake", model: "fake" });
  const s = new AgentSession({ server, settings: settings(), provider: new FakeProvider([]), projectFile: join(server.root, "settings.json"), persist: true }); const current = s.journal!.id;
  try {
    s.allowed.add("save_document"); await s.submit(`/resume ${id}`); assert.equal(s.journal!.id, current); assert.equal(s.allowed.size, 1);
    held.close(); await s.submit(`/resume ${id}`); assert.equal(s.journal!.id, id); assert.equal(s.allowed.size, 0); assert.equal(s.needsInspection, true); assert.equal(server.calls.length, 0);
    writeFileSync(join(server.root, ".maquette/sessions/broken.jsonl"), "bad\n"); await s.submit("/resume broken"); assert.equal(s.journal!.id, id);
    assert.ok(restorePresentation(s.journal!.records).items.some(i => i.kind === "notice" && i.level === "error" && /Corrupt session/.test(i.text)));
    await s.submit("/clear"); assert.notEqual(s.journal!.id, id);
  } finally { held.close(); s.close(); }
});
test("deterministic titles use the visible input, skip navigation and never use init bodies", async () => {
  assert.equal(titleFromInput("/sessions", "slash"), undefined); assert.equal(titleFromInput("help", "command"), undefined); assert.equal(titleFromInput("/init cover changed", "slash"), "Initialize project cover changed"); assert.ok([...titleFromInput("x".repeat(120), "message")!].length <= 60);
  const server = fakeServer(); const provider = new FakeProvider([{ text: "ok" }]); const s = new AgentSession({ server, provider, settings: settings(), projectFile: join(server.root, "settings.json"), persist: true });
  try { await s.submit("/sessions"); await s.submit("/init cover changed"); const entries = await listSessionsAsync(server.root); assert.equal(entries[0].title, "Initialize project cover changed"); assert.equal(provider.requests.length, 1); } finally { s.close(); }
});
test("saved presentation restores the last ten complete inputs without duplicating signed payloads", async () => {
  const server = fakeServer(); const s = new AgentSession({ server, settings: settings(), provider: new FakeProvider([]), projectFile: join(server.root, "settings.json"), persist: true });
  try {
    for (let i = 0; i < 12; i++) await s.submit(`hello ${i}`);
    const view = restorePresentation(s.journal!.records); assert.equal(view.restored, 10); assert.equal(view.items.filter(i => i.kind === "user").length, 10); assert.equal(view.items[0].kind, "user"); assert.match(JSON.stringify(view.items[0]), /hello 2/);
    assert.ok(s.journal!.records.filter(r => r.type === "notice" && r.data.ui).every(r => !JSON.stringify(r.data).includes('"native"')));
  } finally { s.close(); }
});
test("identical successful tools collapse only in the view; detail toggles without transcript copies", async () => {
  const server = fakeServer(); const provider = new FakeProvider([{ calls: Array.from({ length: 3 }, () => ({ name: "inspect_document" })) }, { text: "Checked." }]);
  const s = new AgentSession({ server, provider, settings: settings(), projectFile: join(server.root, "settings.json"), persist: true }); const v = screen(s, server);
  try {
    await tick(); await s.submit("check three times"); await tick(); assert.match(v.frame(), /inspect_document ×3, same result/);
    assert.equal(server.calls.length, 3); assert.equal(s.journal!.records.filter(r => r.type === "call_result").length, 3);
    assert.equal(restorePresentation(s.journal!.records).items.filter(i => i.kind === "tool").length, 3);
    assert.equal(provider.requests[1].messages.at(-1)!.parts.length, 3);
    for (let i = 0; i < 3; i++) {
      v.ui.stdin.write("\x0f"); await tick(); assert.match(v.frame(), /Tool output: inspect_document/); assert.match(v.frame(), /"pages":5/);
      v.ui.stdin.write("\x1b"); await tick(); assert.doesNotMatch(v.frame(), /Tool output:/); assert.equal(v.frame().split("same result").length - 1, 1);
    }
  } finally { v.close(); }
});
test("tool groups stop at changed arguments, results, text, turns, errors and images", () => {
  const base: DisplayTool = { kind: "tool", id: "a", name: "chart_list", input: {}, source: "model", done: true, ok: true, text: "[]" };
  assert.equal((collapseTools([base, { ...base, id: "b" }, { ...base, id: "c" }])[0] as DisplayTool).calls!.length, 3);
  for (const changed of [{ input: { chart: "1" } }, { text: "[1]" }, { ok: false }, { images: ["render.png"] }, { source: "prompt" as const }, { done: false }]) assert.equal(collapseTools([base, { ...base, ...changed }]).length, 2);
  for (const boundary of [{ kind: "user", text: "again" }, { kind: "answer", text: "checking" }, { kind: "notice", text: "warning", level: "warn" }] as DisplayItem[]) assert.equal(collapseTools([base, boundary, base]).length, 3);
});
test("legacy turns remain visible after the first new turn, and direct results stay with their input", async () => {
  const server = fakeServer(); const j = new SessionJournal(server.root, { provider: "fake", model: "fake" });
  j.append("message", { role: "user", parts: [{ type: "text", text: "old question" }] });
  j.append("message", { role: "assistant", parts: [{ type: "text", text: "old answer" }] });
  j.append("call_start", { id: "direct", name: "inspect_document", args: {}, source: "prompt" });
  j.append("call_result", { id: "direct", reply: { tool: "inspect_document", source: "prompt", ok: true, text: "SAVED_RESULT", images: [] } });
  j.append("message", { role: "user", parts: [{ type: "text", text: "The person ran `inspect_document` at the prompt; it returned: SAVED_RESULT" }] }); const id = j.id; j.close();
  const s = new AgentSession({ server, settings: settings(), provider: new FakeProvider([{ text: "new answer" }]), projectFile: join(server.root, "settings.json"), persist: true, resume: id });
  try {
    await s.submit("new question"); const view = restorePresentation(s.journal!.records); assert.equal(view.restored, 3); assert.equal(view.legacy, true);
    assert.deepEqual(view.items.map(i => i.kind), ["user", "answer", "user", "tool", "user", "answer"]); assert.match(JSON.stringify(view.items), /old answer/);
  } finally { s.close(); }
});
test("malformed saved presentation cannot replace the current conversation", async () => {
  const server = fakeServer(); const j = new SessionJournal(server.root, { provider: "fake", model: "fake" });
  j.append("notice", { ui: { id: "invalid", kind: "item", item: { kind: "notice", text: null } } }); const bad = j.id; j.close();
  const s = new AgentSession({ server, settings: settings(), provider: new FakeProvider([]), projectFile: join(server.root, "settings.json"), persist: true }); const current = s.journal!.id;
  try {
    await s.submit(`/resume ${bad}`); assert.equal(s.journal!.id, current);
    assert.ok(restorePresentation(s.journal!.records).items.some(i => i.kind === "notice" && /Invalid presentation record/.test(i.text)));
    await s.submit("inspect_document"); assert.equal(server.calls.length, 1);
  } finally { s.close(); }
});
test("explicit startup resume bypasses the menu and retains current provider, model and permission mode", async () => {
  const server = fakeServer(); const id = seed(server.root, "Previous"); const s = new AgentSession({ server, settings: settings({ permissions: { mode: "plan" } }), provider: new FakeProvider([]), projectFile: join(server.root, "settings.json"), persist: true, deferPersistence: true, resume: id });
  let choices = 0; s.on(e => { if (e.type === "choose") { choices++; e.reply(null); } });
  try { await s.initializeInteractive(); assert.equal(choices, 0); assert.equal(s.journal!.id, id); assert.equal(s.mode, "plan"); assert.equal(s.provider.name, "fake"); assert.equal(server.calls.length, 0); } finally { s.close(); }
});
test("interrupting a call keeps queued input and runs it after the actual call finishes", async () => {
  const server = fakeServer(); let release!: () => void; const original = server.enqueue.bind(server);
  server.enqueue = async (...args) => { await new Promise<void>(r => { release = r; }); return original(...args); };
  const s = new AgentSession({ server, settings: settings(), provider: new FakeProvider([]), projectFile: join(server.root, "settings.json"), persist: true }); const v = screen(s, server);
  try {
    await tick(); const first = s.submit("inspect_document"); await v.until(/Calling inspect_document/);
    const next = s.submit("/sessions"); await v.until(/1 queued input/); v.ui.stdin.write("\x03"); await v.until(/Stopping after the current call/); assert.match(v.frame(), /1 queued input/);
    release(); await Promise.all([first, next]); await tick(); assert.match(v.frame(), /❯ \/sessions/); assert.equal(s.busy, false); assert.equal(server.calls.length, 1);
  } finally { v.close(); }
});

test("structured origins preserve titles and presentation when prompt wording changes", () => {
  const server = fakeServer(), j = new SessionJournal(server.root, { provider: "fake", model: "fake" });
  j.append("call_start", { id: "d", name: "inspect_document", args: {}, source: "prompt" });
  j.append("call_result", { id: "d", reply: { tool: "inspect_document", source: "prompt", ok: true, text: "Inspected", images: [] } });
  j.append("message", { role: "user", meta: { origin: "direct", command: "inspect_document" }, parts: [{ type: "text", text: "Changed narrative wording" }] });
  j.append("message", { role: "user", meta: { origin: "skill", command: "/custom-skill purpose" }, parts: [{ type: "text", text: "Different skill wording" }] });
  const view = restorePresentation(j.records);
  assert.equal(view.items[0].kind, "user"); assert.equal((view.items[0] as any).text, "inspect_document"); assert.equal(view.items[1].kind, "tool"); assert.ok(view.items.some(i => i.kind === "user" && i.text === "/custom-skill purpose")); j.close();
});
