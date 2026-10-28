// The texts the model is told live in prompts/*.md, beside the code rather than in it, so a
// change to one reads and diffs as a document and is versioned with the code it depends on.
// A prompt fills {{name}} from its variables and takes another prompt's text with {{> name}}.
// Each is read once per run; its version is a short hash of its text with the includes in it,
// so a trace says which wording a reply came from, even before the change is committed.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PromptSource } from "../providers/types.ts";

export const promptsDir = fileURLToPath(new URL("../../prompts/", import.meta.url));

export type Template = { name: string; text: string; version: string };

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);
const loaded = new Map<string, Template>();

export function template(name: string): Template {
  let t = loaded.get(name);
  if (t) return t;
  const raw = readFileSync(`${promptsDir}${name}.md`, "utf8").replace(/\n$/, "");
  const text = raw.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, inner: string) => template(inner).text);
  t = { name, text, version: hash(text) };
  loaded.set(name, t);
  return t;
}

// The prompt with its variables in place. A variable it names but isn't given is a bug, so it throws.
export function fill(name: string, variables: Record<string, string> = {}): string {
  return template(name).text.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, key: string) => {
    if (!(key in variables)) throw new Error(`prompts/${name}.md uses {{${key}}}, which wasn't given.`);
    return variables[key];
  });
}

// One version for the prompts a block was filled from, in the order they were used.
export function source(names: string[], variables: Record<string, string> = {}): PromptSource {
  return { names, version: names.length === 1 ? template(names[0]).version : hash(names.map((n) => template(n).version).join(" ")), variables };
}
