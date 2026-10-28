// The input box: a framed line with ❯, written on Ink's useInput so it can have history,
// Tab completion for tools, flags, /commands and paths, a second line with shift+enter, and
// Claude Code's Ctrl-C: it stops the turn, clears the line, or on an empty line stops Maquette.
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandHome, type Tool } from "../args.ts";
import type { PermissionAnswer } from "../agent/events.ts";
import { promptCommands, slashAbout, slashCommands } from "../agent/route.ts";
import type { Choice } from "../agent/events.ts";
import { Box, h, type ReactNode, Text, useInput, useRef, useState } from "./h.ts";

export type Completion = { options: string[]; word: string; replace?: string };

// The options for the word before the cursor, and what to replace it with when there's one.
export function complete(value: string, cursor: number, byName: Map<string, Tool>, root: string): Completion {
  const before = value.slice(0, cursor);
  const word = /(\S*)$/.exec(before)![1];
  const head = before.slice(0, before.length - word.length);
  const first = before.trim().split(/\s+/)[0] ?? "";
  let options: string[];
  let dirs = new Set<string>();
  if (!head.trim()) options = word.startsWith("/") ? slashCommands : [...promptCommands, ...byName.keys()];
  else if (first === "help") options = [...byName.keys()];
  else if (first === "/permissions") options = ["ask", "auto", "plan"];
  else if (first === "/provider") options = ["anthropic", "openai-compatible"];
  else if (word.startsWith("--")) options = Object.keys(byName.get(first)?.inputSchema.properties ?? {}).map((k) => `--${k}`);
  else if (/^[@.~]|\//.test(word)) {
    const at = word.startsWith("@") ? "@" : "";
    const path = expandHome(word.slice(at.length));
    const dir = path.endsWith("/") ? path : dirname(path);
    const full = resolve(root, dir === "." && !path.startsWith(".") ? "" : dir);
    try {
      const entries = existsSync(full) ? readdirSync(full) : [];
      options = entries
        .filter((e) => !e.startsWith(".") || path.split("/").at(-1)?.startsWith("."))
        .map((e) => {
          const p = join(dir === "." && !path.startsWith(".") ? "" : dir, e);
          const isDir = statSync(join(full, e)).isDirectory();
          const shown = `${at}${p.startsWith(homedir()) && word.includes("~") ? `~${p.slice(homedir().length)}` : p}${isDir ? "/" : ""}`;
          if (isDir) dirs.add(shown);
          return shown;
        });
    } catch {
      options = [];
    }
  } else options = [];
  const matches = options.filter((o) => o.startsWith(word) && o !== word).sort();
  if (matches.length === 1) return { options: matches, word, replace: dirs.has(matches[0]) ? matches[0] : `${matches[0]} ` };
  let prefix = matches[0] ?? "";
  for (const m of matches) while (!m.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return { options: matches, word, replace: prefix.length > word.length ? prefix : undefined };
}

export type InputProps = {
  // An open permission prompt: while it's set, keys answer it instead of typing.
  permission?: { reply: (answer: PermissionAnswer) => void } | null;
  // An open list to pick from: arrows, numbers, enter and esc answer it instead of typing.
  picker?: { options: Choice[]; index: number; move: (index: number) => void; pick: (id: string | null) => void } | null;
  byName: Map<string, Tool>;
  root: string;
  busy: boolean;
  onSubmit: (line: string) => void;
  onInterrupt: () => void;
  onExit: () => void;
  onToggleExpand: () => void;
  onHelp: () => void;
  onEscape: () => void;
};

export function InputBox(props: InputProps) {
  // Keys can arrive several in one tick (a paste, a test), before React re-renders, so the
  // box's state lives in a ref and a counter forces the redraw.
  const st = useRef({ value: "", cursor: 0, history: [] as string[], at: null as number | null, draft: "", hint: null as string[] | null, ctrlC: false, sel: 0 });
  const [, redraw] = useState(0);
  // The handler reads the latest props through a ref, so a key arriving before React
  // re-renders still sees an open permission prompt.
  const latest = useRef(props);
  latest.current = props;
  const update = () => redraw((n) => n + 1);
  const set = (v: string, c = v.length) => {
    st.current.value = v;
    st.current.cursor = Math.max(0, Math.min(c, v.length));
    st.current.hint = null;
    st.current.sel = 0;
    update();
  };
  const setCursor = (c: number) => {
    st.current.cursor = Math.max(0, Math.min(c, st.current.value.length));
    update();
  };

  useInput(
    (input, key) => {
      const props = latest.current;
      const { value, cursor, history, at, draft, ctrlC } = st.current;
      if (props.picker) {
        const { options, index, move, pick } = props.picker;
        if ((key.ctrl && input === "c") || key.escape) return pick(null);
        if (key.upArrow) return move((index + options.length - 1) % options.length);
        if (key.downArrow || key.tab) return move((index + 1) % options.length);
        if (key.return) return pick(options[index]?.id ?? null);
        if (/^[1-9]$/.test(input) && Number(input) <= options.length) return pick(options[Number(input) - 1].id);
        return;
      }
      if (props.permission) {
        if (key.ctrl && input === "c") return props.onInterrupt();
        if (input === "y" || input === "Y" || key.return) props.permission.reply("y");
        else if (input === "n" || input === "N" || key.escape) props.permission.reply("n");
        else if (input === "a" || input === "A") props.permission.reply("a");
        return;
      }
      if (key.ctrl && input === "c") {
        if (props.busy) return props.onInterrupt();
        if (value) return set("");
        if (ctrlC) return props.onExit();
        st.current.ctrlC = true;
        return props.onExit();
      }
      st.current.ctrlC = false;
      if (key.ctrl && input === "d") return value ? undefined : props.onExit();
      if (key.ctrl && input === "o") return props.onToggleExpand();
      if (key.ctrl && input === "u") return set("");
      if (key.ctrl && input === "a") return setCursor(0);
      if (key.ctrl && input === "e") return setCursor(value.length);
      if (key.escape) return props.onEscape();
      const slashes = suggestions(value);
      if (slashes.length && (key.upArrow || key.downArrow)) {
        st.current.sel = (st.current.sel + (key.upArrow ? slashes.length - 1 : 1)) % slashes.length;
        return update();
      }
      if (slashes.length && (key.tab || (key.return && !slashCommands.includes(value)))) {
        set(`${slashes[Math.min(st.current.sel, slashes.length - 1)]} `);
        st.current.sel = 0;
        return;
      }
      if (key.return) {
        if (key.shift || key.meta) return set(`${value.slice(0, cursor)}\n${value.slice(cursor)}`, cursor + 1);
        if (value.endsWith("\\") && cursor === value.length) return set(`${value.slice(0, -1)}\n`);
        const line = value;
        st.current.at = null;
        st.current.draft = "";
        if (line.trim()) st.current.history = [...history.filter((l) => l !== line), line].slice(-500);
        set("");
        return props.onSubmit(line);
      }
      if (key.tab) {
        const c = complete(value, cursor, props.byName, props.root);
        if (c.replace !== undefined) {
          const start = cursor - c.word.length;
          set(`${value.slice(0, start)}${c.replace}${value.slice(cursor)}`, start + c.replace.length);
        }
        if (c.options.length > 1) {
          st.current.hint = c.options;
          update();
        }
        return;
      }
      if (key.upArrow) {
        if (!history.length) return;
        const i = at === null ? history.length - 1 : Math.max(0, at - 1);
        if (at === null) st.current.draft = value;
        st.current.at = i;
        return set(history[i]);
      }
      if (key.downArrow) {
        if (at === null) return;
        const i = at + 1;
        if (i >= history.length) {
          st.current.at = null;
          return set(draft);
        }
        st.current.at = i;
        return set(history[i]);
      }
      if (key.leftArrow) return setCursor(Math.max(0, cursor - 1));
      if (key.rightArrow) return setCursor(Math.min(value.length, cursor + 1));
      if (key.home) return setCursor(0);
      if (key.end) return setCursor(value.length);
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        return set(`${value.slice(0, cursor - 1)}${value.slice(cursor)}`, cursor - 1);
      }
      if (input === "?" && !value) return props.onHelp();
      if (input && !key.ctrl && !key.meta) {
        const text = input.replace(/\r\n?/g, "\n");
        set(`${value.slice(0, cursor)}${text}${value.slice(cursor)}`, cursor + text.length);
      }
    },
    { isActive: true },
  );

  // The text with the cursor drawn as an inverted character.
  const { value, cursor, hint } = st.current;
  const before = value.slice(0, cursor);
  const under = value[cursor] ?? " ";
  const after = value.slice(cursor + 1);
  const lines = `${before}\u0000${under === "\n" ? " \n" : under}${after}`.split("\n");
  // What the person types is white; a leading /command is cyan, as it's an action, not a message.
  const slashLen = /^\/\S*/.exec(value)?.[0].length ?? 0;
  const styled = (text: string, from: number, k: string) =>
    slashLen > from ? [h(Text, { key: `${k}s`, color: "cyan", bold: true }, text.slice(0, slashLen - from)), h(Text, { key: `${k}w`, color: "white" }, text.slice(slashLen - from))] : [h(Text, { key: `${k}w`, color: "white" }, text)];
  const rows = lines.map((line, i) => {
    const parts: ReactNode[] = [h(Text, { color: "magenta", bold: true }, i === 0 ? "❯ " : "  ")];
    const mark = line.indexOf("\u0000");
    const offset = i === 0 ? 0 : value.length; // only the first line can hold the /command
    if (mark < 0) parts.push(...styled(line, offset, "a"));
    else {
      const underIsSlash = i === 0 && cursor < slashLen;
      parts.push(...styled(line.slice(0, mark), offset, "a"), h(Text, { key: "c", inverse: !props.permission && !props.picker, color: underIsSlash ? "cyan" : "white" }, line[mark + 1] ?? " "), ...styled(line.slice(mark + 2), i === 0 ? cursor + 1 : offset, "b"));
    }
    return h(Box, { key: i }, ...parts);
  });
  const slashes = suggestions(value);
  const sel = Math.min(st.current.sel, Math.max(0, slashes.length - 1));
  const width = Math.max(0, ...slashes.map((c) => c.length));
  // The rules are the box's own borders, so Ink lays them out to the window's width and
  // redraws them when it changes; a fixed row of dashes would wrap after a resize.
  return h(
    Box,
    { flexDirection: "column" },
    h(Box, { flexDirection: "column", borderStyle: "single", borderLeft: false, borderRight: false, borderDimColor: true }, ...rows),
    hint ? h(Text, { dimColor: true }, `  ${hint.slice(0, 12).join("  ")}${hint.length > 12 ? "  …" : ""}`) : null,
    ...slashes.map((c, i) => h(Text, { key: c, color: i === sel ? "cyan" : undefined, bold: i === sel }, `  ${i === sel ? "›" : " "} ${c.padEnd(width)}  `, h(Text, { dimColor: i !== sel, color: i === sel ? "cyan" : undefined }, slashAbout[c]))),
  );
}

// The slash commands that match what's typed so far, while only the command is typed.
function suggestions(value: string): string[] {
  if (!/^\/\S*$/.test(value)) return [];
  return slashCommands.filter((c) => c.startsWith(value));
}
