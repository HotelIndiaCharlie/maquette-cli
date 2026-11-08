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
  assert.equal(r.ok, false); assert.deepEqual(r.result!.structuredContent, { original: "odd.name", args: { text: "ok", fail: true } }); assert.equal(r.images.length, 1); assert.match(r.text, /structuredContent/);
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
  t.after(() => ordinary.close()); await assert.rejects(() => discover(temp(), (ordinary.address() as any).port, "0.1.0"), /non-Maquette/);
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

test("two simultaneous stdio facades launch one owned runtime, attached disconnect keeps it alive", async t => {
  const root = temp(), home = temp(), port = await closedPort();
  const clients = [new Client({ name: "one", version: "1" }), new Client({ name: "two", version: "1" })];
  const transports = clients.map(() => new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--port", String(port)], cwd: root, env: { ...process.env, HOME: home, MAQUETTE_ENGINE: engine } as any, stderr: "pipe" }));
  for (const tr of transports) tr.stderr?.on("data", () => {});
  t.after(async () => { for (const c of clients) await c.close(); });
  await Promise.all(clients.map((c, i) => c.connect(transports[i])));
  const identity = (await discover(root, port, "0.1.0"))!;
  const owner = transports.findIndex(tr => tr.pid === identity.ownerPid); assert.ok(owner >= 0);
  const guest = 1 - owner;
  await clients[owner].callTool({ name: "open_document", arguments: { path: "shared.designcraft" } });
  const seen = await clients[guest].callTool({ name: "inspect_document", arguments: {} }); assert.match(JSON.stringify(seen.content), /shared.designcraft/);
  await clients[guest].close(); assert.ok(await discover(root, port, "0.1.0"));
  await clients[owner].close();
  for (let i = 0; i < 100 && await discover(root, port, "0.1.0"); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(await discover(root, port, "0.1.0"), undefined);
});

test("one canonical root cannot start an engine on a second port", async t => {
  const root = temp(), home = temp(), port = await closedPort();
  const runtime = await startServer({ root, home, engine, port, version: "0.1.0" }); t.after(() => runtime.stop());
  const other = await closedPort(); let launches = 0;
  await assert.rejects(() => ensureRuntime({ root, home, port: other, version: "0.1.0" }, async () => { launches++; return { engine }; }), new RegExp(`port ${port}`));
  assert.equal(launches, 0);
  await assert.rejects(() => startServer({ root, home, engine, port: other, version: "0.1.0" }), /Already owned/);
  assert.equal((await discover(root, port, "0.1.0"))!.runtimeId, runtime.identity.runtimeId);
});

test("stdio uses the SDK safe environment unless inheritance is explicitly enabled; RPC errors are definite and stderr stays local", async t => {
  const root = temp(), home = temp();
  const previous = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = "fixture-secret-never-print";
  t.after(() => { if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous; });
  put(root, ".mcp.json", { mcpServers: { local: { command: process.execPath, args: [fixture], env: { FIXTURE_EXPLICIT: "configured" } } } }); trustProject(loadMcpConfig(root, home));
  const runtime = await startServer({ root, home, engine, port: await closedPort(), version: "0.1.0" }); t.after(() => runtime.stop());
  const r = await runtime.enqueue("local__read_echo", { environment: true }, "http");
  assert.deepEqual(JSON.parse(r.text), { providerKeyPresent: false, explicit: "configured" });
  const error = await runtime.enqueue("local__read_echo", { rpcError: true }, "http");
  assert.equal(error.ok, false); assert.match(error.text, /bad arguments from fixture/); assert.doesNotMatch(error.text, /uncertain/);
  await runtime.enqueue("local__read_echo", { diagnostic: true }, "http");
  for (let i = 0; i < 50 && !(await runtime.mcpLogs("local")).includes("UI only"); i++) await new Promise(r => setTimeout(r, 10));
  assert.match(await runtime.mcpLogs("local"), /Fixture stderr diagnostic/);
  put(root, ".mcp.json", { mcpServers: { local: { command: process.execPath, args: [fixture], inheritEnv: true } } }); trustProject(loadMcpConfig(root, home)); await runtime.reconnect("local");
  const inherited = await runtime.enqueue("local__read_echo", { environment: true }, "http"); assert.equal(JSON.parse(inherited.text).providerKeyPresent, true);
});

test("project-relative command contents invalidate trust", () => {
  const root = temp(), home = temp();
  writeFileSync(join(root, "mcp.sh"), "first version");
  put(root, ".mcp.json", { mcpServers: { local: { command: "./mcp.sh" } } });
  trustProject(loadMcpConfig(root, home)); assert.equal(isTrusted(loadMcpConfig(root, home)), true);
  writeFileSync(join(root, "mcp.sh"), "second version"); assert.equal(isTrusted(loadMcpConfig(root, home)), false);
});

test("EOF on an owning bridge stops its runtime and engine child", async t => {
  const { spawn } = await import("node:child_process"); const { existsSync, readFileSync } = await import("node:fs");
  const root = temp(), home = temp(), port = await closedPort();
  const pidfile = join(root, "engine.pid"), wrapper = join(root, "engine.ts");
  writeFileSync(wrapper, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidfile)}, String(process.pid)); await import(${JSON.stringify(new URL("../stub-engine.ts", import.meta.url).href)});`);
  const child = spawn(process.execPath, [cli, "mcp", "--port", String(port)], { cwd: root, env: { ...process.env, HOME: home, MAQUETTE_ENGINE: wrapper }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", d => stderr += d); child.stdout.resume();
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const closed = new Promise(resolve => child.once("close", resolve));
  for (let i = 0; i < 200 && (!existsSync(pidfile) || !await discover(root, port, "0.1.0")); i++) await new Promise(r => setTimeout(r, 25));
  assert.ok(existsSync(pidfile), stderr); const pid = Number(readFileSync(pidfile, "utf8"));
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { assert.equal(await closed, 0, stderr); } finally { clearTimeout(timer); }
  assert.throws(() => process.kill(pid, 0), (e: any) => e.code === "ESRCH");
  assert.equal(await discover(root, port, "0.1.0"), undefined);
});

test("a newly published built-in evicts all tools from a colliding external server", async t => {
  const { ToolRegistry } = await import("../../src/mcp/registry.ts");
  const root = temp(), home = temp();
  put(root, ".mcp.json", { mcpServers: { local: { command: process.execPath, args: [fixture] } } }); trustProject(loadMcpConfig(root, home));
  let builtinTools: any[] = [{ name: "inspect_document", inputSchema: { type: "object" } }];
  const builtin = { async listTools() { return { tools: builtinTools }; }, setNotificationHandler() {} };
  const registry = new ToolRegistry(root, "0.1.0", builtin as any, () => {}, home); t.after(() => registry.close()); await registry.start();
  assert.ok(registry.byName.has("local__read_echo"));
  const colliding = exposedName("local", "odd.name"); builtinTools = [...builtinTools, { name: colliding, inputSchema: { type: "object" } }];
  await registry.refreshBuiltin();
  assert.equal(registry.byName.get(colliding)!._maquette!.builtin, true); assert.equal(registry.byName.has("local__read_echo"), false);
  assert.equal(registry.statuses.get("local")!.state, "failed"); assert.match(registry.statuses.get("local")!.message!, /built-in tools take precedence/);
});
