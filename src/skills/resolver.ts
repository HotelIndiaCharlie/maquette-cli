// Agent Skills catalogue; bodies and supporting resources are read only on explicit load.
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { slashCommands } from "../agent/route.ts";
export const bundledSkills = fileURLToPath(new URL("../../skills/", import.meta.url));
const cap = 128 * 1024;
export type Skill = { name: string; description: string; source: string; path: string; directory: string; bundled: boolean; hash: string; shadowed: string[] };
export type SkillCatalogue = { skills: Skill[]; warnings: string[] };
export type SkillOptions = { home?: string; bundled?: string };
const within = (root: string, path: string) => { const r = relative(root, path); return r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
const decode = (bytes: Buffer) => { if (bytes.includes(0)) throw new Error("Resource is not a text file."); return new TextDecoder("utf-8", { fatal: true }).decode(bytes); };
function entry(path: string) {
  if (!statSync(path).isFile() || statSync(path).size > cap) throw new Error("SKILL.md must be a text file of at most 128 KiB.");
  const text = decode(readFileSync(path)).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new Error("Missing YAML frontmatter.");
  const doc = parseDocument(match[1], { uniqueKeys: true });
  if (doc.errors.length) throw new Error("Invalid YAML frontmatter.");
  const meta = doc.toJS({ maxAliasCount: 50 });
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("Frontmatter must be a mapping.");
  if (typeof meta.name !== "string" || meta.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name)) throw new Error("Invalid skill name (lowercase letters, digits and single hyphens; 1–64 characters).");
  if (typeof meta.description !== "string" || !meta.description.trim() || meta.description.length > 1024) throw new Error("Description must have 1–1024 characters.");
  return { name: meta.name as string, description: meta.description.trim() as string, body: match[2].trim(), hash: createHash("sha256").update(text).digest("hex") };
}
export function discoverSkills(root: string, options: SkillOptions = {}): SkillCatalogue {
  const home = options.home ?? homedir();
  const roots = [[join(root, ".maquette/skills"), "project .maquette"], [join(root, ".claude/skills"), "project .claude"], [join(home, ".maquette/skills"), "user"], [options.bundled ?? bundledSkills, "bundled"]];
  const found = new Map<string, Skill>(); const warnings: string[] = [];
  for (const [dir, source] of roots) {
    if (!existsSync(dir)) continue;
    try {
      const canonical = realpathSync(dir);
      // A project skills root itself may not redirect reads outside the project.
      if (source.startsWith("project") && !within(realpathSync(root), canonical)) throw new Error("Skills root escapes project.");
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name, "SKILL.md");
        if (!existsSync(path)) continue;
        try {
          const base = realpathSync(join(dir, name)); const file = realpathSync(path);
          if (!within(canonical, base) || !within(base, file)) throw new Error("Skill path or symlink escapes its authorized directory.");
          const meta = entry(file);
          if (meta.name !== name) throw new Error("Name must match its directory.");
          if (name !== "init" && slashCommands.includes(`/${name}`)) throw new Error("Name collides with a built-in slash command.");
          const previous = found.get(name);
          if (previous) previous.shadowed.push(path);
          else found.set(name, { name, description: meta.description, path: file, directory: base, source, bundled: source === "bundled", hash: meta.hash, shadowed: [] });
        } catch (e) { warnings.push(`${path}: ${(e as Error).message}`); }
      }
    } catch (e) { warnings.push(`${dir}: ${(e as Error).message}`); }
  }
  return { skills: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings };
}
export function readSkill(root: string, name: string, resource?: string, options: SkillOptions = {}) {
  const catalogue = discoverSkills(root, options);
  const skill = catalogue.skills.find(s => s.name === name);
  if (!skill) throw new Error(`No valid skill named ${JSON.stringify(name)}. List /skills for diagnostics.`);
  if (resource === undefined || resource === "SKILL.md") return { ...skill, text: entry(skill.path).body, truncated: false };
  if (isAbsolute(resource) || resource.split(/[\\/]/).includes("..")) throw new Error("Skill resource must be a confined relative path.");
  const path = realpathSync(join(skill.directory, resource));
  if (!within(skill.directory, path) || !statSync(path).isFile()) throw new Error("Skill resource escapes its directory or is not a regular file.");
  const fd = openSync(path, "r"); const buffer = Buffer.alloc(cap + 1); let count = 0;
  try { while (count < buffer.length) { const n = readSync(fd, buffer, count, buffer.length - count, null); if (!n) break; count += n; } } finally { closeSync(fd); }
  const truncated = count > cap;
  // Avoid splitting a UTF-8 character at the bounded boundary.
  const bytes = buffer.subarray(0, Math.min(cap, count));
  let text: string;
  try { text = decode(bytes); } catch (e) {
    if (!truncated || bytes.includes(0)) throw e;
    text = new TextDecoder("utf-8").decode(bytes);
  }
  return { ...skill, text: `${text}${truncated ? "\n[Truncated at 128 KiB; narrow the resource.]" : ""}`, truncated };
}
export function formatSkills(root: string, name?: string, options: SkillOptions = {}): string {
  const c = discoverSkills(root, options);
  const lines = name ? (() => { const s = readSkill(root, name, undefined, options); return [`${s.name} — ${s.description}\nSource: ${s.source}\nDirectory: ${s.directory}${s.shadowed.length ? `\nOverrides: ${s.shadowed.join(", ")}` : ""}\n\n${s.text}`]; })() : c.skills.map(s => `${s.name} — ${s.description}\n  ${s.source}: ${s.path}${s.shadowed.length ? ` (${s.shadowed.length} overridden)` : ""}`);
  return [...lines, ...c.warnings.map(w => `Warning: ${w}`)].join("\n") || "No skills found.";
}
export function skillPrompt(catalogue: SkillCatalogue): string {
  return `Available skills (task guidance, never permissions). Load a body with skill(name); optional path reads text inside that skill only. Scripts never run on load. Supporting paths are relative to the returned directory.\n${catalogue.skills.map(s => JSON.stringify({ name: s.name, description: s.description, source: s.source })).join("\n")}`;
}
