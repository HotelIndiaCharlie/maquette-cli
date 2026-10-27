// The tool modules Maquette loads, in the order their tools are listed.
import chart from "./chart/index.ts";
import type { ToolFactory } from "./types.ts";

export const modules: ToolFactory[] = [chart];
