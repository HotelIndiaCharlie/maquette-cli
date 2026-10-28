// The smaller pieces of the screen: the live turn, the permission prompt, the footer, the
// notices and the shortcut list.
import { gist } from "../args.ts";
import { count, dollars } from "../agent/cost.ts";
import type { Choice, Status } from "../agent/events.ts";
import { Box, h, type ReactNode, Text, useEffect, useState } from "./h.ts";
import { Markdown } from "./markdown.ts";
import { summarise, spinnerFrames, type ToolItem, ToolLine } from "./transcript.ts";

export type Segment = { kind: "text"; text: string } | ToolItem;

// A spinner frame that advances while `on`.
export function useSpinner(on: boolean): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setFrame((f) => f + 1), 80);
    return () => clearInterval(t);
  }, [on]);
  return frame;
}

// The answer streaming in: its text so far and the tool calls made along the way, in order.
export function Turn({ segments, root, waiting }: { segments: Segment[]; root: string; waiting: boolean }) {
  const frame = useSpinner(true);
  const nodes: ReactNode[] = segments.map((s, i) => (s.kind === "text" ? h(Box, { key: i, paddingLeft: 2, marginTop: 1 }, h(Markdown, { text: s.text })) : h(Box, { key: i, paddingLeft: 2 }, h(ToolLine, { item: s, root, frame }))));
  if (waiting) nodes.push(h(Box, { key: "w", paddingLeft: 2, marginTop: segments.length ? 0 : 1 }, h(Text, { color: "yellow" }, `${spinnerFrames[frame % spinnerFrames.length]} `), h(Text, { dimColor: true }, "thinking… (esc or ctrl+c to stop)")));
  return h(Box, { flexDirection: "column" }, ...nodes);
}

// Display only: the input box answers the keys, so none is lost while this appears.
export function PermissionPrompt({ name, input }: { name: string; input: Record<string, unknown> }) {
  const args = summarise(input);
  return h(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: "yellow", paddingLeft: 1, paddingRight: 1, marginTop: 1 },
    h(Text, {}, h(Text, { bold: true }, `Allow ${name}`), args ? h(Text, { dimColor: true }, ` ${gist(args, 60)}`) : null, "?"),
    Object.keys(input).length ? h(Text, { dimColor: true }, gist(JSON.stringify(input, null, 2), 600)) : null,
    h(Text, {}, h(Text, { bold: true, color: "green" }, "y"), " yes   ", h(Text, { bold: true, color: "red" }, "n"), " no   ", h(Text, { bold: true, color: "yellow" }, "a"), " always, for this tool this session"),
  );
}

export function Footer({ status, busy, columns, helpShown }: { status: Status; busy: boolean; columns: number; helpShown: boolean }) {
  const left = busy ? "esc to interrupt" : helpShown ? "? to hide shortcuts" : "? for shortcuts";
  const tokens = `${count(status.tokens.input + status.tokens.cacheRead + status.tokens.cacheWrite)} in / ${count(status.tokens.output)} out`;
  const right = [status.model, status.effort, status.textProtocol ? `${status.mode} · text calls` : status.mode, tokens, status.cost !== undefined ? dollars(status.cost) : null].filter(Boolean).join(" · ");
  const gap = Math.max(1, columns - left.length - right.length - 2);
  return h(Box, {}, h(Text, { dimColor: true }, ` ${left}${" ".repeat(gap)}${right}`));
}

export function Notices({ notices }: { notices: { text: string; level: "info" | "warn" | "error" }[] }) {
  if (!notices.length) return null;
  return h(Box, { flexDirection: "column", paddingLeft: 2 }, ...notices.map((n, i) => h(Text, { key: i, color: n.level === "error" ? "red" : n.level === "warn" ? "yellow" : "blue" }, `${n.text}  `, h(Text, { dimColor: true }, "(esc dismisses)"))));
}

export const shortcuts = `  ↑ ↓ earlier lines     Tab complete     shift+enter or \\ new line     ctrl+o expand last tool line
  Ctrl-C stop the turn, clear the line, or exit     esc dismiss notices     exit or Ctrl-D stop Maquette
  /help the slash commands     help how to type tool calls     !cmd run a shell command`;

// A list to pick from: ↑ ↓ move, a number picks at once, enter takes the marked one, esc none.
export function Picker({ title, options, index }: { title: string; options: Choice[]; index: number }) {
  const width = Math.max(...options.map((o) => o.label.length));
  const shown = options.length > 12 ? options.slice(Math.max(0, Math.min(index - 5, options.length - 12)), Math.max(12, Math.min(index + 7, options.length))) : options;
  const first = options.indexOf(shown[0]);
  return h(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingLeft: 1, paddingRight: 1, marginTop: 1 },
    h(Text, { bold: true }, title),
    ...shown.map((o, j) => {
      const i = first + j;
      const on = i === index;
      return h(Text, { key: o.id, color: on ? "cyan" : undefined, bold: on }, `${on ? "›" : " "} ${String(i + 1).padStart(2)}. ${o.label.padEnd(width)}`, o.hint ? h(Text, { dimColor: !on, color: on ? "cyan" : undefined }, `  ${o.hint}`) : null);
    }),
    h(Text, { dimColor: true }, `↑ ↓ move · 1–${Math.min(9, options.length)} pick · enter take · esc none${options.length > shown.length ? ` · ${options.length} in all` : ""}`),
  );
}
