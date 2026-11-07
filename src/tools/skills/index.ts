import { readSkill } from "../../skills/resolver.ts";
import type { ToolFactory } from "../types.ts";
const skills: ToolFactory = ({ root }) => ({
  name: "skills",
  tools: [{ name: "skill", description: "Load an Agent Skill's instructions, source and base directory, or a supporting UTF-8 resource confined to that skill. Read-only; never runs scripts or grants permissions.", inputSchema: { type: "object", properties: { name: { type: "string" }, path: { type: "string", description: "Optional relative text resource path within the resolved skill." } }, required: ["name"] }, annotations: { readOnlyHint: true } }],
  async call(_name, args) {
    try {
      if (typeof args.name !== "string" || (args.path !== undefined && typeof args.path !== "string")) throw new Error("Supply skill name and optional relative path as strings.");
      const s = readSkill(root, args.name, args.path as string | undefined);
      return { content: [{ type: "text", text: `Skill: ${s.name}\nSource: ${s.source}\nDirectory: ${s.directory}\nGuidance only; normal permissions still apply.\n\n${s.text}` }] };
    } catch (e) { return { content: [{ type: "text", text: (e as Error).message }], isError: true }; }
  },
});
export default skills;
