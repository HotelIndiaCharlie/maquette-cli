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
  writeFileSync(j.path, original.toString().split("\n")[0] + "\nnot json\n");
  assert.throws(() => new SessionJournal(dir, { ...options, resume: id }), /Corrupt.*line 2/);
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
