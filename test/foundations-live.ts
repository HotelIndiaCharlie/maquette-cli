// Real DesignCraft acceptance; model behavior remains scripted and deterministic.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startServer } from "../src/server.ts";
import { AgentSession } from "../src/agent/session.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { load } from "../src/settings.ts";
import { findDesignCraft, pin } from "../src/install.ts";
import { closedPort } from "./unit/mock.ts";
const pkg = fileURLToPath(new URL("../", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "maquette-foundations-live-")));
const testHome = realpathSync(mkdtempSync(join(tmpdir(), "maquette-foundations-home-")));
const cli = findDesignCraft(); if (!cli) throw new Error("Install pinned DesignCraft: maquette install-designcraft");
cpSync(join(pkg, "examples"), join(root, "example"), { recursive: true });
const settings = load({ cwd: root, home: testHome, env: {}, flags: { "permissions.mode": "auto" } }).settings;
const port = await closedPort();
let runtime = await startServer({ root, home: testHome, port, version: "0.1.0", cli });
let session: AgentSession | undefined;
const external = new Client({ name: "real-designcraft-acceptance", version: "1" });
try {
  const spec = JSON.parse(readFileSync(join(root, "example/specs/01-revenue.json"), "utf8"));
  const provider = new FakeProvider([
    { calls: [{ name: "inspect_document" }, { name: "chart_create", input: { frame: "firstlight:slot:01", spec } }, { name: "save_document", input: { path: "working.designcraft" } }] },
    { text: "Created and saved one revenue chart." },
    { calls: [{ name: "inspect_document" }, { name: "chart_list" }] }, { text: "Verified the external client's updated data." },
  ]);
  session = new AgentSession({ server: runtime, settings, provider, projectFile: join(root, ".maquette/settings.json"), persist: true });
  await session.submit("open_document example/annual-report.designcraft");
  await session.submit("Inspect, create one revenue chart and explicitly save working.designcraft");
  assert.match(JSON.stringify(session.history), /All 13 marks/);
  await external.connect(new StdioClientTransport({ command: process.execPath, args: [join(pkg, "dist/cli.js"), "mcp", "--port", String(port)], cwd: root, env: { ...process.env, HOME: testHome, DESIGNCRAFT_CLI: cli } as any, stderr: "pipe" }));
  const list = await external.callTool({ name: "chart_list", arguments: {} });
  const charts = JSON.parse((list.content as any[]).find(c => c.type === "text")!.text); assert.equal(charts.length, 1);
  const updated = await external.callTool({ name: "chart_update", arguments: { chart: charts[0].chart, data: { url: "example/data/01-revenue-updated.csv" }, render: false } });
  assert.equal(updated.isError, undefined); assert.match(JSON.stringify(updated.content), /All 14 marks/);
  const saved = await external.callTool({ name: "save_document", arguments: { path: "working.designcraft" } }); assert.ok(!saved.isError);
  for (let page = 0; page < 5; page++) { const rendered = await external.callTool({ name: "render_page", arguments: { page, scale: 0.25 } }); assert.ok((rendered.content as any[]).some(c => c.type === "image")); }
  await session.submit("Inspect the shared document and verify the other client's update");
  assert.match(JSON.stringify(provider.requests.at(-1)!.messages), /01-revenue-updated.csv/);
  assert.ok(session.history.some(m => JSON.stringify(m).includes("Shared runtime notice")));
  const id = session.journal!.id; session.close(); await external.close(); await runtime.stop();
  runtime = await startServer({ root, home: testHome, port, version: "0.1.0", cli });
  const resumedCalls: string[] = []; runtime.on(e => { if (e.type === "call") resumedCalls.push(e.reply.tool); });
  const resumedProvider = new FakeProvider([{ text: "Earlier work created and saved one chart, then another client updated it." }, { calls: [{ name: "inspect_document" }, { name: "chart_list" }] }, { text: "Current state verified; no duplicate chart." }]);
  session = new AgentSession({ server: runtime, settings, provider: resumedProvider, projectFile: join(root, ".maquette/settings.json"), persist: true, resume: id });
  assert.equal(resumedCalls.length, 0, "resume performs no calls and does not reopen the document");
  await session.submit("What did we do?"); assert.match(JSON.stringify(resumedProvider.requests[0].messages), /01-revenue-updated.csv/);
  await session.submit("open_document working.designcraft"); await session.submit("Inspect current state and continue without creating another chart");
  assert.ok(!resumedCalls.includes("chart_create")); assert.equal(session.needsInspection, false);
  const after = await runtime.enqueue("chart_list", {}, "prompt"); assert.equal(JSON.parse(after.text).length, 1);
  const original = session.journal!.id; await session.submit("/clear"); assert.notEqual(session.journal!.id, original);
  console.log(`PASS: DesignCraft ${pin.version}; shared terminal/MCP chart, external update, five page renders, save/restart/resume without replay, clear retains journal. Artifacts: ${root}`);
} finally { session?.close(); await external.close().catch(() => {}); await runtime.stop(); }
