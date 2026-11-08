import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ServerHandle } from "../server.ts";

export async function serveBridge(runtime: ServerHandle, version: string) {
  for (const s of await runtime.mcpStatus()) if (s.state !== "connected" && s.state !== "disabled") console.error(`MCP ${s.name}: ${s.state}. ${s.message ?? ""}`);
  const caller = `mcp:${randomUUID()}`;
  const bridge = new Server({ name: "maquette", version }, { capabilities: { tools: { listChanged: true } }, instructions: `Shared Maquette runtime in ${runtime.root}. Tool calls use this host's authorization, independent of the terminal permission mode.` });
  bridge.setRequestHandler(ListToolsRequestSchema, async () => { await runtime.refresh(); return { tools: runtime.tools.map(({ _maquette, ...t }) => t) as Tool[] }; });
  bridge.setRequestHandler(CallToolRequestSchema, async req => {
    const reply = await runtime.enqueue(req.params.name, req.params.arguments ?? {}, "mcp", { caller });
    return reply.result ?? { content: [{ type: "text", text: reply.text }], isError: !reply.ok };
  });
  await bridge.connect(new StdioServerTransport());
  let revision = runtime.revision;
  const timer = setInterval(() => void fetch(`http://127.0.0.1:${runtime.port}/revision`, { signal: AbortSignal.timeout(1500) }).then(r => r.json()).then(async current => {
    if (current.runtimeId === runtime.identity.runtimeId && current.revision === revision) return;
    await runtime.refresh();
    if (revision !== runtime.revision) { revision = runtime.revision; await bridge.sendToolListChanged(); }
  }).catch(() => {}), 1000);
  timer.unref();
  const off = runtime.on(e => { if (e.type === "catalogue") void bridge.sendToolListChanged().catch(() => {}); });
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true; clearInterval(timer); off();
    process.stdin.off("end", onEnd); process.stdin.off("close", onEnd);
    process.off("SIGINT", onEnd); process.off("SIGTERM", onEnd);
    try { await bridge.close(); } finally { await runtime.stop(); }
  };
  const onEnd = () => void close();
  process.stdin.once("end", onEnd); process.stdin.once("close", onEnd);
  bridge.onclose = () => void close();
  process.once("SIGINT", onEnd); process.once("SIGTERM", onEnd);
  if (process.stdin.readableEnded) void close();
  return { close };
}
