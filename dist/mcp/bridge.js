import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
export async function serveBridge(runtime, version) {
    for (const s of await runtime.mcpStatus())
        if (s.state !== "connected" && s.state !== "disabled")
            console.error(`MCP ${s.name}: ${s.state}. ${s.message ?? ""}`);
    const caller = `mcp:${randomUUID()}`;
    const bridge = new Server({ name: "maquette", version }, { capabilities: { tools: { listChanged: true } }, instructions: `Shared Maquette runtime in ${runtime.root}. Tool calls use this host's authorization, independent of the terminal permission mode.` });
    bridge.setRequestHandler(ListToolsRequestSchema, async () => { await runtime.refresh(); return { tools: runtime.tools.map(({ _maquette, ...t }) => t) }; });
    bridge.setRequestHandler(CallToolRequestSchema, async (req) => {
        const reply = await runtime.enqueue(req.params.name, req.params.arguments ?? {}, "mcp", { caller });
        return reply.result ?? { content: [{ type: "text", text: reply.text }], isError: !reply.ok };
    });
    await bridge.connect(new StdioServerTransport());
    let revision = runtime.revision;
    const timer = setInterval(() => void runtime.refresh().then(async () => {
        if (revision !== runtime.revision) {
            revision = runtime.revision;
            await bridge.sendToolListChanged();
        }
    }).catch(() => { }), 1000);
    timer.unref();
    const off = runtime.on(e => { if (e.type === "catalogue")
        void bridge.sendToolListChanged().catch(() => { }); });
    let closed = false;
    const close = async () => { if (closed)
        return; closed = true; clearInterval(timer); off(); await bridge.close(); await runtime.stop(); };
    bridge.onclose = () => void close();
    process.once("SIGINT", () => void close());
    process.once("SIGTERM", () => void close());
    return { close };
}
