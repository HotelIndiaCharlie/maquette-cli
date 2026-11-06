// A stand-in for src/engine.ts in tests: an MCP server on stdio with a few scripted tools and
// no DesignCraft, so `maquette` can start anywhere. MAQUETTE_ENGINE points Maquette at it.
// The workspace tools are the real ones, in the folder the engine starts in, since they
// need no DesignCraft.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { DesignCraft } from "../src/designcraft.ts";
import workspaceTools from "../src/tools/workspace/index.ts";

// A 1×1 white PNG.
export const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

const tools = [
  { name: "open_document", description: "Opens a document. Makes it the active one.", inputSchema: { type: "object", properties: { path: { type: "string", description: "The file" } }, required: ["path"] } },
  { name: "save_document", description: "Saves the active document.", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "inspect_document", description: "Describes the active document.", inputSchema: { type: "object", properties: {} } },
  { name: "render_page", description: "Renders a page as an image.", inputSchema: { type: "object", properties: { page: { type: "integer", description: "The page, from 0" } }, required: ["page"] } },
  { name: "chart_create", description: "Draws a chart into a frame. Checks the drawing.", inputSchema: { type: "object", properties: { frame: { type: "string" }, spec: { type: "object" }, preview: { type: "boolean" } }, required: ["frame", "spec"] } },
  { name: "chart_list", description: "Lists the charts.", inputSchema: { type: "object", properties: {} } },
  { name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
  { name: "slow", description: "Takes a while.", inputSchema: { type: "object", properties: { ms: { type: "integer" } } } },
];

const workspace = workspaceTools({ dc: {} as DesignCraft, root: process.cwd(), readRoots: [process.cwd()], warnings: () => [] });

let open: string | null = null;
const server = new Server({ name: "stub", version: "0" }, { capabilities: { tools: {} }, instructions: "Stub engine: nothing is really drawn." });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools, ...workspace.tools] }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const text = (t: string) => ({ content: [{ type: "text", text: t }] });
  if (workspace.tools.some((t) => t.name === name)) return workspace.call(name, args);
  switch (name) {
    case "open_document":
      open = String(args.path);
      return text(`Opened ${open}.`);
    case "save_document":
      return text(`Saved ${args.path ?? open ?? "nothing"}.`);
    case "inspect_document":
      return text(JSON.stringify({ path: open, pages: 5 }));
    case "render_page":
      return { content: [{ type: "text", text: `Rendered page ${args.page}.` }, { type: "image", data: png, mimeType: "image/png" }] };
    case "chart_create":
      return { content: [{ type: "text", text: `Chart drawn in ${args.frame}. All 12 marks sit where the data puts them. No overset text.` }, { type: "image", data: png, mimeType: "image/png" }] };
    case "chart_list":
      return text("[]");
    case "slow":
      await new Promise((r) => setTimeout(r, Number(args.ms ?? 200)));
      return text("Done.");
    default:
      return { content: [{ type: "text", text: `${name} failed on purpose.` }], isError: true };
  }
});
await server.connect(new StdioServerTransport());
