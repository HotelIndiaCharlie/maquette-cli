// What the model is told at the start of every turn, as three blocks: the core (who Maquette
// is, the same everywhere), the environment (this session: the folder, the engine's
// instructions, plan mode, the text protocol) and the project (MAQUETTE.md and how to weigh
// it). The first two are cache breakpoints; the project block comes last, so an edit to
// MAQUETTE.md leaves the cached blocks before it alone.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogue, type Tool } from "../args.ts";
import type { SystemBlock } from "../providers/types.ts";
import { CORE } from "./core.ts";
import type { Mode } from "./permissions.ts";

export type PromptInput = {
  root: string;
  instructions: string;
  tools: Tool[];
  mode: Mode;
  textProtocol: boolean; // the model can't call tools, so it writes `maquette call` lines instead
  project?: string; // MAQUETTE.md's text as read for this turn; read from root when left out
};

export function projectInstructions(root: string): string | undefined {
  const file = join(root, "MAQUETTE.md");
  return existsSync(file) ? readFileSync(file, "utf8").trim() || undefined : undefined;
}

// How to weigh MAQUETTE.md, said once in front of it.
export const projectRule = `MAQUETTE.md is the design memory of this project, written by the person or by /init from a survey of the document: purpose and audience, voice, visual identity by role, conventions, decisions, do and don't. Follow it over your own defaults. Decisions marked stated are settled unless the person reopens them. Decisions marked inferred are hypotheses: follow them, and confirm one only when a job turns on it, never as a routine question. When the person's request departs from this file, do what they ask, say in one line that it departs, and offer to record the change. Facts about the document, ids, bounds, what sits on a page, come from inspect_document, not from this file.`;

export const noProject = "This project has no design memory yet: there's no MAQUETTE.md in the folder. /init writes one from a survey of the document. When the person makes a design decision worth keeping, you may mention /init once; not before.";

// The project block: the rule, then the file fenced so the person's words are clearly marked.
export function projectBlock(text: string | undefined): SystemBlock {
  if (!text) return { name: "project", text: noProject };
  const fence = "~".repeat(Math.max(3, ...[...text.matchAll(/~{3,}/g)].map((m) => m[0].length + 1)));
  return { name: "project", text: `The project's design memory.\n\n${projectRule}\n\nMAQUETTE.md, as the person keeps it:\n${fence}markdown\n${text}\n${fence}` };
}

export function environmentText(input: Omit<PromptInput, "project">): string {
  const parts = [
    `Maquette runs DesignCraft headless in ${input.root}. Paths in tool calls are relative to that folder, and DesignCraft reads and writes only inside it. Renders come back to you as images.`,
  ];
  if (input.mode === "plan") parts.push("Plan mode: you may only read and render. Don't call tools that change the document, save files or run commands; the request would be refused. Look at what's needed, then end with a short numbered plan of the calls you would make.");
  if (input.textProtocol) {
    parts.push(
      "This model can't call tools directly, so call them by writing lines of the form `maquette call <tool> --flag value`, each on its own line. Required arguments can go without their flag, in the order listed; objects take JSON. Maquette runs each line, after asking the person, and sends you the results. When you don't need any more calls, answer in plain words with no `maquette call` lines.",
      `The tools, one per line:\n${catalogue(input.tools)}`,
    );
  }
  parts.push(`The engine's instructions:\n\n${input.instructions}`);
  return parts.join("\n\n");
}

export function systemPrompt(input: PromptInput): SystemBlock[] {
  return [
    { name: "core", text: CORE, cache: true },
    { name: "environment", text: environmentText(input), cache: true },
    projectBlock("project" in input ? input.project : projectInstructions(input.root)),
  ];
}
