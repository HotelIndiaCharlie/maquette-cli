// Runtime-owned tool registry and one FIFO shared by terminal, HTTP and the MCP facade.
import { classify } from "./agent/permissions.ts";
import { ChangeRing, type ChangeCursor, type ChangeFeed } from "./runtime/changes.ts";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join } from "node:path";
import { text as readAll } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { projectInstructions } from "./agent/prompt.ts";
import { stamp, type Tool } from "./args.ts";
import { ToolRegistry, type McpStatus } from "./mcp/registry.ts";
import { acquireLock } from "./runtime/lock.ts";

export const runtimeProtocol = "maquette-runtime-v1";
export type Source = "prompt" | "model" | "http" | "mcp";
export type CallOptions = { caller?: string; identity?: string; cursor?: ChangeCursor };
export type Reply = { id: number; tool: string; ok: boolean; text: string; images: string[]; source: Source; ms: number; result?: CallToolResult; caller?: string };
export type RuntimeIdentity = { protocol: string; version: string; root: string; runtimeId: string; ownerPid: number };
const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
export type ServerEvent =
  | { type: "call"; reply: Reply; args: Record<string, unknown>; at: Date }
  | { type: "engine_log"; text: string }
  | { type: "engine_closed" }
  | { type: "catalogue"; revision: number };
