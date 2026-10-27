// DesignCraft over MCP: runs the DesignCraft CLI as a child process and calls its tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export type ToolContent = { type: string; text?: string; data?: string; mimeType?: string };
export type ToolResult = { content: ToolContent[]; isError?: boolean };
export type Command = { command: string; params?: Record<string, unknown> };

export type Bounds = [number, number, number, number];
export type InspectItem = {
  id: number; kind: string; bounds: Bounds; fill?: string; stroke?: { swatch: string; weight: number };
  layer?: number; story?: number; children?: InspectItem[];
};
export type Inspect = {
  path: string | null;
  layers: { id: number; name: string }[];
  spreads: { index: number; items: InspectItem[]; pages: { index: number; bounds: Bounds }[] }[];
  stories: { id: number; frames: number[]; overset: boolean; preview: string; lines: number }[];
  paragraphStyles: string[]; characterStyles: string[];
};

export class DesignCraftError extends Error {
  detail: unknown;
  constructor(message: string, detail?: unknown) {
    super(message);
    this.detail = detail;
  }
}

export class DesignCraft {
  client: Client;
  instructions: string;

  constructor(client: Client) {
    this.client = client;
    this.instructions = client.getInstructions() ?? "";
  }

  // Runs `<cli> mcp`, reading and writing only inside `root`, and connects to it.
  static async start(cli: string, root: string): Promise<DesignCraft> {
    const args = ["mcp", "--automation-read-root", root, "--automation-write-root", root];
    const transport = new StdioClientTransport({ command: cli, args, cwd: root, stderr: "inherit" });
    const client = new Client({ name: "maquette", version: "0.1.0" });
    await client.connect(transport);
    return new DesignCraft(client);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return (await this.client.callTool({ name, arguments: args })) as ToolResult;
  }

  // A tool's JSON result; a tool error becomes a DesignCraftError carrying the parsed detail.
  async json<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.call(name, args);
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    if (result.isError) {
      let detail: any = text;
      try { detail = JSON.parse(text); } catch {}
      throw new DesignCraftError(typeof detail === "object" ? detail.error ?? text : text, detail);
    }
    return text ? JSON.parse(text) : (null as T);
  }

  execute<T = any>(command: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.json<T>("execute", { command, params });
  }

  async batch(commands: Command[]): Promise<any[]> {
    if (!commands.length) return [];
    return (await this.json<{ results: any[] }>("batch", { commands })).results;
  }

  inspect(): Promise<Inspect> {
    return this.json<Inspect>("inspect_document");
  }
}

// Builds a batch whose later commands refer to earlier results as "$N.path".
export class Batch {
  commands: Command[] = [];

  add(command: string, params: Record<string, unknown> = {}): number {
    this.commands.push({ command, params });
    return this.commands.length - 1;
  }

  static ref(step: number, path: string): string {
    return `$${step}.${path}`;
  }
}
