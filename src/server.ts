// The running Maquette behind the prompt: the engine as a child process, the queue that runs
// calls one at a time on the one document, and the HTTP server other sessions call. It prints
// nothing; it emits events, and the plain log or the Ink screen draws them.
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join } from "node:path";
import { text as readAll } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { projectInstructions } from "./agent/prompt.ts";
import { stamp, type Tool } from "./args.ts";
import type { ToolResult } from "./designcraft.ts";

// Where a call came from: typed at the prompt, asked for by the model, or sent over HTTP.
export type Source = "prompt" | "model" | "http";
export type Reply = { id: number; tool: string; ok: boolean; text: string; images: string[]; source: Source; ms: number };

const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export type ServerEvent =
  | { type: "call"; reply: Reply; args: Record<string, unknown>; at: Date } // a call finished, with everything its log line shows
  | { type: "engine_log"; text: string } // a line the engine wrote to stderr
  | { type: "engine_closed" };

export type ServerHandle = {
  root: string;
  port: number;
  tools: Tool[];
  byName: Map<string, Tool>;
  instructions: string;
  images: string; // where renders are saved: maquette-renders/<start>/
  lastImage(): string | undefined;
  enqueue(tool: string, args: Record<string, unknown>, source: Source): Promise<Reply>;
  on(listener: (event: ServerEvent) => void): () => void;
  stop(): Promise<void>;
};

export type ServerOptions = {
  port: number;
  version: string;
  root?: string;
  // The DesignCraft CLI the engine runs; or, for tests, another engine script to run in place
  // of src/engine.ts, which then needs no DesignCraft.
  cli?: string;
  engine?: string;
};

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const root = options.root ?? process.cwd();
  const { port } = options;
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "maquette", version: options.version });
  // The engine runs under this same Node, as source (.ts) or built (.js) like this file.
  const engine = options.engine ?? fileURLToPath(new URL(`./engine${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
  const args = options.engine ? [engine] : [engine, "--designcraft", options.cli!, "--root", root];
  const transport = new StdioClientTransport({ command: process.execPath, args: [...process.execArgv, ...args], cwd: root, stderr: "pipe" });
  const listeners = new Set<(event: ServerEvent) => void>();
  const emit = (event: ServerEvent) => {
    for (const l of listeners) l(event);
  };
  transport.stderr?.on("data", (d: Buffer) => emit({ type: "engine_log", text: d.toString() }));
  await client.connect(transport);
  const tools = (await client.listTools()).tools as Tool[];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const instructions = client.getInstructions() ?? "";
  const images = join(root, "maquette-renders", stamp(new Date()));
  let count = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let lastImage: string | undefined;
  let stopping = false;

  // Calls the tool and saves any images under maquette-renders/<start>/, so the reply carries paths.
  async function run(id: number, tool: string, args: Record<string, unknown>, source: Source): Promise<Reply> {
    const t0 = Date.now();
    const reply: Reply = { id, tool, ok: false, text: "", images: [], source, ms: 0 };
    try {
      const r = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 600_000 })) as ToolResult;
      const texts: string[] = [];
      for (const c of r.content) {
        if (c.type === "text") texts.push(c.text ?? "");
        else if (c.type === "image" && c.data) {
          mkdirSync(images, { recursive: true });
          const n = reply.images.length ? `-${reply.images.length + 1}` : "";
          const path = join(images, `${String(id).padStart(3, "0")}-${tool}${n}.${extensions[c.mimeType ?? ""] ?? "png"}`);
          writeFileSync(path, Buffer.from(c.data, "base64"));
          reply.images.push(path);
          lastImage = path;
        } else texts.push(JSON.stringify(c));
      }
      reply.ok = !r.isError;
      reply.text = texts.join("\n");
    } catch (e) {
      reply.text = e instanceof Error ? e.message : String(e);
    }
    reply.ms = Date.now() - t0;
    emit({ type: "call", reply, args, at: new Date() });
    return reply;
  }

  // DesignCraft holds one document, so calls from the prompt, the model and HTTP run one at a
  // time, in arrival order.
  function enqueue(tool: string, args: Record<string, unknown>, source: Source): Promise<Reply> {
    const id = ++count;
    const reply = queue.then(() => run(id, tool, args, source));
    queue = reply;
    return reply;
  }

  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const server: Server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    // Local clients sending JSON only: the Host check stops DNS rebinding, and a web page
    // can't post JSON here without a CORS preflight, which this server never answers.
    if (!hosts.has(req.headers.host ?? "")) return send(403, { ok: false, text: "Only local clients may call this server." });
    // `project` is MAQUETTE.md as it is now, so every session works to the same design memory.
    if (req.method === "GET" && req.url === "/tools") return send(200, { root, instructions, project: projectInstructions(root) ?? null, tools });
    if (req.method !== "POST" || req.url !== "/call") return send(404, { ok: false, text: "POST /call {tool, arguments}, or GET /tools." });
    if (!req.headers["content-type"]?.startsWith("application/json")) return send(415, { ok: false, text: "Send the call as application/json." });
    let body: { tool?: unknown; arguments?: unknown };
    try {
      body = JSON.parse(await readAll(req));
    } catch {
      return send(400, { ok: false, text: "The body isn't JSON." });
    }
    const { tool, arguments: args = {} } = body;
    if (typeof tool !== "string" || !byName.has(tool)) return send(400, { ok: false, text: `No tool named ${JSON.stringify(tool)}; GET /tools lists them.` });
    if (typeof args !== "object" || args === null || Array.isArray(args)) return send(400, { ok: false, text: "arguments must be a JSON object." });
    send(200, await enqueue(tool, args as Record<string, unknown>, "http"));
  });

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeAllConnections();
    await client.close();
  };
  client.onclose = () => {
    if (!stopping) emit({ type: "engine_closed" });
  };
  await new Promise<void>((done, failed) => {
    server.once("error", async (e: NodeJS.ErrnoException) => {
      stopping = true;
      await client.close();
      failed(new Error(e.code === "EADDRINUSE" ? `Port ${port} is in use by another program. Pick another port with --port.` : e.message));
    });
    server.listen(port, "127.0.0.1", done);
  });

  return {
    root,
    port,
    tools,
    byName,
    instructions,
    images,
    lastImage: () => lastImage,
    enqueue,
    on(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    stop,
  };
}
