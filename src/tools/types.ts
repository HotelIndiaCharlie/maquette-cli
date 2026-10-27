// A tool module adds coarse tools to Maquette beside DesignCraft's own. The chart tool is
// the first. A new one is a folder under src/tools/ whose index.ts default-exports a
// ToolFactory, listed in src/tools/index.ts.
import type { DesignCraft, ToolResult } from "../designcraft.ts";

export type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };

export type Context = {
  dc: DesignCraft; // the one DesignCraft engine, shared by every module
  root: string; // the folder Maquette runs in; relative paths start here
  readRoots: string[]; // the folders a tool may read data files from
};

export type ToolModule = {
  name: string; // the key for this module's state beside a saved document
  instructions?: string; // how to use its tools, added to Maquette's instructions
  tools: ToolDef[];
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  // State kept beside a saved document (<file>.maquette.json), and read back when one opens
  // (undefined when there is none). Without these, a module keeps nothing between sessions.
  saved?(): unknown;
  opened?(state: unknown): void;
};

export type ToolFactory = (context: Context) => ToolModule;
