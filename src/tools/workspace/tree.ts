// One bounded breadth-first folder map used by tree and document_survey. No content reads.
import { lstat, readdir } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { confine } from "./paths.ts";
export type FolderSummary = { files: number; directories: number; links: number; bytes: number; types: Record<string, number>; partial: boolean };
export type FolderMap = { path: string; depth: number; visited: number; partial: boolean; summary: FolderSummary; lines: string[]; hint?: string };
type Node = { full: string; path: string; kind: "directory" | "file" | "link" | "unreadable"; bytes?: number; children: Node[]; summary: FolderSummary; visible?: number; partial: boolean; collapsed?: boolean };
const skipped = new Set(["node_modules", ".git", ".maquette", "maquette-renders"]);
const empty = (): FolderSummary => ({ files: 0, directories: 0, links: 0, bytes: 0, types: Object.create(null), partial: false });
const escaped = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
export function formatFolderMap(map: FolderMap): string {
  const { lines, ...summary } = map;
  return `${lines.join("\n")}\n${JSON.stringify(summary)}`;
}
export async function folderMap(root: string, path = ".", depth = 3): Promise<FolderMap> {
  if (!Number.isInteger(depth) || depth < 0 || depth > 6) throw new Error("tree depth must be an integer from 0 to 6.");
  if (typeof path !== "string" || !path) throw new Error("tree path must be a string.");
  root = realpathSync(root);
  const lexical = resolve(root, path);
  // Check lexical containment before statting an untrusted requested path.
  const rel = relative(root, lexical);
  if (rel === ".." || rel.startsWith(`..${sep}`)) confine(root, path);
  let at = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    at = join(at, part);
    try { if (lstatSync(at).isSymbolicLink()) throw new Error("tree does not traverse directory symlinks. Request the containing folder."); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`No such folder: ${escaped(path)}`); throw e; }
  }
  const start = confine(root, path);
  if (!lstatSync(start).isDirectory()) throw new Error(`No such folder: ${escaped(path)}`);
  const node = (full: string, kind: Node["kind"]): Node => ({ full, path: escaped(relative(root, full) || "."), kind, children: [], summary: empty(), partial: false });
  const tree = node(start, "directory");
  const queue = [{ node: tree, remaining: depth }];
  const directories: Node[] = [];
  let visited = 0, expired = false;
  const timeout = Symbol("timeout");
  let timer: ReturnType<typeof setTimeout>;
  const deadline = Date.now() + 2000;
  const expiredPromise = new Promise<typeof timeout>(r => { timer = setTimeout(() => { expired = true; r(timeout); }, 2000); });
  const check = () => !expired && Date.now() < deadline && visited < 2000;
  const io = <T>(p: Promise<T>): Promise<T | typeof timeout> => Promise.race([p, expiredPromise]);
  try {
    // Each level is represented before any deeper directory. Large folders sample at
    // most 200 immediate entries and never spend the global budget on descendants.
    for (let q = 0; q < queue.length; q++) {
      const { node: current, remaining } = queue[q]; directories.push(current);
      if (!check()) { current.partial = true; continue; }
      try {
        confine(root, current.full);
        const entries = await io(readdir(current.full, { withFileTypes: true }));
        if (entries === timeout) { current.partial = true; continue; }
        const visible = entries.filter(e => !e.name.startsWith(".") && !skipped.has(e.name)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        current.visible = visible.length;
        if (remaining === 0) { current.partial = visible.length > 0; continue; }
        current.collapsed = visible.length > 20;
        const limit = Math.min(200, visible.length);
        current.partial = limit < visible.length;
        for (let i = 0; i < limit; i += 16) {
          if (!check()) { current.partial = true; break; }
          const batch = visible.slice(i, Math.min(i + 16, limit, i + 2000 - visited));
          visited += batch.length;
          const children = await Promise.all(batch.map(async e => {
            const full = join(current.full, e.name);
            const child = node(full, "unreadable");
            try {
              if (e.isSymbolicLink()) { child.kind = "link"; return child; }
              if (confine(root, full) !== full) throw new Error("Entry changed to a symlink");
              // Dirents avoid an async stat for directories; confine revalidates paths.
              if (e.isDirectory()) { child.kind = "directory"; return child; }
              const info = await io(lstat(full));
              if (info === timeout) { child.partial = true; return child; }
              if (info.isSymbolicLink()) { child.kind = "link"; return child; }
              if (info.isFile()) {
                child.kind = "file"; child.bytes = info.size; child.summary.files = 1; child.summary.bytes = info.size;
                child.summary.types[extname(full).toLowerCase() || "(none)"] = 1;
              }
            } catch { child.partial = true; }
            return child;
          }));
          current.children.push(...children);
          for (const child of children) if (child.kind === "directory") {
            if (current.collapsed) child.partial = true;
            else queue.push({ node: child, remaining: remaining - 1 });
          }
        }
      } catch { current.kind = "unreadable"; current.partial = true; }
    }
    for (const current of directories.reverse()) {
      for (const child of current.children) {
        const sum = current.summary;
        sum.files += child.summary.files; sum.bytes += child.summary.bytes;
        sum.directories += child.summary.directories + Number(child.kind === "directory");
        sum.links += child.summary.links + Number(child.kind === "link");
        for (const [ext, count] of Object.entries(child.summary.types)) {
          if (!(ext in sum.types) && Object.keys(sum.types).length >= 100) { current.partial = true; continue; }
          sum.types[ext] = (sum.types[ext] ?? 0) + count;
        }
        current.partial ||= child.partial || child.summary.partial;
      }
      current.summary.partial = current.partial;
    }
    const map: FolderMap = { path: tree.path, depth, visited, partial: tree.partial, summary: tree.summary, lines: [] };
    while (Buffer.byteLength(JSON.stringify(map.summary)) > 8000 && Object.keys(map.summary.types).length) {
      delete map.summary.types[Object.keys(map.summary.types).at(-1)!]; map.partial = true; map.summary.partial = true;
    }
    let outputBytes = Buffer.byteLength(JSON.stringify(map));
    const line = (value: string) => {
      const cost = Buffer.byteLength(JSON.stringify(value)) + 1;
      if (map.lines.length >= 250 || outputBytes + cost > 23000) { map.partial = true; return false; }
      map.lines.push(value); outputBytes += cost; return true;
    };
    const emit = (n: Node, indent: number) => {
      const sum = n.summary;
      const description = `${sum.files} files, ${sum.directories} dirs, ${sum.bytes} bytes; types ${JSON.stringify(sum.types)}${n.partial ? " [sampled/partial: visited entries only]" : ""}`;
      if (!line(`${"  ".repeat(indent)}${n.path}${n.kind === "directory" ? `/ (${description})` : n.kind === "file" ? ` (${n.bytes} bytes)` : n.kind === "link" ? " [symlink; not followed]" : " [unreadable]"}`)) return;
      if (n.collapsed && n !== tree) { line(`${"  ".repeat(indent + 1)}[collapsed: ${n.visible} visible entries; request this directory directly]`); return; }
      for (const child of n.children.slice(0, 20)) emit(child, indent + 1);
      const omitted = (n.visible ?? 0) - Math.min(20, n.children.length);
      if (omitted > 0 && n.children.length) line(`${"  ".repeat(indent + 1)}[${omitted} entries omitted; use a narrower path or glob/grep]`);
    };
    emit(tree, 0);
    if (map.partial) { map.summary.partial = true; map.hint = "Partial map: sampled large folder, depth, unreadable entries, time, visit or output limit. Counts cover visited entries only; narrow path/depth or use glob/grep."; }
    return map;
  } finally { clearTimeout(timer!); }
}
