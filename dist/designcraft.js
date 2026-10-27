// DesignCraft over MCP: runs the DesignCraft CLI as a child process and calls its tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
export class DesignCraftError extends Error {
    detail;
    constructor(message, detail) {
        super(message);
        this.detail = detail;
    }
}
export class DesignCraft {
    client;
    instructions;
    constructor(client) {
        this.client = client;
        this.instructions = client.getInstructions() ?? "";
    }
    // Runs `<cli> mcp`, reading and writing only inside `root`, and connects to it.
    static async start(cli, root) {
        const args = ["mcp", "--automation-read-root", root, "--automation-write-root", root];
        const transport = new StdioClientTransport({ command: cli, args, cwd: root, stderr: "inherit" });
        const client = new Client({ name: "maquette", version: "0.1.0" });
        await client.connect(transport);
        return new DesignCraft(client);
    }
    async call(name, args = {}) {
        return (await this.client.callTool({ name, arguments: args }));
    }
    // A tool's JSON result; a tool error becomes a DesignCraftError carrying the parsed detail.
    async json(name, args = {}) {
        const result = await this.call(name, args);
        const text = result.content.find((c) => c.type === "text")?.text ?? "";
        if (result.isError) {
            let detail = text;
            try {
                detail = JSON.parse(text);
            }
            catch { }
            throw new DesignCraftError(typeof detail === "object" ? detail.error ?? text : text, detail);
        }
        return text ? JSON.parse(text) : null;
    }
    execute(command, params = {}) {
        return this.json("execute", { command, params });
    }
    async batch(commands) {
        if (!commands.length)
            return [];
        return (await this.json("batch", { commands })).results;
    }
    inspect() {
        return this.json("inspect_document");
    }
}
// Builds a batch whose later commands refer to earlier results as "$N.path".
export class Batch {
    commands = [];
    add(command, params = {}) {
        this.commands.push({ command, params });
        return this.commands.length - 1;
    }
    static ref(step, path) {
        return `$${step}.${path}`;
    }
}
