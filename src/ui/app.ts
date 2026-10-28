// The screen: finished items above, the live turn, then the input box and footer. It
// subscribes to the session's and the server's events and draws them; the logic is theirs.
import type { AgentEvent, Choice, PermissionAnswer, Status } from "../agent/events.ts";
import type { AgentSession } from "../agent/session.ts";
import { tilde } from "../args.ts";
import { bannerText } from "../banner.ts";
import type { ServerEvent, ServerHandle } from "../server.ts";
import { Box, h, Text, useApp, useEffect, useRef, useState, useStdout } from "./h.ts";
import { InputBox } from "./input.ts";
import { Footer, Notices, PermissionPrompt, Picker, type Segment, shortcuts, Turn } from "./parts.ts";
import { type Item, type ItemBody, type ToolItem, Transcript } from "./transcript.ts";

// `trace` is the tracing line, when --trace or MAQUETTE_TRACE asked for it: on, or why it's off.
export type Info = { version: string; engineName: string; toolCount: number; port: number; images: string; hint?: string; trace?: { ok: boolean; text: string } };
type Ask = { id: string; name: string; input: Record<string, unknown>; reply: (a: PermissionAnswer) => void };
type Choosing = { title: string; options: Choice[]; index: number; reply: (id: string | null) => void };
type ServerLike = Pick<ServerHandle, "root" | "byName" | "on">;

export function startLines(info: Info, root: string, status: Status): string[] {
  const tick = "\x1b[32m✓\x1b[0m";
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  return [
    `  ${tick} ${info.engineName}, headless, with Maquette's tools (${info.toolCount} tools)`,
    `  ${tick} Working in ${bold(tilde(root))}: DesignCraft reads and writes only here`,
    `  ${tick} Listening on ${bold(`http://127.0.0.1:${info.port}`)} for other sessions`,
    `  ${tick} Renders go to ${info.images}/`,
    `  ${tick} Model ${bold(status.model)} from ${status.provider}${status.effort ? `, effort ${status.effort}` : ""}, permission mode ${bold(status.mode)}`,
    ...(info.trace ? [`  ${info.trace.ok ? tick : "\x1b[33m!\x1b[0m"} ${info.trace.text}`] : []),
    "",
    `  Type what you want done, or a tool and its flags. ${bold("help")} shows how, ${bold("/help")} the slash commands.`,
    ...(info.hint ? [`  ${info.hint}`] : []),
  ];
}

