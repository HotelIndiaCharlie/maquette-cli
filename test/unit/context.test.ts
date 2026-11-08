import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentSession } from "../../src/agent/session.ts";
import { SessionJournal } from "../../src/agent/sessions.ts";
import { compactBoundary } from "../../src/agent/context.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import type { ChatEvent, ChatRequest, Message } from "../../src/providers/types.ts";
import { fakeServer, settings } from "./fake-server.ts";
function history(): Message[] {
  return Array.from({ length: 6 }, (_, i) => [
    { role: "user" as const, parts: [{ type: "text" as const, text: `task ${i}` }] },
    { role: "assistant" as const, parts: [{ type: "tool_call" as const, id: `c${i}`, name: "inspect_document", input: {} }], native: { provider: "fake", model: "fake", content: [{ type: "thinking", signature: `exact-signature-${i}`, thinking: "unchanged" }] } },
    { role: "user" as const, parts: [{ type: "tool_result" as const, id: `c${i}`, name: "inspect_document", content: [{ type: "text" as const, text: "result" }] }] },
    { role: "assistant" as const, parts: [{ type: "text" as const, text: "done" }] },
  ]).flat();
}
test("compact retains complete recent native groups exactly and original journal, then resumes active branch", async () => {
  const server = fakeServer(); const provider = new FakeProvider([{ text: "Purpose, completed effects, approved decisions, unresolved tasks. brief.md is authoritative." }]);
  const s = new AgentSession({ server, provider, settings: settings(), projectFile: join(server.root, "settings.json"), persist: true });
  history().forEach(m => s.commit(m)); const before = structuredClone(s.history); const cut = compactBoundary(before); const originalPrefix = readFileSync(s.journal!.path, "utf8");
  assert.ok(cut > 0); await s.submit("/compact focus on open work");
  assert.deepEqual(s.history.slice(1), before.slice(cut)); assert.match(JSON.stringify(s.history[0]), /brief.md/);
  assert.ok(readFileSync(s.journal!.path, "utf8").startsWith(originalPrefix)); assert.equal(server.calls.length, 0);
  const id = s.journal!.id; s.close(); const restored = new SessionJournal(server.root, { provider: "fake", model: "fake", resume: id });
  assert.deepEqual(restored.restore().messages, s.history); restored.close();
});
test("compact failure and cancellation preserve active context and native blocks", async () => {
  const server = fakeServer();
  class Broken extends FakeProvider { override async *chat(): AsyncIterable<ChatEvent> { throw new Error("summary failed"); } }
  const s = new AgentSession({ server, provider: new Broken([]), settings: settings(), projectFile: join(server.root, "settings.json") }); s.history = history(); const before = JSON.stringify(s.history);
  await s.submit("/compact"); assert.equal(JSON.stringify(s.history), before);
  class Slow extends FakeProvider { override async *chat(r: ChatRequest): AsyncIterable<ChatEvent> { setTimeout(() => s.interrupt(), 10); await new Promise((_, reject) => r.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); } }
  s.provider = new Slow([]); await s.submit("/compact"); assert.equal(JSON.stringify(s.history), before);
});
test("durable call outcomes after a crash rebuild results, unknown calls stay paired without replay", () => {
  const root = mkdtempSync(join(tmpdir(), "maquette-outcomes-")); const j = new SessionJournal(root, { provider: "fake", model: "fake" });
  j.append("message", { role: "assistant", parts: [{ type: "tool_call", id: "a", name: "save_document", input: {} }, { type: "tool_call", id: "b", name: "save_document", input: {} }] });
  j.append("call_start", { id: "a" }); j.append("call_result", { id: "a", normalized: { type: "tool_result", id: "a", name: "save_document", content: [{ type: "text", text: "Saved durable" }] } });
  j.append("call_start", { id: "b" }); const id = j.id; j.close();
  const r = new SessionJournal(root, { provider: "fake", model: "fake", resume: id }); const view = r.restore();
  assert.equal(view.uncertain, true); const results = view.messages.at(-1)!.parts as any[]; assert.equal(results.length, 2); assert.equal(results[0].content[0].text, "Saved durable"); assert.match(results[1].content[0].text, /Outcome unknown/); r.close();
});
test("oversized tool data is limited only at first ingestion with full output reference", () => {
  const server = fakeServer(); const s = new AgentSession({ server, provider: new FakeProvider([]), settings: settings(), projectFile: join(server.root, "settings.json") });
  const content = s.ingestReply({ id: 1, tool: "read_file", ok: true, text: "x".repeat(50000), source: "model", ms: 0, images: [] });
  const value = (content[0] as any).text; assert.match(value, /Truncated on first ingestion/); assert.ok(value.length < 31000);
  const path = value.match(/Complete result: (.+)\]/)![1]; assert.equal(JSON.parse(readFileSync(join(server.root, path), "utf8")).text.length, 50000);
});

