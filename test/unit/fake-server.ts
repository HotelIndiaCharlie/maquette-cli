// A stand-in for the running server in the agent and screen tests: it records every call and
// answers from a script, with a real PNG on disk when a reply has an image.
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerLike } from "../../src/agent/session.ts";
import type { Tool } from "../../src/args.ts";
import type { Reply, ServerEvent, Source } from "../../src/server.ts";

// A 1×1 white PNG.
export const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

export const tools: Tool[] = [
  { name: "open_document", description: "Opens a document.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "inspect_document", description: "Describes the document.", inputSchema: { type: "object", properties: {} } },
  { name: "render_page", description: "Renders a page.", inputSchema: { type: "object", properties: { page: { type: "integer" } }, required: ["page"] } },
  { name: "chart_create", description: "Draws a chart.", inputSchema: { type: "object", properties: { frame: { type: "string" }, spec: { type: "object" } }, required: ["frame", "spec"] } },
  { name: "save_document", description: "Saves.", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
];

export type Call = { tool: string; args: Record<string, unknown>; source: Source };

// The real path: on macOS the temp folder is reached through a symlink, and a shell's $PWD
// resolves it, so the tests compare against the resolved form.
export function fakeServer(root = realpathSync(mkdtempSync(join(tmpdir(), "maquette-agent-")))) {
  const calls: Call[] = [];
  const listeners = new Set<(e: ServerEvent) => void>();
  let id = 0;
  let last: string | undefined;
  const handle: ServerLike & { calls: Call[]; on(l: (e: ServerEvent) => void): () => void; byName: Map<string, Tool>; emitHttp(tool: string, args: Record<string, unknown>): void } = {
    root,
    tools,
    byName: new Map(tools.map((t) => [t.name, t])),
    instructions: "Stub instructions.",
    lastImage: () => last,
    calls,
    async enqueue(tool, args, source) {
      calls.push({ tool, args, source });
      const reply: Reply = { id: ++id, tool, ok: true, text: "", images: [], source, ms: 5 };
      if (tool === "render_page" || tool === "chart_create") {
        const path = join(root, `${String(reply.id).padStart(3, "0")}-${tool}.png`);
        writeFileSync(path, Buffer.from(png, "base64"));
        reply.images.push(path);
        last = path;
        reply.text = tool === "render_page" ? `Rendered page ${args.page}.` : `Chart drawn in ${args.frame}.`;
      } else if (tool === "open_document") reply.text = String(args.path).endsWith(".idml") ? JSON.stringify({ index: 0, documentFonts: 0, warnings: ["Missing link: Links/cover.tif", "Font Akzidenz Bold isn't installed"] }) : `Opened ${args.path}.`;
      else if (tool === "inspect_document") reply.text = '{"pages":5}';
      else if (tool === "save_document") reply.text = "Saved.";
      else {
        reply.ok = false;
        reply.text = `No tool ${tool}.`;
      }
      await new Promise((r) => setTimeout(r, 1));
      for (const l of listeners) l({ type: "call", reply, args, at: new Date() });
      return reply;
    },
    on(l) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    emitHttp(tool, args) {
      const reply: Reply = { id: ++id, tool, ok: true, text: "ok", images: [], source: "http", ms: 3 };
      for (const l of listeners) l({ type: "call", reply, args, at: new Date() });
    },
  };
  return handle;
}

export const settings = (more: Partial<import("../../src/settings.ts").Settings> = {}): import("../../src/settings.ts").Settings => ({
  provider: "anthropic",
  port: 8787,
  providers: { anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY", effort: "high", maxTokens: 64000, refusalFallback: true, compaction: true }, "openai-compatible": { baseUrl: "http://localhost:11434/v1", apiKeyEnv: "OPENAI_API_KEY", vision: true } },
  permissions: { mode: "ask" },
  ...more,
});
