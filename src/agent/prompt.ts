// What the model is told at the start of every turn, from the texts in prompts/, as three blocks: the core (who Maquette
// is, the same everywhere), the environment (this session: the folder, the engine's
// instructions, plan mode, the text protocol) and the project (MAQUETTE.md and how to weigh
// it). The first two are cache breakpoints; the project block comes last, so an edit to
// MAQUETTE.md leaves the cached blocks before it alone.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogue, type Tool } from "../args.ts";
import type { SystemBlock } from "../providers/types.ts";
import type { Mode } from "./permissions.ts";
import { fill, source, template } from "./prompts.ts";

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

// How to weigh MAQUETTE.md, said once in front of it: prompts/project-rule.md.
export const projectRule = () => template("project-rule").text;

// The project block: the rule, then the file fenced so the person's words are clearly marked.
export function projectBlock(text: string | undefined): SystemBlock {
  if (!text) return { name: "project", text: fill("no-project"), source: source(["no-project"]) };
  const fence = "~".repeat(Math.max(3, ...[...text.matchAll(/~{3,}/g)].map((m) => m[0].length + 1)));
  return { name: "project", text: fill("project", { fence, memory: text }), source: source(["project"], { fence, memory: text }) };
}

// The environment block, from the prompts that apply to this session, in this order.
export function environmentBlock(input: Omit<PromptInput, "project">): SystemBlock {
  const variables = { root: input.root, tools: input.textProtocol ? catalogue(input.tools) : "", instructions: input.instructions };
  const names = ["environment", ...(input.mode === "plan" ? ["plan-mode"] : []), ...(input.textProtocol ? ["text-protocol"] : []), "engine"];
  return { name: "environment", text: names.map((n) => fill(n, variables)).join("\n\n"), cache: true, source: source(names, variables) };
}

export const environmentText = (input: Omit<PromptInput, "project">) => environmentBlock(input).text;

export function systemPrompt(input: PromptInput): SystemBlock[] {
  return [
    { name: "core", text: fill("core"), cache: true, source: source(["core"]) },
    environmentBlock(input),
    projectBlock("project" in input ? input.project : projectInstructions(input.root)),
  ];
}
