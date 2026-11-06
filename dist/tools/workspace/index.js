// The workspace tools: the shell, files and images in the folder Maquette runs in, so the
// model can read a CSV, run the tests or look at a reference image without a second terminal.
// The file tools are confined to the folder as DesignCraft is: a path that leads outside it,
// by `../`, an absolute path or a symlink, is refused. Writes, edits, `bash` and `open_file`
// count as changes, so in ask mode they ask first; reads, `glob`, `grep` and `view_image` don't.
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runShell } from "../../agent/shell.js";
import { expandHome, tilde } from "../../args.js";
import { imageType } from "../../images.js";
const text = (t) => ({ type: "text", text: t });
const ok = (t) => ({ content: [text(t)] });
const refuse = (t) => ({ content: [text(t)], isError: true });
class Refused extends Error {
}
// Never walked: they're large and nobody means them.
const skip = new Set(["node_modules", ".git"]);
const readCap = 200_000; // characters of a file read_file gives back at once
const imageCap = 5 * 1024 * 1024; // the largest image models take
const binary = (bytes) => bytes.subarray(0, 8000).includes(0);
// The real path `p` names inside `root`, following every symlink on the way, or a Refused
// error when it leads outside. A file that doesn't exist yet is checked through its nearest
// existing folder, so write_file can make it; a dangling symlink is refused.
export function confine(root, p) {
    const realRoot = realpathSync(root);
    const outside = () => new Refused(`${p} is outside ${tilde(realRoot)}. These tools only work inside the folder Maquette runs in.`);
    const target = resolve(realRoot, expandHome(p));
    const rest = [];
    let at = target;
    for (;;) {
        let exists = true;
        try {
            lstatSync(at);
        }
        catch {
            exists = false;
        }
        if (exists) {
            let real;
            try {
                real = realpathSync(at);
            }
            catch {
                throw outside(); // a symlink that leads nowhere could lead anywhere once written
            }
            const full = join(real, ...rest);
            if (full !== realRoot && !full.startsWith(realRoot + sep))
                throw outside();
            return full;
        }
        if (dirname(at) === at)
            throw outside();
        rest.unshift(basename(at));
        at = dirname(at);
    }
}
// A glob as a regular expression over /-separated paths: `**` crosses folders, `*` and `?`
// don't, `{a,b}` is either, `[…]` a set.
export function globRegex(pattern) {
    let re = "";
    let depth = 0;
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === "*" && pattern[i + 1] === "*") {
            const slash = pattern[i + 2] === "/";
            re += slash ? "(?:.*/)?" : ".*";
            i += slash ? 2 : 1;
        }
        else if (ch === "*")
            re += "[^/]*";
        else if (ch === "?")
            re += "[^/]";
        else if (ch === "{")
            [re, depth] = [`${re}(?:`, depth + 1];
        else if (ch === "}" && depth)
            [re, depth] = [`${re})`, depth - 1];
        else if (ch === "," && depth)
            re += "|";
        else if (ch === "[") {
            const end = pattern.indexOf("]", i + 1);
            if (end < 0)
                re += "\\[";
            else {
                re += `[${pattern.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
                i = end;
            }
        }
        else
            re += ch.replace(/[.+^$()|{}\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`);
}
// Every file under `dir` (a real path inside `root`), as paths relative to `root`, in order.
// Symlinks are followed only when they stay inside the folder.
function* files(root, dir) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    }
    catch {
        return;
    }
    for (const e of entries) {
        if (skip.has(e.name))
            continue;
        const path = join(dir, e.name);
        let isDir = e.isDirectory();
        if (e.isSymbolicLink()) {
            try {
                const real = realpathSync(path);
                if (real !== root && !real.startsWith(root + sep))
                    continue;
                if (statSync(real).isDirectory()) {
                    if (real === root || (dir + sep).startsWith(real + sep))
                        continue; // a loop back up
                    isDir = true;
                }
            }
            catch {
                continue;
            }
        }
        if (isDir)
            yield* files(root, path);
        else
            yield relative(root, path).split(sep).join("/");
    }
}
// The folder a glob can start from: its segments before the first wildcard.
const base = (pattern) => {
    const parts = pattern.split("/");
    const fixed = parts.findIndex((s) => /[*?[{]/.test(s));
    return parts.slice(0, fixed < 0 ? parts.length - 1 : fixed).join("/");
};
const tools = [
    {
        name: "bash",
        description: "Run a shell command in the folder Maquette runs in, and get its output (stdout and stderr together, capped) and exit code. For tests, scripts, wc, ls and the like. It stops at its timeout. Not for reading or changing files that read_file, write_file and edit_file can handle.",
        inputSchema: {
            type: "object",
            properties: {
                command: { type: "string", description: "The command, as /bin/sh would read it (cmd on Windows)" },
                timeout: { type: "integer", description: "Seconds before it's stopped (default 120, at most 300)" },
            },
            required: ["command"],
        },
        annotations: { readOnlyHint: false },
    },
    {
        name: "read_file",
        description: "Read a text file inside the folder Maquette runs in. Long files come in parts: offset and limit pick the lines. For images use view_image.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "The file, relative to the folder" },
                offset: { type: "integer", description: "The first line to read, from 1 (default 1)" },
                limit: { type: "integer", description: "How many lines (default 2000)" },
            },
            required: ["path"],
        },
        annotations: { readOnlyHint: true },
    },
    {
        name: "write_file",
        description: "Write a text file inside the folder Maquette runs in: the whole file, replacing what's there and making its folders if needed. For a small change to an existing file, edit_file is safer.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "The file, relative to the folder" },
                text: { type: "string", description: "The whole file" },
            },
            required: ["path", "text"],
        },
        annotations: { readOnlyHint: false },
    },
    {
        name: "edit_file",
        description: "Change a text file inside the folder Maquette runs in by replacing one exact piece of text. search must match exactly once: give enough of the text around it to make it unique.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "The file, relative to the folder" },
                search: { type: "string", description: "The exact text to replace, matching once in the file" },
                replace: { type: "string", description: "What goes in its place (empty to delete it)" },
            },
            required: ["path", "search", "replace"],
        },
        annotations: { readOnlyHint: false },
    },
    {
        name: "glob",
        description: 'List the files inside the folder Maquette runs in whose paths match a pattern, such as "example/data/*.csv" or "**/*.json". ** crosses folders, {a,b} is either. node_modules and .git are left out.',
        inputSchema: {
            type: "object",
            properties: { pattern: { type: "string", description: "The pattern, relative to the folder" } },
            required: ["pattern"],
        },
        annotations: { readOnlyHint: true },
    },
    {
        name: "grep",
        description: "Search the text files inside the folder Maquette runs in for a regular expression, and get each matching line as path:line: text.",
        inputSchema: {
            type: "object",
            properties: {
                pattern: { type: "string", description: "A JavaScript regular expression" },
                path: { type: "string", description: 'A file or folder to search, relative to the folder (default ".")' },
                glob: { type: "string", description: 'Only files matching this pattern, such as "*.csv" (by name) or "example/**/*.json" (by path)' },
                ignore_case: { type: "boolean", description: "Match regardless of case" },
            },
            required: ["pattern"],
        },
        annotations: { readOnlyHint: true },
    },
    {
        name: "view_image",
        description: "Look at a PNG, JPEG, GIF or WebP image file: it comes back to you as an image. The type is read from the file's bytes, not its name. Any readable path, ~ included, since a reference image often lives elsewhere.",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string", description: "The image file, relative to the folder, absolute, or from ~" } },
            required: ["path"],
        },
        annotations: { readOnlyHint: true },
    },
    {
        name: "open_file",
        description: "Open a file inside the folder Maquette runs in with the system's viewer (Preview on a Mac), for the person to look at: a render, a PDF, a saved document.",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string", description: "The file, relative to the folder" } },
            required: ["path"],
        },
        annotations: { readOnlyHint: false },
    },
];
const workspace = ({ root }) => {
    const shown = (real) => relative(realpathSync(root), real) || ".";
    const str = (args, key) => {
        const v = args[key];
        if (typeof v !== "string" || (v === "" && key !== "replace"))
            throw new Refused(`${key} is needed.`);
        return v;
    };
    const readText = (path) => {
        const bytes = readFileSync(path);
        if (binary(bytes))
            throw new Refused(`${shown(path)} isn't a text file.${imageType(bytes) ? " It's an image: view_image shows it." : ""}`);
        return bytes.toString("utf8");
    };
    async function call(name, args) {
        switch (name) {
            case "bash": {
                const seconds = Math.min(300, Math.max(1, typeof args.timeout === "number" ? args.timeout : 120));
                const { output, code, timedOut } = await runShell(str(args, "command"), root, { timeout: seconds * 1000, cap: 30_000 });
                const status = timedOut ? "" : `\n(exit code ${code ?? "none"})`;
                return { content: [text(`${output || "(no output)"}${status}`)], isError: code !== 0 };
            }
            case "read_file": {
                const path = confine(root, str(args, "path"));
                if (statSync(path).isDirectory())
                    throw new Refused(`${shown(path)} is a folder; glob lists what's in it.`);
                const lines = readText(path).replace(/\n$/, "").split("\n");
                const from = Math.max(1, Math.floor(Number(args.offset ?? 1)) || 1);
                const limit = Math.max(1, Math.floor(Number(args.limit ?? 2000)) || 2000);
                let part = lines.slice(from - 1, from - 1 + limit);
                let body = part.join("\n");
                if (body.length > readCap) {
                    part = body.slice(0, readCap).split("\n").slice(0, -1);
                    body = part.join("\n");
                }
                const next = from + part.length;
                const more = next <= lines.length ? `\n… ${lines.length - next + 1} more lines; read on with offset ${next}.` : "";
                return ok(`${body}${more}` || `${shown(path)} is empty.`);
            }
            case "write_file": {
                const path = confine(root, str(args, "path"));
                const body = typeof args.text === "string" ? args.text : str(args, "text");
                let had = false;
                try {
                    had = statSync(path).isFile();
                }
                catch { }
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, body);
                return ok(`${had ? "Replaced" : "Wrote"} ${shown(path)}: ${body.split("\n").length} lines.`);
            }
            case "edit_file": {
                const path = confine(root, str(args, "path"));
                const search = str(args, "search");
                const replace = str(args, "replace");
                const body = readText(path);
                const at = body.indexOf(search);
                if (at < 0)
                    return refuse(`search isn't in ${shown(path)}. read_file shows its text as it is now; copy the piece exactly, spaces and line breaks too.`);
                let count = 0;
                for (let i = at; i >= 0; i = body.indexOf(search, i + search.length))
                    count++;
                if (count > 1)
                    return refuse(`search matches ${count} times in ${shown(path)}. Give more of the text around the one you mean, so it matches once.`);
                writeFileSync(path, body.slice(0, at) + replace + body.slice(at + search.length));
                return ok(`Edited ${shown(path)} at line ${body.slice(0, at).split("\n").length}.`);
            }
            case "glob": {
                const realRoot = realpathSync(root);
                let pattern = str(args, "pattern").replace(/^\.\//, "");
                if (isAbsolute(pattern))
                    pattern = relative(realRoot, pattern).split(sep).join("/");
                if (pattern.split("/").includes(".."))
                    throw new Refused(`${args.pattern} is outside ${tilde(realRoot)}. These tools only work inside the folder Maquette runs in.`);
                const start = confine(root, base(pattern) || ".");
                const re = globRegex(pattern);
                const found = [];
                let more = 0;
                for (const f of files(realRoot, start)) {
                    if (!re.test(f))
                        continue;
                    if (found.length < 500)
                        found.push(f);
                    else
                        more++;
                }
                return ok(found.length ? `${found.join("\n")}${more ? `\n… and ${more} more` : ""}` : `Nothing matches ${pattern}.`);
            }
            case "grep": {
                const realRoot = realpathSync(root);
                let re;
                try {
                    re = new RegExp(str(args, "pattern"), args.ignore_case === true ? "i" : "");
                }
                catch (e) {
                    return refuse(`That isn't a regular expression: ${e.message}`);
                }
                const start = confine(root, typeof args.path === "string" && args.path ? args.path : ".");
                const only = typeof args.glob === "string" && args.glob ? args.glob : undefined;
                const filter = only ? globRegex(only) : undefined;
                const list = statSync(start).isDirectory() ? files(realRoot, start) : [relative(realRoot, start).split(sep).join("/")];
                const hits = [];
                let more = 0;
                for (const f of list) {
                    if (filter && !filter.test(only.includes("/") ? f : f.split("/").at(-1)))
                        continue;
                    const full = join(realRoot, f);
                    let bytes;
                    try {
                        if (statSync(full).size > 5_000_000)
                            continue;
                        bytes = readFileSync(full);
                    }
                    catch {
                        continue;
                    }
                    if (binary(bytes))
                        continue;
                    for (const [i, line] of bytes.toString("utf8").split("\n").entries()) {
                        if (!re.test(line))
                            continue;
                        if (hits.length < 200)
                            hits.push(`${f}:${i + 1}: ${line.length > 300 ? `${line.slice(0, 299)}…` : line}`);
                        else
                            more++;
                    }
                }
                return ok(hits.length ? `${hits.join("\n")}${more ? `\n… and ${more} more matching lines` : ""}` : "No line matches.");
            }
            case "view_image": {
                const path = resolve(root, expandHome(str(args, "path")));
                let bytes;
                try {
                    bytes = readFileSync(path);
                }
                catch {
                    return refuse(`There's no file at ${tilde(path)}.`);
                }
                const mimeType = imageType(bytes);
                if (!mimeType)
                    return refuse(`${tilde(path)} isn't a PNG, JPEG, GIF or WebP image, which are what models can see.`);
                if (bytes.length > imageCap)
                    return refuse(`${tilde(path)} is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; models take images up to 5 MB. Make a smaller copy with bash (sips -Z 2000 on a Mac) and view that.`);
                return { content: [{ type: "image", data: bytes.toString("base64"), mimeType }, text(`${tilde(path)}: ${mimeType}, ${Math.round(bytes.length / 1024)} KB.`)] };
            }
            case "open_file": {
                const path = confine(root, str(args, "path"));
                statSync(path);
                const [command, ...rest] = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", '""'] : ["xdg-open"];
                const child = spawn(command, [...rest, path], { detached: true, stdio: "ignore" });
                child.on("error", () => { });
                child.unref();
                return ok(`Opened ${shown(path)} in the system viewer.`);
            }
        }
        return refuse(`The workspace module has no tool ${name}.`);
    }
    return {
        name: "workspace",
        instructions: "The workspace tools work with the folder Maquette runs in: read_file, write_file and edit_file for text files, glob and grep to find them, bash for commands such as tests and scripts, view_image to look at an image file, open_file to show the person a file. They don't reach outside the folder, except view_image. Prefer read_file, glob and grep to cat, find and grep through bash.",
        tools,
        async call(name, args) {
            try {
                return await call(name, args);
            }
            catch (e) {
                if (e instanceof Refused)
                    return refuse(e.message);
                const code = e.code;
                if (code === "ENOENT")
                    return refuse(`There's no such file: ${String(args.path ?? args.pattern ?? "")}.`);
                if (code === "EISDIR")
                    return refuse(`${String(args.path)} is a folder.`);
                throw e;
            }
        },
    };
};
export default workspace;
