// Finished output: the banner, what the person typed, answers, one line per tool call, shell
// commands, notices. Once drawn, an item never changes, so it goes in Ink's <Static>.
import { relative } from "node:path";
import { gist, tilde } from "../args.ts";
import { Box, h, type ReactNode, Static, Text } from "./h.ts";
import { Markdown } from "./markdown.ts";

export type { DisplayTool as ToolItem } from "../agent/presentation.ts";
import type { DisplayTool as ToolItem, DisplayItem } from "../agent/presentation.ts";
export type ItemBody = DisplayItem | { kind: "banner"; lines: string[] };
export type Item = ItemBody & { key: number };

export const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// A call's arguments on one line: the required ones bare, the rest as flags.
export function summarise(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([k, v]) => `--${k} ${typeof v === "string" ? v : gist(JSON.stringify(v), 40)}`)
    .join(" ");
}

export function ToolLine({ item, root, frame }: { item: ToolItem; root: string; frame: number }) {
  const argumentsText = item.expanded ? JSON.stringify(item.input, null, 2) : "";
  const mark = !item.done ? h(Text, { color: "yellow" }, spinnerFrames[frame % spinnerFrames.length]) : item.ok ? h(Text, { color: "green" }, "✓") : h(Text, { color: "red" }, "✗");
  const bits: ReactNode[] = [mark, " "];
  if (item.source === "http" || item.source === "mcp") bits.push(h(Text, { color: "magenta" }, `${item.source} `));
  bits.push(h(Text, { bold: true }, item.name));
  if (item.calls?.length) bits.push(h(Text, { dimColor: true }, ` ×${item.calls.length}, same result`));
  const args = summarise(item.input);
  if (args) bits.push(h(Text, { dimColor: true }, ` ${gist(args, item.done && item.images?.length ? 50 : 70)}`));
  if (item.done) {
    if (item.ms !== undefined) bits.push(h(Text, { dimColor: true }, ` · ${item.ms >= 1000 ? `${(item.ms / 1000).toFixed(1)} s` : `${item.ms} ms`}`));
    for (const p of item.images ?? []) bits.push(h(Text, { color: "cyan" }, ` · ${relative(root, p)}`));
    if (item.source === "prompt" && item.ok && item.text) bits.push(h(Text, { dimColor: true }, ` \u00b7 ${gist(item.text.replace(/\s+/g, " "), 120)}`));
    if (!item.ok && item.text) bits.push(h(Text, { color: "red" }, ` · ${gist(item.text.split("\n")[0], 80)}`));
  }
  const detail = item.expanded ? h(Box, { flexDirection: "column", paddingLeft: 4 }, h(Text, { dimColor: true }, gist(argumentsText, 2000)), argumentsText.length > 2000 ? h(Text, { color: "yellow" }, "Arguments truncated; full arguments are in the call records.") : null, item.calls ? h(Text, { dimColor: true }, item.calls.slice(-20).map(c => `${c.id} (${c.ms ?? 0} ms)`).join("\n"), item.calls.length > 20 ? "\nEarlier call IDs omitted; see full call records." : "") : null, item.text ? h(Text, { color: item.ok ? undefined : "red" }, gist(item.text, 4000)) : null, (item.text?.length ?? 0) > 4000 ? h(Text, { color: "yellow" }, "Result truncated; full result is in the call records.") : null) : null;
  return h(Box, { flexDirection: "column" }, h(Text, {}, ...bits), detail);
}

export function renderItem(item: Item, root: string): ReactNode {
  switch (item.kind) {
    case "banner":
      // An empty Text draws nothing, so a blank line is drawn as a space.
      return h(Box, { flexDirection: "column", marginBottom: 1 }, ...item.lines.map((l, i) => h(Text, { key: i }, l || " ")));
    case "user":
      return h(Box, { marginTop: 1 }, h(Text, { color: "magenta", bold: true }, "❯ "), h(Text, { color: "white" }, item.text));
    case "answer":
      return h(Box, { marginTop: 1, paddingLeft: 2 }, h(Markdown, { text: item.text }));
    case "tool":
      return h(Box, { paddingLeft: 2 }, h(ToolLine, { item, root, frame: 0 }));
    case "shell":
      return h(Box, { flexDirection: "column", marginTop: 1 }, h(Text, {}, h(Text, { color: "magenta", bold: true }, "! "), h(Text, { color: "white", bold: true }, item.command), item.code ? h(Text, { color: "red" }, `  exit ${item.code}`) : null), item.output ? h(Box, { paddingLeft: 2 }, h(Text, { dimColor: item.code === 0 }, item.output)) : null);
    case "output":
      return h(Box, { flexDirection: "column", paddingLeft: 2 }, h(Text, { color: item.ok ? undefined : "red" }, item.text), ...(item.images ?? []).map((p, i) => h(Text, { key: i }, h(Text, { color: "cyan" }, "image "), relative(root, p), h(Text, { dimColor: true }, "  (open shows it)"))));
    case "notice":
      return h(Box, { paddingLeft: 2 }, h(Text, { color: item.level === "error" ? "red" : item.level === "warn" ? "yellow" : undefined, dimColor: item.level === "info" }, item.text));
  }
}

// Reset only when selecting a different conversation, whose saved output must be displayed.
// Keep the same <Static> through resizes so committed history is never appended again.
export function Transcript({ items, root, generation = 0 }: { items: Item[]; root: string; generation?: number }) {
  return h(Static<Item>, { key: generation, items, children: (item: Item) => h(Box, { key: item.key, flexDirection: "column" }, renderItem(item, root)) });
}

export const shortRoot = (root: string) => tilde(root);