test("connection loss still commits paired results with an uncertain outcome and never retries", async () => {
  const server = fakeServer(); let attempts = 0; server.enqueue = async () => { attempts++; throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" }); };
  const provider = new FakeProvider([{ calls: [{ name: "save_document" }] }, { text: "Unknown outcome; inspect first." }]);
  const s = new AgentSession({ server, provider, settings: settings({ permissions: { mode: "auto" } }), projectFile: join(server.root, "settings.json"), persist: true });
  await s.submit("save"); assert.equal(attempts, 1); assert.match(JSON.stringify(provider.requests[1].messages), /outcome unknown/); assert.equal(s.needsInspection, true); s.close();
});

test("compaction's own native payload is retained in the journal without editing recent signed groups", async () => {
  const server = fakeServer();
  class NativeSummary extends FakeProvider { override async *chat(): AsyncIterable<ChatEvent> { yield { type: "done", model: "fake", stop: "end", message: { role: "assistant", parts: [{ type: "text", text: "Continuation summary." }], native: { provider: "fake", content: [{ type: "compaction", signature: "exact-native-summary", content: "summary" }] } } }; } }
  const s = new AgentSession({ server, provider: new NativeSummary([]), settings: settings(), projectFile: join(server.root, "settings.json"), persist: true }); history().forEach(m => s.commit(m));
  await s.submit("/compact"); const compact = s.journal!.records.findLast(r => r.type === "compact")!;
  assert.equal(compact.data.response.native.content[0].signature, "exact-native-summary"); s.close();
});

test("summary requests use text alone with tool and signed thinking history, including after switching models", async () => {
  const server = fakeServer(); const provider = new FakeProvider([{ text: "Summary" }]);
  const s = new AgentSession({ server, provider, settings: settings(), projectFile: join(server.root, "settings.json") });
  s.history = history(); await s.submit("/compact");
  const r = provider.requests[0]; assert.equal(r.tools, undefined);
  assert.ok(r.messages.every(m => !('native' in m) && m.parts.every(p => p.type === "text")));
  assert.match(JSON.stringify(r.messages), /Called inspect_document/); assert.match(JSON.stringify(r.messages), /Result of inspect_document/);
  assert.doesNotThrow(() => compactBoundary(history(), 0));
});

test("local validation errors aren't mislabeled as lost connections and UTF-8 truncation stays valid", async () => {
  const server = fakeServer(); server.enqueue = async () => { throw new SyntaxError("invalid local JSON"); };
  const s = new AgentSession({ server, provider: new FakeProvider([]), settings: settings(), projectFile: join(server.root, "settings.json") });
  await assert.rejects(() => s.dispatch("save_document", {}, "model"), /invalid local JSON/); assert.equal(s.needsInspection, false);
  const text = "a".repeat(29999) + "漢".repeat(20);
  const content = s.ingestReply({ id: 1, tool: "read_file", source: "model", ms: 0, images: [], text, ok: true });
  assert.doesNotMatch(JSON.stringify(content), /�/);
});
