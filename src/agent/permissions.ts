// Which of the model's calls may run on their own. Reading and rendering never change the
// document, so they always may; changes, saves and shell commands depend on the mode.
import type { Tool } from "../args.ts";

export const modes = ["ask", "auto", "plan"] as const;
export type Mode = (typeof modes)[number];
export type Kind = "read" | "change";
export type Decision = "run" | "ask" | "deny";

export const modeHelp: Record<Mode, string> = {
  ask: "reads and renders run; changes, saves and shell commands ask y/n/always",
  auto: "everything runs without asking",
  plan: "only reading; the model ends with a plan instead of making changes",
};

// By the engine's own say-so when a tool carries MCP's readOnlyHint, else by its name.
const readNames = /^(inspect|render|list|get|find|measure|read|describe|screenshot|export_text)(_|$)|_list$|^chart_list$/;
export function classify(tool: Pick<Tool, "name" | "annotations">): Kind {
  if (tool.annotations?.readOnlyHint !== undefined) return tool.annotations.readOnlyHint ? "read" : "change";
  return readNames.test(tool.name) ? "read" : "change";
}

export function decide(mode: Mode, tool: Pick<Tool, "name" | "annotations">, allowed: ReadonlySet<string>): Decision {
  if (mode === "auto") return "run";
  if (classify(tool) === "read") return "run";
  if (mode === "plan") return "deny";
  return allowed.has(tool.name) ? "run" : "ask";
}
