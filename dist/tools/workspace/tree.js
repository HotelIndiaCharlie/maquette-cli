// One bounded folder map used by tree and document_survey. No file content reads.
import { lstat, readdir, realpath } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { confine } from "./paths.js";
const skipped = new Set(["node_modules", ".git", ".maquette", "maquette-renders"]);
const empty = () => ({ files: 0, directories: 0, links: 0, bytes: 0, types: Object.create(null), partial: false });
const escaped = (s) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
export async function folderMap(root, path = ".", depth = 3) {
    if (!Number.isInteger(depth) || depth < 0 || depth > 6)
        throw new Error("tree depth must be an integer from 0 to 6.");
    if (typeof path !== "string" || !path)
        throw new Error("tree path must be a string.");
    // Do not traverse even a directory symlink supplied as the requested root.
    root = realpathSync(root);
    const lexical = resolve(root, path);
    let at = resolve(root);
    const parts = relative(at, lexical).split(sep).filter(Boolean);
    for (const part of parts) {
        at = join(at, part);
        if (lstatSync(at).isSymbolicLink())
            throw new Error("tree does not traverse directory symlinks. Request the containing folder.");
    }
    const start = confine(root, path);
    const canonical = await realpath(root);
    const shown = (p) => escaped(relative(canonical, p) || ".");
    let visited = 0;
    let partial = false;
    let expired = false;
    const deadline = Date.now() + 2000;
    const timeout = Symbol("timeout");
    let timer;
    const expiredPromise = new Promise(r => { timer = setTimeout(() => { expired = true; partial = true; r(timeout); }, 2000); });
    const check = () => { if (Date.now() >= deadline || visited >= 2000) {
        partial = true;
        return false;
    } return true; };
    async function io(p) { return Promise.race([p, expiredPromise]); }
    function add(sum, child) {
        if (child.kind === "directory")
            sum.directories++;
        if (child.kind === "link")
            sum.links++;
        sum.files += child.summary.files;
        sum.directories += child.summary.directories;
        sum.links += child.summary.links;
        sum.bytes += child.summary.bytes;
        for (const [ext, count] of Object.entries(child.summary.types)) {
            if (!(ext in sum.types) && Object.keys(sum.types).length >= 100) {
                sum.partial = true;
                continue;
            }
            sum.types[ext] = (sum.types[ext] ?? 0) + count;
        }
        sum.partial ||= child.partial || child.summary.partial;
    }
    async function walk(full, remaining, isRoot = false) {
        const node = { path: shown(full), kind: "unreadable", children: [], summary: empty(), partial: false };
        if (!check()) {
            node.partial = true;
            return node;
        }
        if (!isRoot)
            visited++;
        try {
            const info = await io(lstat(full));
            if (info === timeout) {
                node.partial = true;
                return node;
            }
            if (info.isSymbolicLink()) {
                node.kind = "link";
                return node;
            }
            // Check every followed entry, not symlink targets.
            const confined = confine(canonical, full);
            if (confined !== full)
                throw new Error("Entry changed to a symlink.");
            if (info.isFile()) {
                node.kind = "file";
                node.bytes = info.size;
                node.summary.files = 1;
                node.summary.bytes = info.size;
                node.summary.types[extname(full).toLowerCase() || "(none)"] = 1;
                return node;
            }
            if (!info.isDirectory())
                return node;
            node.kind = "directory";
            const names = await io(readdir(full));
            if (names === timeout) {
                node.partial = true;
                return node;
            }
            const visible = names.filter(n => !n.startsWith(".") && !skipped.has(n)).sort();
            node.visible = visible.length;
            if (remaining === 0) {
                node.partial = visible.length > 0;
                node.summary.partial = node.partial;
                return node;
            }
            for (const name of visible) {
                if (expired || !check()) {
                    node.partial = true;
                    break;
                }
                const child = await walk(join(full, name), remaining - 1);
                node.children.push(child);
                add(node.summary, child);
            }
            node.partial ||= node.summary.partial;
            node.summary.partial = node.partial;
            return node;
        }
        catch {
            node.error = "unreadable";
            node.partial = true;
            node.summary.partial = true;
            return node;
        }
    }
    try {
        const tree = await walk(start, depth, true);
        const map = { path: shown(start), depth, visited, partial: partial || tree.partial, summary: tree.summary, lines: [] };
        map.summary.partial ||= map.partial;
        while (Buffer.byteLength(JSON.stringify(map)) > 18000 && Object.keys(map.summary.types).length) {
            delete map.summary.types[Object.keys(map.summary.types).at(-1)];
            map.partial = true;
            map.summary.partial = true;
        }
        const summary = (n) => `${n.error ? "unreadable; " : ""}${n.summary.files} files, ${n.summary.directories} dirs, ${n.summary.bytes} bytes; types ${JSON.stringify(n.summary.types)}${n.partial || n.summary.partial ? " [partial: visited entries only]" : ""}`;
        const emit = (n, indent, rootNode = false) => {
            if (map.lines.length >= 249) {
                map.partial = true;
                return;
            }
            const line = `${"  ".repeat(indent)}${n.path}${n.kind === "directory" ? `/ (${summary(n)})` : n.kind === "file" ? ` (${n.bytes} bytes)` : n.kind === "link" ? " [symlink; not followed]" : " [unreadable]"}`;
            const before = [...map.lines];
            map.lines.push(line);
            if (Buffer.byteLength(JSON.stringify(map)) > 23000) {
                map.lines = before;
                map.partial = true;
                return;
            }
            if (n.kind !== "directory" || !n.children.length)
                return;
            if (!rootNode && (n.visible ?? 0) > 20) {
                map.lines.push(`${"  ".repeat(indent + 1)}[collapsed: ${n.visible} visible entries; request this directory directly]`);
                return;
            }
            const displayed = n.children.slice(0, 20);
            for (const c of displayed)
                emit(c, indent + 1);
            const omitted = (n.visible ?? 0) - displayed.length;
            if (omitted > 0) {
                map.lines.push(`${"  ".repeat(indent + 1)}[${omitted} entries omitted; use a narrower path or glob/grep]`);
            }
        };
        emit(tree, 0, true);
        if (map.partial) {
            map.summary.partial = true;
            map.hint = "Partial map: depth, unreadable entries, time, visit or output limit. Counts cover visited entries only; narrow path/depth or use glob/grep.";
        }
        while (map.lines.length > 250 || Buffer.byteLength(JSON.stringify(map)) > 24576) {
            map.lines.pop();
            map.partial = true;
            map.summary.partial = true;
            map.hint = "Partial output; request a narrower path/depth.";
        }
        return map;
    }
    finally {
        clearTimeout(timer);
    }
}
