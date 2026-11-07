import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadMcpConfig, validateMcpMap, expandCredentials, isTrusted, trustProject, redactedMcp } from "../../src/mcp/config.ts";
import { exposedName } from "../../src/mcp/registry.ts";
import { startServer } from "../../src/server.ts";
import { ensureRuntime, discover } from "../../src/runtime/connect.ts";
import { classify } from "../../src/agent/permissions.ts";
import { closedPort } from "./mock.ts";
const engine = fileURLToPath(new URL("../stub-engine.ts", import.meta.url));
const fixture = fileURLToPath(new URL("../mcp-fixture.ts", import.meta.url));
const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "maquette-mcp-")));
const put = (dir: string, file: string, value: unknown) => { mkdirSync(join(dir, ".maquette"), { recursive: true }); writeFileSync(join(dir, file), JSON.stringify(value)); };

test("config whole-entry precedence, disabling, validation, env errors, trust invalidation and redaction", () => {
  const root = temp(), home = temp();
  put(home, ".maquette/settings.json", { mcpServers: { a: { command: "old", env: { KEY: "secret" } }, b: { command: "b" } } });
  put(root, ".mcp.json", { mcpServers: { a: { url: "https://example.com/mcp", headers: { AUTH: "${TOKEN}" } } } });
  put(root, ".maquette/settings.json", { mcpServers: { b: { disabled: true } } });
  const c = loadMcpConfig(root, home);
  assert.equal(c.entries.find(e => e.name === "a")!.config!.env, undefined);
  assert.equal(c.entries.find(e => e.name === "b")!.config!.disabled, true);
  assert.equal(isTrusted(c), false); trustProject(c); assert.equal(isTrusted(c), true);
  put(root, ".mcp.json", { mcpServers: { a: { command: "changed" } } }); assert.equal(isTrusted(loadMcpConfig(root, home)), false);
  assert.throws(() => validateMcpMap({ a: { command: "x", url: "https://a" } }), /cannot have/);
  assert.throws(() => expandCredentials({ env: { KEY: "${MISSING}" } }, {}), /Missing environment variable MISSING/);
  const redacted = JSON.stringify(redactedMcp({ a: { command: "secret", args: ["secret"], env: { KEY: "secret" }, url: "secret", headers: { AUTH: "secret" } } }));
  assert.doesNotMatch(redacted, /secret/);
  assert.notEqual(exposedName("a", "x.y"), exposedName("a", "x_y")); assert.ok(exposedName("x".repeat(100), "y".repeat(100)).length <= 64);
});