export type ServerHandle = {
  root: string; port: number; tools: Tool[]; byName: Map<string, Tool>; instructions: string; images: string;
  identity: RuntimeIdentity; revision: number; changeSequence: number;
  changes(cursor?: ChangeCursor): Promise<ChangeFeed>;
  lastImage(): string | undefined;
  enqueue(tool: string, args: Record<string, unknown>, source: Source, options?: CallOptions): Promise<Reply>;
  mcpStatus(): Promise<McpStatus[]>;
  reconnect(name: string): Promise<void>;
  refresh(): Promise<void>;
  on(listener: (event: ServerEvent) => void): () => void;
  stop(): Promise<void>;
};
export type ServerOptions = { port: number; version: string; root?: string; cli?: string; engine?: string; home?: string };

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const root = realpathSync(options.root ?? process.cwd());
  const release = acquireLock(join(tmpdir(), `maquette-runtime-${process.getuid?.() ?? "user"}-${createHash("sha256").update(`${root}:${options.port}`).digest("hex")}.lock`));
  const client = new Client({ name: "maquette", version: options.version });
  const engine = options.engine ?? fileURLToPath(new URL(`./engine${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
  const args = options.engine ? [engine] : [engine, "--designcraft", options.cli!, "--root", root];
  const transport = new StdioClientTransport({ command: process.execPath, args: [...process.execArgv, ...args], cwd: root, stderr: "pipe" });
  const listeners = new Set<(event: ServerEvent) => void>();
  const emit = (event: ServerEvent) => { for (const l of listeners) l(event); };
  transport.stderr?.on("data", (d: Buffer) => emit({ type: "engine_log", text: d.toString() }));
  let server: Server | undefined;
  let registry: ToolRegistry | undefined;
  let stopping = false;
  try {
    await client.connect(transport, { timeout: 10_000 });
    const identity: RuntimeIdentity = { protocol: runtimeProtocol, version: options.version, root, runtimeId: randomUUID(), ownerPid: process.pid };
    const changes = new ChangeRing(identity.runtimeId);
    registry = new ToolRegistry(root, options.version, client, () => emit({ type: "catalogue", revision: registry?.revision ?? 0 }), options.home);
    await registry.start();
    const live = registry;
    const instructions = client.getInstructions() ?? "";
    const images = join(root, "maquette-renders", `${stamp(new Date())}-${identity.runtimeId.slice(0, 8)}`);
    let count = 0; let queue: Promise<unknown> = Promise.resolve(); let lastImage: string | undefined;
    async function run(id: number, tool: string, args: Record<string, unknown>, source: Source, options: CallOptions): Promise<Reply> {
      const t0 = Date.now();
      const reply: Reply = { id, tool, ok: false, text: "", images: [], source, ms: 0, caller: options.caller ?? source };
      const definition = live.byName.get(tool);
      try {
        const before = changes.since(options.cursor);
        const stale = options.cursor && (before.gap || before.changes.some(e => e.caller !== options.caller));
        const r = definition && classify(definition) !== "read" && stale
          ? { content: [{ type: "text" as const, text: "Another caller changed shared state after this model step began. Inspect current state before editing; this call was not run." }], isError: true }
          : await live.call(tool, args, options.identity);
        reply.result = r;
        const texts: string[] = [];
        for (const c of r.content) {
          if (c.type === "text") texts.push(c.text);
          else if (c.type === "image") {
            mkdirSync(images, { recursive: true });
            const n = reply.images.length ? `-${reply.images.length + 1}` : "";
            const safe = tool.replace(/[^A-Za-z0-9_-]/g, "_");
            const path = join(images, `${String(id).padStart(3, "0")}-${safe}${n}.${extensions[c.mimeType] ?? "bin"}`);
            writeFileSync(path, Buffer.from(c.data, "base64")); reply.images.push(path); lastImage = path;
          } else texts.push(JSON.stringify(c));
        }
        if (r.structuredContent !== undefined) texts.push(JSON.stringify({ structuredContent: r.structuredContent }));
        reply.ok = !r.isError; reply.text = texts.join("\n");
      } catch (e) { reply.text = e instanceof Error ? e.message : String(e); }
      if (reply.ok && definition && classify(definition) === "change") {
        const scope = definition._maquette && !definition._maquette.builtin ? "external" : /^(bash|write_file|edit_file|open_file|memory_write|memory_add)$/.test(tool) ? "workspace" : "designcraft";
        changes.append({ caller: reply.caller!, tool, source, scope, server: definition._maquette?.server });
      }
      reply.ms = Date.now() - t0;
      emit({ type: "call", reply, args, at: new Date() }); return reply;
    }
    function enqueue(tool: string, args: Record<string, unknown>, source: Source, callOptions: CallOptions = {}): Promise<Reply> {
      const id = ++count;
      const reply = queue.then(() => run(id, tool, args, source, callOptions));
      queue = reply.catch(() => {}); return reply;
    }
    let actualPort = options.port;
    server = createServer(async (req, res) => {
      const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      try {
        if (![ `127.0.0.1:${actualPort}`, `localhost:${actualPort}` ].includes(req.headers.host ?? "")) return send(403, { ok: false, text: "Only local clients may call this server." });
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${actualPort}`);
        const claimedRoot = req.headers["x-maquette-root"] ?? url.searchParams.get("root");
        if (claimedRoot && claimedRoot !== root) return send(409, { ok: false, text: "Runtime belongs to another project root." });
        if (req.method === "GET" && url.pathname === "/identity") return send(200, identity);
        if (req.method === "GET" && url.pathname === "/tools") return send(200, { ...identity, revision: live.revision, changeSequence: changes.sequence, root, instructions, project: projectInstructions(root) ?? null, tools: live.tools });
        if (req.method === "GET" && url.pathname === "/changes") {
          if (claimedRoot !== root) return send(409, { ok: false, text: "Changes require the canonical project root." });
          const runtime = url.searchParams.get("runtime"); const after = Number(url.searchParams.get("after") ?? 0);
          if (!Number.isSafeInteger(after) || after < 0) return send(400, { ok: false, text: "after must be a non-negative integer cursor." });
          return send(200, changes.since(runtime ? { runtime, after } : undefined));
        }
        if (req.method === "GET" && url.pathname === "/mcp") return send(200, { servers: [...live.statuses.values()] });
        if (req.method !== "POST" || !["/call", "/mcp/reconnect"].includes(url.pathname)) return send(404, { ok: false, text: "POST /call {tool, arguments}, or GET /tools." });
        if (!req.headers["content-type"]?.startsWith("application/json")) return send(415, { ok: false, text: "Send the call as application/json." });
        let body;
        try { body = JSON.parse(await readAll(req)); } catch { return send(400, { ok: false, text: "The body isn't JSON." }); }
        if (!body || typeof body !== "object" || Array.isArray(body)) return send(400, { ok: false, text: "The body must be an object." });
        if (url.pathname === "/mcp/reconnect") {
          if (typeof body.name !== "string") return send(400, { ok: false, text: "name must be a server name." });
          await live.reconnect(body.name); return send(200, { ok: true });
        }
        const { tool, arguments: args = {} } = body;
        if (typeof tool !== "string" || !live.byName.has(tool)) return send(400, { ok: false, text: `No tool named ${JSON.stringify(tool)}; GET /tools lists them.` });
        if (typeof args !== "object" || args === null || Array.isArray(args)) return send(400, { ok: false, text: "arguments must be a JSON object." });
        return send(200, await enqueue(tool, args, body.source === "mcp" ? "mcp" : "http", { caller: typeof body.caller === "string" ? body.caller.slice(0, 128) : "http", identity: typeof body.identity === "string" ? body.identity : undefined, cursor: body.cursor && typeof body.cursor.runtime === "string" && Number.isSafeInteger(body.cursor.after) && body.cursor.after >= 0 ? body.cursor : undefined }));
      } catch { if (!res.headersSent) send(500, { ok: false, text: "Runtime request failed; inspect state before retrying a call." }); }
    });
    client.onclose = () => { if (!stopping) emit({ type: "engine_closed" }); };
    await new Promise<void>((done, failed) => {
      server!.once("error", (e: NodeJS.ErrnoException) => failed(new Error(e.code === "EADDRINUSE" ? `Port ${options.port} is in use by another program. Pick another port with --port.` : e.message)));
      server!.listen(options.port, "127.0.0.1", done);
    });
    actualPort = (server.address() as import("node:net").AddressInfo).port;
    return { root, port: actualPort, identity, get changeSequence() { return changes.sequence; }, changes: async cursor => changes.since(cursor), get revision() { return live.revision; }, get tools() { return live.tools; }, get byName() { return live.byName; }, instructions, images,
      lastImage: () => lastImage, enqueue, mcpStatus: async () => [...live.statuses.values()], reconnect: name => live.reconnect(name), refresh: async () => {},
      on(listener) { listeners.add(listener); return () => void listeners.delete(listener); },
      async stop() { if (stopping) return; stopping = true; server!.close(); server!.closeAllConnections(); await queue; await live.close(); await client.close(); release(); },
    };
  } catch (e) { stopping = true; server?.close(); server?.closeAllConnections(); await registry?.close(); await client.close().catch(() => {}); release(); throw e; }
}
