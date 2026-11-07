import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ChangeRing } from "../../src/runtime/changes.ts";
import { startServer } from "../../src/server.ts";
import { AgentSession } from "../../src/agent/session.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import { settings } from "./fake-server.ts";
import { closedPort } from "./mock.ts";
import { loadMcpConfig, trustProject } from "../../src/mcp/config.ts";
const engine = fileURLToPath(new URL("../stub-engine.ts", import.meta.url));
const fixture = fileURLToPath(new URL("../mcp-fixture.ts", import.meta.url));
const temp = () => mkdtempSync(join(tmpdir(), "maquette-changes-"));
test("ring keeps 1000 monotonic events, detects restart/gaps and impossible cursors", () => {
  const r = new ChangeRing("runtime");
  for (let i = 0; i < 1005; i++) r.append({ caller: "other", tool: "save_document", source: "http", scope: "designcraft" });
  assert.equal(r.since({ runtime: "runtime", after: 5 }).changes.length, 1000);
  assert.equal(r.since({ runtime: "runtime", after: 4 }).gap, true); assert.equal(r.since({ runtime: "old", after: 1005 }).gap, true); assert.equal(r.since({ runtime: "runtime", after: 1006 }).gap, true);
});
test("other clients are attributed before a model step, own calls aren't echoed; HTTP root check and stale mutations", async t => {
  const root = temp(); const runtime = await startServer({ root, home: temp(), engine, port: await closedPort(), version: "0.1.0" }); t.after(() => runtime.stop());
  const p = new FakeProvider([{ text: "inspect current state" }, { text: "no own echo" }]);
  const s = new AgentSession({ server: runtime, provider: p, settings: settings(), projectFile: join(root, "settings.json"), persist: true }); t.after(() => s.close());
  await runtime.enqueue("open_document", { path: "sample.designcraft" }, "mcp", { caller: "external-client" });
  await s.submit("continue"); const sent = JSON.stringify(p.requests[0].messages); assert.match(sent, /external-client/); assert.match(sent, /designcraft/); assert.equal(s.needsInspection, true);
  await s.submit("inspect_document"); assert.equal(s.needsInspection, false); await s.submit("next");
  const own = await runtime.enqueue("save_document", {}, "model", { caller: s.caller }); assert.equal(own.ok, true); const noticesBefore = s.history.length; await s.syncChanges(); assert.equal(s.history.length, noticesBefore);
  const cursor = { runtime: runtime.identity.runtimeId, after: runtime.changeSequence }; await runtime.enqueue("save_document", {}, "http", { caller: "other" });
  const stale = await runtime.enqueue("save_document", {}, "model", { caller: s.caller, cursor }); assert.equal(stale.ok, false); assert.match(stale.text, /not run/);
  assert.equal((await fetch(`http://127.0.0.1:${runtime.port}/changes?runtime=${cursor.runtime}&after=0`)).status, 409);
  const feed = await (await fetch(`http://127.0.0.1:${runtime.port}/changes?runtime=${cursor.runtime}&after=0`, { headers: { "x-maquette-root": runtime.root } })).json(); assert.ok(feed.changes.length >= 3);
  assert.ok(s.journal!.records.some(r => r.type === "cursor"));
});
test("external app changes are not described as DesignCraft document edits", async t => {
  const root = temp(), home = temp(); mkdirSync(join(root, ".maquette")); writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { app: { command: process.execPath, args: [fixture] } } })); trustProject(loadMcpConfig(root, home));
  const runtime = await startServer({ root, home, engine, port: await closedPort(), version: "0.1.0" }); t.after(() => runtime.stop());
  const p = new FakeProvider([{ text: "check external app" }]); const s = new AgentSession({ server: runtime, provider: p, settings: settings(), projectFile: join(root, "settings.json") });
  await runtime.enqueue("app__read_echo", { text: "value" }, "mcp", { caller: "app-client" }); await s.submit("continue");
  const request = JSON.stringify(p.requests[0].messages); assert.match(request, /external app\/server/); assert.match(request, /not evidence of a DesignCraft edit/);
});

test("actual runtime restart is noticed by an attached agent before its next request", async t => {
  const { attachRuntime } = await import("../../src/runtime/connect.ts");
  const root = temp(), home = temp(), port = await closedPort();
  let runtime = await startServer({ root, home, engine, port, version: "0.1.0" });
  t.after(() => runtime.stop()); const attached = await attachRuntime({ ...runtime.identity }, port);
  const provider = new FakeProvider([{ text: "old runtime" }, { text: "new runtime needs inspection" }]);
  const s = new AgentSession({ server: attached, settings: settings(), provider, projectFile: join(root, "settings.json") });
  await s.submit("first"); const old = runtime.identity.runtimeId; await runtime.stop();
  runtime = await startServer({ root, home, engine, port, version: "0.1.0" }); assert.notEqual(runtime.identity.runtimeId, old);
  await s.submit("continue after restart"); assert.equal(s.needsInspection, true); assert.match(JSON.stringify(provider.requests[1].messages), /Runtime restarted or change events were lost/);
});
