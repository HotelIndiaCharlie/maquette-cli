import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: { listChanged: true } } });
server.setRequestHandler(ListToolsRequestSchema, async req => req.params?.cursor ? ({ tools: [{ name: "odd.name", inputSchema: { type: "object" } }] }) : ({ tools: [{ name: "read_echo", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true } }], nextCursor: "page2" }));
server.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.arguments?.notify) await server.sendToolListChanged();
  if (req.params.arguments?.disconnect) { setTimeout(() => process.exit(0), 1); await new Promise(() => {}); }
  return { content: [{ type: "text", text: `${req.params.name}:${req.params.arguments?.text ?? ""}` }, { type: "image", mimeType: "image/png", data: png }], structuredContent: { original: req.params.name, args: req.params.arguments }, isError: req.params.arguments?.fail === true };
});
await server.connect(new StdioServerTransport());
