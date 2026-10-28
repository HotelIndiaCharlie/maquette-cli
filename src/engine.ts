// The Maquette engine: an MCP server on stdio that runs DesignCraft headless, confined to
// one folder, passes DesignCraft's tools through unchanged and adds the tools of each module
// in src/tools/. Saving a document writes the modules' state beside it as
// <file>.maquette.json, with the warnings from opening it; opening one reads it back.
// `maquette` starts it as a child process.
//
//   engine.js --designcraft <cli> --root <folder>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DesignCraft, DesignCraftError, type ToolResult } from "./designcraft.ts";
import { modules as factories } from "./tools/index.ts";

const { values } = parseArgs({ options: { designcraft: { type: "string" }, root: { type: "string" } } });
if (!values.designcraft || !values.root) throw new Error("the engine needs --designcraft <cli> and --root <folder>");
const root = values.root;
const dc = await DesignCraft.start(values.designcraft, root);
const inner = (await dc.client.listTools()).tools;
// Missing links and fonts, conversion notes: what opening the document warned about. They're
// kept beside the saved document, since a working copy opened later no longer reports what
// the conversion from InDesign did.
let warnings: string[] = [];
const modules = factories.map((make) => make({ dc, root, readRoots: [root], warnings: () => warnings }));
const owner = new Map(modules.flatMap((m) => m.tools.map((t) => [t.name, m] as const)));
const sidecar = (path: string) => `${path}.maquette.json`;

function saveState(path: string | null) {
  const state: Record<string, unknown> = Object.fromEntries(modules.map((m) => [m.name, m.saved?.()]).filter(([, s]) => s !== undefined));
  if (warnings.length) state.warnings = warnings;
  if (path && Object.keys(state).length) writeFileSync(sidecar(path), JSON.stringify(state, null, 2));
}

// Reads the modules' state back, and the warnings recorded when the document was saved. Those
// a reopened working copy no longer reports go into open_document's reply as recordedWarnings,
// so the person hears of them again.
function loadState(path: string | null, opened: ToolResult): ToolResult {
  const state = path && existsSync(sidecar(path)) ? JSON.parse(readFileSync(sidecar(path), "utf8")) : {};
  for (const m of modules) m.opened?.(state[m.name]);
  const part = opened.content.find((c) => c.type === "text");
  let reply: Record<string, unknown> | undefined;
  try {
    reply = JSON.parse(part?.text ?? "");
  } catch {}
  const fresh = Array.isArray(reply?.warnings) ? reply.warnings.map(String) : [];
  const recorded = (Array.isArray(state.warnings) ? state.warnings.map(String) : []).filter((w: string) => !fresh.includes(w));
  warnings = [...fresh, ...recorded];
  if (!recorded.length || !reply || !part) return opened;
  return { ...opened, content: opened.content.map((c) => (c === part ? { ...c, text: JSON.stringify({ ...reply, recordedWarnings: recorded }, null, 2) } : c)) };
}

const instructions = ["Maquette adds coarse tools to DesignCraft; DesignCraft's own tools pass through unchanged.", ...modules.flatMap((m) => m.instructions ?? []), `DesignCraft: ${dc.instructions}`].join("\n\n");

const server = new Server({ name: "maquette", version: "0.1.0" }, { capabilities: { tools: {} }, instructions });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...modules.flatMap((m) => m.tools), ...inner] }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    const module = owner.get(name);
    if (module) return await module.call(name, args);
    const result = await dc.call(name, args);
    if (!result.isError && name === "save_document") saveState((await dc.inspect()).path);
    if (!result.isError && name === "open_document") return loadState((await dc.inspect()).path, result);
    return result;
  } catch (e) {
    const detail = e instanceof DesignCraftError && typeof e.detail === "object" ? ` ${JSON.stringify(e.detail).slice(0, 600)}` : "";
    return { content: [{ type: "text", text: `${e instanceof Error ? e.message : String(e)}${detail}` }], isError: true };
  }
});
await server.connect(new StdioServerTransport());