export function App({ session, server, info, onExit }: { session: AgentSession; server: ServerLike; info: Info; onExit: () => void }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [columns, setColumns] = useState((stdout as NodeJS.WriteStream).columns || 80);
  const [generation, setGeneration] = useState(0);
  // After a resize the screen has been cleared (see runApp), so draw everything again at the
  // new width: the transcript through a fresh <Static>, and the live part as usual.
  useEffect(() => {
    const onResize = () => {
      setColumns((stdout as NodeJS.WriteStream).columns || 80);
      setGeneration((g) => g + 1);
    };
    stdout.on("resize", onResize);
    return () => void stdout.off("resize", onResize);
  }, []);
  const [items, setItems] = useState<Item[]>(() => [{ key: 0, kind: "banner", lines: [...bannerText(columns).split("\n"), ...startLines(info, server.root, session.status)] }]);
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [pick, setPick] = useState<Choosing | null>(null);
  const [status, setStatus] = useState<Status>(session.status);
  const [notices, setNotices] = useState<{ text: string; level: "info" | "warn" | "error" }[]>([]);
  const [helpShown, setHelpShown] = useState(false);
  const keys = useRef(1);
  const add = (...more: ItemBody[]) => setItems((all) => [...all, ...more.map((m): Item => ({ ...m, key: keys.current++ }))]);

  useEffect(() => {
    const offSession = session.on((e: AgentEvent) => {
      switch (e.type) {
        case "user":
          add({ kind: "user", text: e.text });
          setSegments([]);
          setBusy(true);
          break;
        case "text":
          setSegments((s) => {
            const all = s ? [...s] : [];
            const last = all.at(-1);
            if (last?.kind === "text") all[all.length - 1] = { kind: "text", text: last.text + e.text };
            else all.push({ kind: "text", text: e.text });
            return all;
          });
          break;
        case "tool_call":
          setSegments((s) => [...(s ?? []), { kind: "tool", id: e.id, name: e.name, input: e.input, source: e.source, done: false }]);
          break;
        case "tool_result":
          setSegments((s) => (s ?? []).map((seg) => (seg.kind === "tool" && seg.id === e.id ? { ...seg, done: true, ok: e.ok, text: e.text, images: e.images, ms: e.ms } : seg)));
          break;
        case "ask_permission":
          setAsk({ id: e.id, name: e.name, input: e.input, reply: (a) => {
            setAsk(null);
            e.reply(a);
          } });
          break;
        case "choose": {
          const index = Math.max(0, e.options.findIndex((o) => o.id === e.current));
          setPick({ title: e.title, options: e.options, index, reply: (id) => {
            setPick(null);
            e.reply(id);
          } });
          break;
        }
        case "shell":
          add({ kind: "shell", command: e.command, output: e.output, code: e.code });
          break;
        case "output":
          add({ kind: "output", text: e.text, ok: e.ok ?? true, images: e.images });
          break;
        case "notice":
          if (e.level === "info") add({ kind: "notice", text: e.text, level: e.level });
          else setNotices((n) => [...n.slice(-2), { text: e.text, level: e.level }]);
          break;
        case "done":
          setSegments((s) => {
            const finished = (s ?? []).map((seg): ItemBody => (seg.kind === "text" ? { kind: "answer", text: seg.text } : seg.done ? seg : { ...seg, done: true, ok: false, text: "interrupted" }));
            if (e.interrupted) finished.push({ kind: "notice", text: "Interrupted.", level: "info" });
            add(...finished);
            return null;
          });
          setBusy(false);
          setAsk(null);
          break;
        case "status":
          setStatus(e.status);
          break;
        case "exit":
          onExit();
          exit();
          break;
      }
    });
    const offServer = server.on((e: ServerEvent) => {
      if (e.type === "call" && e.reply.source === "http") add({ kind: "tool", id: `http${e.reply.id}`, name: e.reply.tool, input: e.args, source: "http", done: true, ok: e.reply.ok, text: e.reply.text, images: e.reply.images, ms: e.reply.ms } as ToolItem);
      else if (e.type === "engine_log") add({ kind: "notice", text: e.text.trimEnd(), level: "info" });
    });
    session.sendStatus();
    return () => {
      offSession();
      offServer();
    };
  }, []);

  const toggleExpand = () =>
    setItems((all) => {
      const i = all.findLastIndex((it) => it.kind === "tool");
      if (i < 0) return all;
      const copy = [...all];
      // Static never redraws an item, so the expanded copy is added as a new one.
      const it = copy[i] as ToolItem & { key: number };
      copy.push({ ...it, key: keys.current++, expanded: !it.expanded });
      return copy;
    });

  return h(
    Box,
    { flexDirection: "column" },
    h(Transcript, { items, root: server.root, generation }),
    segments ? h(Turn, { segments, root: server.root, waiting: busy && !ask }) : null,
    ask ? h(PermissionPrompt, { name: ask.name, input: ask.input }) : null,
    pick ? h(Picker, { title: pick.title, options: pick.options, index: pick.index }) : null,
    h(Notices, { notices }),
    helpShown ? h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, shortcuts)) : null,
    h(InputBox, {
      byName: server.byName,
      root: server.root,
      busy,
      permission: ask,
      picker: pick ? { options: pick.options, index: pick.index, move: (index) => setPick((p) => (p ? { ...p, index } : p)), pick: pick.reply } : null,
      onSubmit: (line) => void session.submit(line),
      onInterrupt: () => session.interrupt(),
      onExit: () => void session.submit("exit"),
      onToggleExpand: toggleExpand,
      onHelp: () => setHelpShown((s) => !s),
      onEscape: () => {
        if (busy) session.interrupt();
        setNotices([]);
        setHelpShown(false);
      },
    }),
    h(Footer, { status, busy, helpShown }),
  );
}

// Draws the app on this terminal and resolves when the person leaves.
export async function runApp(session: AgentSession, server: ServerHandle, info: Info): Promise<void> {
  const { render } = await import("ink");
  let left = false;
  // When the window changes size, the terminal rewraps the rows already on screen, so Ink's
  // count of the frame's rows no longer holds and pieces are left behind. Clear what's visible
  // first (what was above stays in the scrollback); Ink's own resize handler, registered after
  // this one, then draws the live frame afresh at the top. Same as Claude Code.
  process.stdout.on("resize", () => process.stdout.write("\x1b[2J\x1b[H"));
  const instance = render(h(App, { session, server, info, onExit: () => (left = true) }), { exitOnCtrlC: false, patchConsole: true });
  await instance.waitUntilExit();
  if (!left) await session.submit("exit");
}
