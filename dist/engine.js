// The Maquette engine: an MCP server on stdio that runs DesignCraft headless, confined to
// one folder, passes DesignCraft's tools through unchanged and adds the tools of each module
// in src/tools/. Saving a document writes the modules' state beside it as
// <file>.maquette.json; opening one reads it back. `maquette` starts it as a child process.
//
//   engine.js --designcraft <cli> --root <folder>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DesignCraft, DesignCraftError } from "./designcraft.js";
import { modules as factories } from "./tools/index.js";
const { values } = parseArgs({ options: { designcraft: { type: "string" }, root: { type: "string" } } });
if (!values.designcraft || !values.root)
    throw new Error("the engine needs --designcraft <cli> and --root <folder>");
const root = values.root;
const dc = await DesignCraft.start(values.designcraft, root);
const inner = (await dc.client.listTools()).tools;
const modules = factories.map((make) => make({ dc, root, readRoots: [root] }));
const owner = new Map(modules.flatMap((m) => m.tools.map((t) => [t.name, m])));
const sidecar = (path) => `${path}.maquette.json`;
function saveState(path) {
    const state = Object.fromEntries(modules.map((m) => [m.name, m.saved?.()]).filter(([, s]) => s !== undefined));
    if (path && Object.keys(state).length)
        writeFileSync(sidecar(path), JSON.stringify(state, null, 2));
}
function loadState(path) {
    const state = path && existsSync(sidecar(path)) ? JSON.parse(readFileSync(sidecar(path), "utf8")) : {};
    for (const m of modules)
        m.opened?.(state[m.name]);
}
const instructions = ["Maquette adds coarse tools to DesignCraft; DesignCraft's own tools pass through unchanged.", ...modules.flatMap((m) => m.instructions ?? []), `DesignCraft: ${dc.instructions}`].join("\n\n");
const server = new Server({ name: "maquette", version: "0.1.0" }, { capabilities: { tools: {} }, instructions });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...modules.flatMap((m) => m.tools), ...inner] }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;
    const args = (req.params.arguments ?? {});
    try {
        const module = owner.get(name);
        if (module)
            return await module.call(name, args);
        const result = await dc.call(name, args);
        if (!result.isError && name === "save_document")
            saveState((await dc.inspect()).path);
        if (!result.isError && name === "open_document")
            loadState((await dc.inspect()).path);
        return result;
    }
    catch (e) {
        const detail = e instanceof DesignCraftError && typeof e.detail === "object" ? ` ${JSON.stringify(e.detail).slice(0, 600)}` : "";
        return { content: [{ type: "text", text: `${e instanceof Error ? e.message : String(e)}${detail}` }], isError: true };
    }
});
await server.connect(new StdioServerTransport());
