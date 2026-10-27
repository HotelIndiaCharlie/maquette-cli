// What the prompt, `maquette call`, the agent's text protocol and tab completion share: how a
// typed line splits into words, how words become a tool's arguments, and how tools and
// paths are shown. Nothing here touches the engine or the screen.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { relative, resolve } from "node:path";
export const two = (n) => String(n).padStart(2, "0");
export const clock = (d = new Date()) => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
export const stamp = (d) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${clock(d).replaceAll(":", "")}`;
export const gist = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const tilde = (p) => (p === homedir() || p.startsWith(`${homedir()}/`) ? `~${p.slice(homedir().length)}` : p);
// A path inside this folder relative to it, else from ~.
export const shortPath = (p, cwd = process.cwd()) => (p.startsWith(`${cwd}/`) ? relative(cwd, p) : tilde(p));
export const expandHome = (p) => p.replace(/^~(?=\/|$)/, homedir());
// Colour only on a terminal, as `ls` does. The Ink screen keeps it on, since Ink's text
// carries colour codes through unchanged.
export const color = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
export const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
// Splits a typed line as a shell would: quotes group words, a backslash escapes a character.
export function words(line) {
    const out = [];
    let word = "", quote = "", started = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
            if (ch === quote)
                quote = "";
            else if (ch === "\\" && quote === '"' && i + 1 < line.length)
                word += line[++i];
            else
                word += ch;
        }
        else if (ch === '"' || ch === "'")
            [quote, started] = [ch, true];
        else if (ch === "\\" && i + 1 < line.length)
            [word, started] = [word + line[++i], true];
        else if (/\s/.test(ch)) {
            if (started)
                out.push(word);
            [word, started] = ["", false];
        }
        else
            [word, started] = [word + ch, true];
    }
    if (quote)
        throw new Error(`a ${quote} isn't closed`);
    if (started)
        out.push(word);
    return out;
}
export const kind = (p) => [p?.type].flat()[0];
// One argument's value, by its type in the tool's schema. @file reads JSON from a file, found
// from `base` (the folder Maquette runs in).
export function value(raw, type, base) {
    if (type === "string")
        return raw;
    if (raw.startsWith("@"))
        return JSON.parse(readFileSync(resolve(base, expandHome(raw.slice(1))), "utf8"));
    if (type === "number" || type === "integer") {
        if (raw.trim() === "" || Number.isNaN(Number(raw)))
            throw new Error(`"${raw}" isn't a number`);
        return Number(raw);
    }
    if (type === "boolean") {
        if (raw !== "true" && raw !== "false")
            throw new Error(`"${raw}" isn't true or false`);
        return raw === "true";
    }
    try {
        return JSON.parse(raw);
    }
    catch {
        if (type === "object" || type === "array")
            throw new Error(`"${gist(raw, 40)}" isn't JSON; give it as JSON or @file`);
        return raw;
    }
}
// A tool's arguments from what was typed after its name: --flag value (or --flag=value), a
// bare --flag for true and --no-flag for false, a dotted --params.label for a nested field, and
// bare words for the required arguments in order. A single {…} or @file is the whole set.
export function toArgs(tool, tokens, base) {
    if (tokens.length === 1 && /^[{@]/.test(tokens[0])) {
        const all = value(tokens[0], "object", base);
        if (typeof all !== "object" || all === null || Array.isArray(all))
            throw new Error("the arguments must be a JSON object");
        return all;
    }
    const props = tool.inputSchema.properties ?? {};
    const known = Object.keys(props).length ? `its flags are ${Object.keys(props).map((k) => `--${k}`).join(", ")}` : "it takes no arguments";
    const args = {};
    const bare = [];
    for (let i = 0; i < tokens.length; i++) {
        const m = /^--(no-)?([^=]+)(?:=(.*))?$/s.exec(tokens[i]);
        if (!m) {
            bare.push(tokens[i]);
            continue;
        }
        const [, no, key, inline] = m;
        const path = key.split(".");
        if (!(path[0] in props))
            throw new Error(`${tool.name} has no --${path[0]}; ${known}`);
        const type = no ? "boolean" : path.length === 1 ? kind(props[key]) : undefined;
        let raw = no ? "false" : inline;
        if (raw === undefined) {
            const next = tokens[i + 1];
            const hasNext = next !== undefined && !next.startsWith("--");
            if (type === "boolean")
                raw = hasNext && (next === "true" || next === "false") ? tokens[++i] : "true";
            else if (hasNext)
                raw = tokens[++i];
            else if (type === undefined)
                raw = "true";
            else
                throw new Error(`--${key} needs a value`);
        }
        let into = args;
        for (const k of path.slice(0, -1))
            into = (into[k] ??= {});
        into[path.at(-1)] = value(raw, type, base);
    }
    const open = (tool.inputSchema.required ?? []).filter((k) => !(k in args));
    for (const word of bare) {
        const key = open.shift();
        if (!key)
            throw new Error(`there's no argument left for "${word}"; give it as --flag value (${known})`);
        args[key] = value(word, kind(props[key]), base);
    }
    return args;
}
// The arguments a tool call was typed with: `after` is the line after the tool's name.
export function parseCall(tool, after, base) {
    return toArgs(tool, after.trimStart().startsWith("{") ? [after.trim()] : words(after), base);
}
// A tool's description and flags, for `help <tool>` and `maquette tools <tool>`.
export function describe(tool) {
    const props = Object.entries(tool.inputSchema.properties ?? {});
    const required = tool.inputSchema.required ?? [];
    const placeholder = { string: "<text>", integer: "<n>", number: "<n>", boolean: "", object: "<json|@file>", array: "<json|@file>" };
    const flags = props.map(([k, p]) => [`--${k} ${placeholder[kind(p) ?? ""] ?? "<value>"}${required.includes(k) ? " (required)" : ""}`, p.description ?? ""]);
    const width = Math.max(0, ...flags.map(([f]) => f.length));
    const form = `${tool.name}${required.map((k) => ` <${k}>`).join("")}${props.length > required.length ? " [--flags]" : ""}`;
    return [`${paint(1, form)}\n`, tool.description ?? "", flags.length ? `\nFlags:\n${flags.map(([f, d]) => `  ${f.padEnd(width)}  ${d}`).join("\n")}` : "\nNo arguments."].join("\n");
}
// The first sentence of each tool's description.
export function catalogue(tools) {
    const width = Math.max(...tools.map((t) => t.name.length));
    return tools.map((t) => `${t.name.padEnd(width)}  ${gist((t.description ?? "").split("\n")[0].split(/(?<=[a-z]\.)\s(?=[A-Z])/)[0], 110)}`).join("\n");
}
