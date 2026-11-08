import type { Tool } from "../args.ts";
// Shared classification for the runtime feed and model inspection policy.
const workspace = new Set(["bash", "write_file", "edit_file", "open_file", "read_file", "glob", "grep", "tree", "view_image", "memory_write", "memory_add", "memory_read", "skill"]);
export function toolScope(tool: Pick<Tool, "name" | "_maquette">): "external" | "workspace" | "designcraft" {
  return tool._maquette && !tool._maquette.builtin ? "external" : workspace.has(tool.name) ? "workspace" : "designcraft";
}
export const clearsInspection = (name: string) => ["inspect_document", "document_survey", "open_document"].includes(name);
