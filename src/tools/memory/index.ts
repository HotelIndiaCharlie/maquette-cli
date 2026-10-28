// The project's design memory, MAQUETTE.md in the folder Maquette runs in: /init writes it
// with memory_write, and a design call made in conversation is kept with memory_add, one dated
// line under Decisions. Both change a file the person owns, so in ask mode they ask first.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContent } from "../../designcraft.ts";
import type { ToolFactory } from "../types.ts";

const text = (t: string): ToolContent => ({ type: "text", text: t });
// About four characters a token: the file goes into every prompt, so it should stay short.
const tokens = (s: string) => Math.round(s.length / 4);
const budget = 2000;

// Adds `line` as a list item at the end of the `## <section>` section, making the section (and
// the file) when there isn't one.
export function addLine(file: string, section: string, line: string): string {
  const body = file.replace(/\s+$/, "");
  const lines = body ? body.split("\n") : ["# Design memory"];
  const heading = lines.findIndex((l) => new RegExp(`^##\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i").test(l));
  if (heading < 0) return `${[...lines, "", `## ${section}`, "", line].join("\n")}\n`;
  let end = lines.findIndex((l, i) => i > heading && /^#{1,2}\s/.test(l));
  if (end < 0) end = lines.length;
  while (end > heading + 1 && lines[end - 1].trim() === "") end--;
  lines.splice(end, 0, ...(end === heading + 1 ? ["", line] : [line]));
  return `${lines.join("\n")}\n`;
}

const memory: ToolFactory = ({ root }) => {
  const path = join(root, "MAQUETTE.md");
  const read = () => (existsSync(path) ? readFileSync(path, "utf8") : "");
  const size = (s: string) => {
    const n = tokens(s);
    return `about ${n} tokens${n > budget ? `, over the ${budget} it should stay under since it's in every prompt: tighten it` : ""}`;
  };

  return {
    name: "memory",
    instructions:
      "MAQUETTE.md is the project's design memory. /init writes it with memory_write. When the person makes a design call worth keeping, offer to record it, and with their yes call memory_add with one short line; never record on your own. On an existing file, never rewrite the person's words: propose changes, and replace the file only after they agree.",
    tools: [
      {
        name: "memory_write",
        description:
          "Write MAQUETTE.md, the project's design memory, in the folder Maquette runs in: the whole file, as Markdown. Refuses to replace an existing file unless replace is true, which is only for after the person has seen and agreed to the changes.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "The whole file, Markdown" },
            replace: { type: "boolean", description: "Replace an existing MAQUETTE.md (only once the person has agreed to the changes)" },
          },
          required: ["text"],
        },
      },
      {
        name: "memory_add",
        description: 'Add one dated line to MAQUETTE.md, at the end of a section ("Decisions" unless named), making the section or the file if needed. For a design call the person made and agreed to record.',
        inputSchema: {
          type: "object",
          properties: {
            line: { type: "string", description: "The decision, one short sentence" },
            section: { type: "string", description: 'The section heading, without ## (default "Decisions")' },
          },
          required: ["line"],
        },
      },
    ],
    async call(name, args) {
      if (name === "memory_write") {
        const body = String(args.text ?? "").trim();
        if (!body) return { content: [text("memory_write needs the file's text.")], isError: true };
        const had = existsSync(path);
        if (had && args.replace !== true) return { content: [text("MAQUETTE.md exists. Show the person the changes you propose, as a short list or diff, and once they agree call memory_write again with replace: true. Their own words stay as they wrote them.")], isError: true };
        writeFileSync(path, `${body}\n`);
        return { content: [text(`${had ? "Replaced" : "Wrote"} MAQUETTE.md: ${body.split("\n").length} lines, ${size(body)}.`)] };
      }
      const line = String(args.line ?? "").trim().replace(/^[-*]\s+/, "");
      if (!line) return { content: [text("memory_add needs the line to add.")], isError: true };
      const section = String(args.section ?? "Decisions").trim().replace(/^#+\s*/, "") || "Decisions";
      const entry = `- ${new Date().toISOString().slice(0, 10)}: ${line}`;
      const next = addLine(read(), section, entry);
      writeFileSync(path, next);
      return { content: [text(`Added to MAQUETTE.md under ${section}: ${entry}\nThe file is now ${size(next)}.`)] };
    },
  };
};

export default memory;
