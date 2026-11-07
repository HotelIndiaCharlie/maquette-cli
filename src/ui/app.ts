// The screen: finished items above, the live turn, then the input box and footer. It
// subscribes to the session's and the server's events and draws them; the logic is theirs.
import type { Activity } from "../agent/presentation.ts";
import { collapseTools } from "../agent/presentation.ts";
import type { AgentEvent, Choice, PermissionAnswer, Status } from "../agent/events.ts";
import type { AgentSession } from "../agent/session.ts";
import { tilde } from "../args.ts";
import { bannerText } from "../banner.ts";
import type { ServerEvent, ServerHandle } from "../server.ts";
import { Box, h, Text, useApp, useEffect, useRef, useState, useStdout } from "./h.ts";
import { InputBox } from "./input.ts";
import { Footer, Notices, PermissionPrompt, Picker, Progress, type Segment, shortcuts, Turn } from "./parts.ts";
import { type Item, type ItemBody, type ToolItem, ToolLine, Transcript } from "./transcript.ts";
import { repairResize } from "./resize.ts";

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
  // The terminal reflows committed scrollback; Ink redraws only the live frame.
  // Remounting <Static> here would append the entire history again on every resize.
  useEffect(() => {
    const onResize = () => {
      setColumns((stdout as NodeJS.WriteStream).columns || 80);
    };
    stdout.on("resize", onResize);
    return () => void stdout.off("resize", onResize);
  }, []);
  const [items, setItems] = useState<Item[]>(() => [{ key: 0, kind: "banner", lines: [...bannerText(columns).split("\n"), ...startLines(info, server.root, session.status)] }]);
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const columnsRef = useRef(columns); columnsRef.current = columns;
  const [activity, setActivity] = useState<Activity | null>(null);
  const live = useRef<Segment[] | null>(null);
  const [detail, setDetail] = useState<ToolItem | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [pick, setPick] = useState<Choosing | null>(null);
  const [status, setStatus] = useState<Status>(session.status);
  const [notices, setNotices] = useState<{ text: string; level: "info" | "warn" | "error" }[]>([]);
  const [helpShown, setHelpShown] = useState(false);
  const keys = useRef(1);
  const add = (...more: ItemBody[]) => setItems((all) => [...all, ...more.map((m): Item => ({ ...m, key: keys.current++ }))]);

  useEffect(() => {
    const update = (f: (s: Segment[]) => Segment[]) => { live.current = f(live.current ?? []); setSegments(live.current); };
    const flush = () => {
      if (live.current?.length) add(...collapseTools(live.current.map((s): ItemBody => s.kind === "text" ? { kind: "answer", text: s.text } : s.kind === "notice" ? s : s.done ? s : { ...s, done: true, ok: false, text: "Interrupted before completion." })));
      live.current = null; setSegments(null);
    };
    const offSession = session.on((e: AgentEvent) => {
      switch (e.type) {
        case "input":
          flush(); add({ kind: "user", text: e.text }); live.current = []; setSegments([]); setDetail(null); break;
        case "user": break; // model/telemetry event; the input was already echoed once
        case "activity":
          setActivity(e.activity); setBusy(e.activity !== null);
          if (!e.activity) { flush(); setAsk(null); }
          break;
        case "session":
          if (readyRef.current && (stdout as NodeJS.WriteStream).isTTY) stdout.write("\x1b[2J\x1b[H");
          readyRef.current = true;
          setReady(true); setGeneration(g => g + 1);
          setItems([{ key: keys.current++, kind: "banner", lines: [...bannerText(columnsRef.current).split("\n"), ...startLines(info, server.root, session.status), `  Conversation: ${e.view.title}${e.view.id ? ` (${e.view.id})` : ""}`, ...e.view.warnings.map(w => `  ! ${w}`), ...(e.view.restored ? [`  Restored ${e.view.restored} most recent turns${e.view.legacy ? "; older transcript reconstructed from saved records" : ""}.`] : [])] }, ...collapseTools(e.view.items).map(m => ({ ...m, key: keys.current++ }))]);
          live.current = null; setSegments(null); setDetail(null); break;
        case "text":
          update(s => { const all = [...s]; const last = all.at(-1); if (last?.kind === "text") all[all.length - 1] = { kind: "text", text: last.text + e.text }; else all.push({ kind: "text", text: e.text }); return all; }); break;
        case "tool_call": update(s => [...s, { kind: "tool", id: e.id, name: e.name, input: e.input, source: e.source, done: false }]); break;
        case "tool_result": update(s => s.map(seg => seg.kind === "tool" && seg.id === e.id ? { ...seg, done: true, ok: e.ok, text: e.text, images: e.images, ms: e.ms } : seg)); break;
        case "ask_permission": setAsk({ id: e.id, name: e.name, input: e.input, reply: a => { setAsk(null); e.reply(a); } }); break;
        case "choose": {
          const index = Math.max(0, e.options.findIndex(o => o.id === e.current && !o.disabled));
          setPick({ title: e.title, options: e.options, index, reply: id => { setPick(null); e.reply(id); } }); break;
        }
        case "shell": add({ kind: "shell", command: e.command, output: e.output, code: e.code }); break;
        case "output": add({ kind: "output", text: e.text, ok: e.ok ?? true, images: e.images }); break;
        case "notice":
          if (live.current !== null) update(s => [...s, { kind: "notice", text: e.text, level: e.level }]);
          else add({ kind: "notice", text: e.text, level: e.level });
          break;
        case "done": if (e.interrupted) update(s => [...s, { kind: "notice", text: "Interrupted.", level: "info" }]); setAsk(null); break;
        case "status": setStatus(e.status); break;
        case "exit": onExit(); exit(); break;
      }
    });
    const offServer = server.on((e: ServerEvent) => {
      if (e.type === "call" && (e.reply.source === "http" || e.reply.source === "mcp")) add({ kind: "tool", id: `http${e.reply.id}`, name: e.reply.tool, input: e.args, source: e.reply.source, done: true, ok: e.reply.ok, text: e.reply.text, images: e.reply.images, ms: e.reply.ms } as ToolItem);
      else if (e.type === "catalogue") session.sendStatus();
      else if (e.type === "engine_log") add({ kind: "notice", text: e.text.trimEnd(), level: "info" });
    });
    void session.initializeInteractive();
    session.sendStatus();
    return () => {
      offSession();
      offServer();
    };
  }, []);

  const toggleExpand = () => {
    const item = collapseTools(live.current ?? []).findLast(s => s.kind === "tool") as ToolItem | undefined ?? items.findLast(s => s.kind === "tool") as ToolItem | undefined;
    if (item) setDetail(current => current?.id === item.id ? null : item);
  };
  const selected = detail ? [...collapseTools(segments ?? []), ...items].findLast(s => s.kind === "tool" && (s.id === detail.id || s.calls?.some(c => c.id === detail.id))) as ToolItem | undefined ?? detail : null;

  return h(
    Box,
    { flexDirection: "column" },
    ready ? h(Transcript, { items, root: server.root, generation }) : h(Box, { flexDirection: "column" }, h(Text, {}, bannerText(columns))),
    segments ? h(Turn, { segments, root: server.root, waiting: false }) : null,
    activity && !ask && !pick ? h(Progress, { activity }) : null,
    selected ? h(Box, { flexDirection: "column", marginTop: 1 }, h(Text, { bold: true }, `Tool output: ${selected.name} (Ctrl-O or Esc to close)`), h(ToolLine, { item: { ...selected, expanded: true }, root: server.root, frame: 0 }), h(Text, { dimColor: true }, session.journal ? `Full call records: ${session.journal.path}` : "Full results remain in the current conversation.")) : null,
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
        if (detail) { setDetail(null); return; }
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
  const instance = render(h(App, { session, server, info, onExit: () => (left = true) }), { exitOnCtrlC: false, patchConsole: true });
  let removeResizeRepair = () => {};
  try { removeResizeRepair = await repairResize(process.stdout); await instance.waitUntilExit(); }
  finally { removeResizeRepair(); instance.cleanup(); }
  if (!left) await session.submit("exit");
}