test("stdio pagination, exact routing, structured/image/error results, optional failure and explicit reconnect", async t => {
  const root = temp(), home = temp();
  put(root, ".mcp.json", { mcpServers: { local: { command: process.execPath, args: [fixture] }, broken: { command: "/no/such/program" } } });
  let s = await startServer({ root, home, port: await closedPort(), engine, version: "0.1.0" }); t.after(() => s.stop());
  assert.equal((await s.mcpStatus()).find(x => x.name === "local")!.state, "untrusted");
  trustProject(loadMcpConfig(root, home)); await s.reconnect("local"); await s.reconnect("broken");
  assert.equal((await s.mcpStatus()).find(x => x.name === "broken")!.state, "failed");
  const tool = s.tools.find(x => x.name === "local__read_echo")!; assert.equal(classify(tool), "change", "remote name/hint alone grants no read permission");
  assert.equal(s.tools.filter(x => x._maquette?.server === "local").length, 2);
  const r = await s.enqueue(exposedName("local", "odd.name"), { text: "ok", fail: true }, "http");
  assert.equal(r.ok, false); assert.deepEqual(r.result!.structuredContent, { original: "odd.name", args: { text: "ok", fail: true } }); assert.equal(r.images.length, 1);
  assert.equal((await s.enqueue("inspect_document", {}, "prompt")).ok, true);
  const old = tool._maquette!.identity; await s.reconnect("local");
  assert.equal((await s.enqueue(tool.name, {}, "model", { identity: old })).ok, false);
  const revision = s.revision; await s.enqueue(tool.name, { notify: true }, "http");
  for (let i = 0; i < 100 && s.revision === revision; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(s.revision > revision);
  const lost = await s.enqueue(tool.name, { disconnect: true }, "http"); assert.equal(lost.ok, false); assert.match(lost.text, /uncertain/);
});

test("Streamable HTTP and explicit legacy SSE fixtures discover and preserve results", async t => {
  for (const transportType of ["http", "sse"] as const) {
    const sessions = new Map<string, SSEServerTransport>(); const servers: Server[] = [];
    const make = () => {
      const s = new Server({ name: "network-fixture", version: "1" }, { capabilities: { tools: {} } }); servers.push(s);
      s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }));
      s.setRequestHandler(CallToolRequestSchema, async req => ({ content: [{ type: "text", text: "network" }], structuredContent: { input: req.params.arguments } })); return s;
    };
    const http = createServer(async (req, res) => {
      if (transportType === "http") {
        const tr = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }); await make().connect(tr);
        res.on("close", () => void tr.close()); await tr.handleRequest(req, res, req.method === "POST" ? JSON.parse(await text(req)) : undefined);
      } else if (req.method === "GET") {
        const tr = new SSEServerTransport("/messages", res); sessions.set(tr.sessionId, tr); await make().connect(tr);
      } else {
        const id = new URL(req.url!, "http://localhost").searchParams.get("sessionId")!;
        await sessions.get(id)!.handlePostMessage(req, res);
      }
    });
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    t.after(async () => { for (const s of servers) await s.close(); http.closeAllConnections(); http.close(); });
    const root = temp(), home = temp();
    put(root, ".mcp.json", { mcpServers: { network: { type: transportType, url: `http://127.0.0.1:${(http.address() as any).port}/mcp` } } });
    trustProject(loadMcpConfig(root, home));
    const runtime = await startServer({ root, home, port: await closedPort(), engine, version: "0.1.0" });
    try { const reply = await runtime.enqueue("network__echo", { value: 5 }, "http"); assert.equal(reply.ok, true, JSON.stringify(await runtime.mcpStatus())); assert.deepEqual(reply.result!.structuredContent, { input: { value: 5 } }); } finally { await runtime.stop(); }
  }
});

test("concurrent startup attaches once, refuses another root and non-runtime listener", async t => {
  const root = temp(), home = temp(), port = await closedPort(); let launches = 0;
  const launch = async () => { launches++; return { engine }; };
  const [a, b] = await Promise.all([ensureRuntime({ root, home, port, version: "0.1.0" }, launch), ensureRuntime({ root, home, port, version: "0.1.0" }, launch)]);
  t.after(() => a.owned ? a.server.stop() : b.server.stop());
  assert.equal(Number(a.owned) + Number(b.owned), 1); assert.equal(a.server.identity.runtimeId, b.server.identity.runtimeId);
  await assert.rejects(() => discover(temp(), port, "0.1.0"), /another project/);
  const guest = a.owned ? b : a; await guest.server.stop(); assert.ok(await discover(root, port, "0.1.0"));
  const ordinary = createServer((req, res) => res.end("hello")); await new Promise<void>(r => ordinary.listen(0, "127.0.0.1", r));
  t.after(() => ordinary.close()); await assert.rejects(() => discover(root, (ordinary.address() as any).port, "0.1.0"), /non-Maquette/);
});

test("external SDK MCP client shares the HTTP runtime and owns only a runtime it starts", async t => {
  const root = temp(), home = temp(); const runtime = await startServer({ root, home, port: await closedPort(), engine, version: "0.1.0" }); t.after(() => runtime.stop());
  const client = new Client({ name: "acceptance-client", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--port", String(runtime.port)], cwd: root, env: { ...process.env, HOME: home, MAQUETTE_ENGINE: engine } as any, stderr: "pipe" });
  let stderr = ""; transport.stderr?.on("data", d => stderr += d);
  await client.connect(transport); t.after(() => client.close());
  assert.ok((await client.listTools()).tools.some(t => t.name === "inspect_document"), stderr);
  const calls: string[] = []; runtime.on(e => { if (e.type === "call") calls.push(e.reply.source); });
  await Promise.all([runtime.enqueue("inspect_document", {}, "prompt"), client.callTool({ name: "inspect_document", arguments: {} })]);
  assert.deepEqual(calls, ["prompt", "mcp"]);
  await client.close(); assert.ok(await discover(root, runtime.port, "0.1.0"));
});
