// Finished output: the banner, what the person typed, answers, one line per tool call, shell
// commands, notices. Once drawn, an item never changes, so it goes in Ink's <Static>.
import { relative } from "node:path";
import { gist, tilde } from "../args.js";
import { Box, h, Static, Text } from "./h.js";
import { Markdown } from "./markdown.js";
export const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// A call's arguments on one line: the required ones bare, the rest as flags.
export function summarise(input) {
    return Object.entries(input)
        .map(([k, v]) => `--${k} ${typeof v === "string" ? v : gist(JSON.stringify(v), 40)}`)
        .join(" ");
}
export function ToolLine({ item, root, frame }) {
    const mark = !item.done ? h(Text, { color: "yellow" }, spinnerFrames[frame % spinnerFrames.length]) : item.ok ? h(Text, { color: "green" }, "✓") : h(Text, { color: "red" }, "✗");
    const bits = [mark, " "];
    if (item.source === "http")
        bits.push(h(Text, { color: "magenta" }, "http "));
    bits.push(h(Text, { bold: true }, item.name));
    const args = summarise(item.input);
    if (args)
        bits.push(h(Text, { dimColor: true }, ` ${gist(args, item.done && item.images?.length ? 50 : 70)}`));
    if (item.done) {
        if (item.ms !== undefined)
            bits.push(h(Text, { dimColor: true }, ` · ${item.ms >= 1000 ? `${(item.ms / 1000).toFixed(1)} s` : `${item.ms} ms`}`));
        for (const p of item.images ?? [])
            bits.push(h(Text, { color: "cyan" }, ` · ${relative(root, p)}`));
        if (!item.ok && item.text)
            bits.push(h(Text, { color: "red" }, ` · ${gist(item.text.split("\n")[0], 80)}`));
    }
    const detail = item.expanded ? h(Box, { flexDirection: "column", paddingLeft: 4 }, h(Text, { dimColor: true }, JSON.stringify(item.input, null, 2)), item.text ? h(Text, { color: item.ok ? undefined : "red" }, gist(item.text, 4000)) : null) : null;
    return h(Box, { flexDirection: "column" }, h(Text, {}, ...bits), detail);
}
export function renderItem(item, root) {
    switch (item.kind) {
        case "banner":
            // An empty Text draws nothing, so a blank line is drawn as a space.
            return h(Box, { flexDirection: "column", marginBottom: 1 }, ...item.lines.map((l, i) => h(Text, { key: i }, l || " ")));
        case "user":
            return h(Box, { marginTop: 1 }, h(Text, { color: "magenta", bold: true }, "❯ "), h(Text, {}, item.text));
        case "answer":
            return h(Box, { marginTop: 1, paddingLeft: 2 }, h(Markdown, { text: item.text }));
        case "tool":
            return h(Box, { paddingLeft: 2 }, h(ToolLine, { item, root, frame: 0 }));
        case "shell":
            return h(Box, { flexDirection: "column", marginTop: 1 }, h(Text, {}, h(Text, { color: "magenta", bold: true }, "! "), h(Text, { bold: true }, item.command), item.code ? h(Text, { color: "red" }, `  exit ${item.code}`) : null), item.output ? h(Box, { paddingLeft: 2 }, h(Text, { dimColor: item.code === 0 }, item.output)) : null);
        case "output":
            return h(Box, { flexDirection: "column", paddingLeft: 2 }, h(Text, { color: item.ok ? undefined : "red" }, item.text), ...(item.images ?? []).map((p, i) => h(Text, { key: i }, h(Text, { color: "cyan" }, "image "), relative(root, p), h(Text, { dimColor: true }, "  (open shows it)"))));
        case "notice":
            return h(Box, { paddingLeft: 2 }, h(Text, { color: item.level === "error" ? "red" : item.level === "warn" ? "yellow" : undefined, dimColor: item.level === "info" }, item.text));
    }
}
export function Transcript({ items, root }) {
    return h((Static), { items, children: (item) => h(Box, { key: item.key, flexDirection: "column" }, renderItem(item, root)) });
}
export const shortRoot = (root) => tilde(root);
