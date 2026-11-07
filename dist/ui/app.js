import { collapseTools } from "../agent/presentation.js";
import { tilde } from "../args.js";
import { bannerText } from "../banner.js";
import { Box, h, Text, useApp, useEffect, useRef, useState, useStdout } from "./h.js";
import { InputBox } from "./input.js";
import { Footer, Notices, PermissionPrompt, Picker, Progress, shortcuts, Turn } from "./parts.js";
import { ToolLine, Transcript } from "./transcript.js";
export function startLines(info, root, status) {
    const tick = "\x1b[32m✓\x1b[0m";
    const bold = (s) => `\x1b[1m${s}\x1b[0m`;
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
export function App({ session, server, info, onExit }) {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const [columns, setColumns] = useState(stdout.columns || 80);
    const [generation, setGeneration] = useState(0);
    // After a resize the screen has been cleared (see runApp), so draw everything again at the
    // new width: the transcript through a fresh <Static>, and the live part as usual.
    useEffect(() => {
        const onResize = () => {
            setColumns(stdout.columns || 80);
            setGeneration((g) => g + 1);
        };
        stdout.on("resize", onResize);
        return () => void stdout.off("resize", onResize);
    }, []);
    const [items, setItems] = useState(() => [{ key: 0, kind: "banner", lines: [...bannerText(columns).split("\n"), ...startLines(info, server.root, session.status)] }]);
    const [segments, setSegments] = useState(null);
    const [busy, setBusy] = useState(false);
    const [ready, setReady] = useState(false);
    const readyRef = useRef(false);
    const columnsRef = useRef(columns);
    columnsRef.current = columns;
    const [activity, setActivity] = useState(null);
    const live = useRef(null);
    const [detail, setDetail] = useState(null);
    const [ask, setAsk] = useState(null);
    const [pick, setPick] = useState(null);
    const [status, setStatus] = useState(session.status);
    const [notices, setNotices] = useState([]);
    const [helpShown, setHelpShown] = useState(false);
    const keys = useRef(1);
    const add = (...more) => setItems((all) => [...all, ...more.map((m) => ({ ...m, key: keys.current++ }))]);
    useEffect(() => {
        const update = (f) => { live.current = f(live.current ?? []); setSegments(live.current); };
        const flush = () => {
            if (live.current?.length)
                add(...collapseTools(live.current.map((s) => s.kind === "text" ? { kind: "answer", text: s.text } : s.kind === "notice" ? s : s.done ? s : { ...s, done: true, ok: false, text: "Interrupted before completion." })));
            live.current = null;
            setSegments(null);
        };
        const offSession = session.on((e) => {
            switch (e.type) {
                case "input":
                    flush();
                    add({ kind: "user", text: e.text });
                    live.current = [];
                    setSegments([]);
                    setDetail(null);
                    break;
                case "user": break; // model/telemetry event; the input was already echoed once
                case "activity":
                    setActivity(e.activity);
                    setBusy(e.activity !== null);
                    if (!e.activity) {
                        flush();
                        setAsk(null);
                    }
                    break;
                case "session":
                    if (readyRef.current && stdout.isTTY)
                        stdout.write("\x1b[2J\x1b[H");
                    readyRef.current = true;
                    setReady(true);
                    setGeneration(g => g + 1);
                    setItems([{ key: keys.current++, kind: "banner", lines: [...bannerText(columnsRef.current).split("\n"), ...startLines(info, server.root, session.status), `  Conversation: ${e.view.title}${e.view.id ? ` (${e.view.id})` : ""}`, ...e.view.warnings.map(w => `  ! ${w}`), ...(e.view.restored ? [`  Restored ${e.view.restored} most recent turns${e.view.legacy ? "; older transcript reconstructed from saved records" : ""}.`] : [])] }, ...collapseTools(e.view.items).map(m => ({ ...m, key: keys.current++ }))]);
                    live.current = null;
                    setSegments(null);
                    setDetail(null);
                    break;
                case "text":
                    update(s => { const all = [...s]; const last = all.at(-1); if (last?.kind === "text")
                        all[all.length - 1] = { kind: "text", text: last.text + e.text };
                    else
                        all.push({ kind: "text", text: e.text }); return all; });
                    break;
                case "tool_call":
                    update(s => [...s, { kind: "tool", id: e.id, name: e.name, input: e.input, source: e.source, done: false }]);
                    break;
                case "tool_result":
                    update(s => s.map(seg => seg.kind === "tool" && seg.id === e.id ? { ...seg, done: true, ok: e.ok, text: e.text, images: e.images, ms: e.ms } : seg));
                    break;
                case "ask_permission":
                    setAsk({ id: e.id, name: e.name, input: e.input, reply: a => { setAsk(null); e.reply(a); } });
                    break;
                case "choose": {
                    const index = Math.max(0, e.options.findIndex(o => o.id === e.current && !o.disabled));
                    setPick({ title: e.title, options: e.options, index, reply: id => { setPick(null); e.reply(id); } });
                    break;
                }
                case "shell":
                    add({ kind: "shell", command: e.command, output: e.output, code: e.code });
                    break;
                case "output":
                    add({ kind: "output", text: e.text, ok: e.ok ?? true, images: e.images });
                    break;
                case "notice":
                    if (live.current !== null)
                        update(s => [...s, { kind: "notice", text: e.text, level: e.level }]);
                    else
                        add({ kind: "notice", text: e.text, level: e.level });
                    break;
                case "done":
                    if (e.interrupted)
                        update(s => [...s, { kind: "notice", text: "Interrupted.", level: "info" }]);
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
        const offServer = server.on((e) => {
            if (e.type === "call" && (e.reply.source === "http" || e.reply.source === "mcp"))
                add({ kind: "tool", id: `http${e.reply.id}`, name: e.reply.tool, input: e.args, source: e.reply.source, done: true, ok: e.reply.ok, text: e.reply.text, images: e.reply.images, ms: e.reply.ms });
            else if (e.type === "catalogue")
                session.sendStatus();
            else if (e.type === "engine_log")
                add({ kind: "notice", text: e.text.trimEnd(), level: "info" });
        });
        void session.initializeInteractive();
        session.sendStatus();
        return () => {
            offSession();
            offServer();
        };
    }, []);
    const toggleExpand = () => {
        const item = collapseTools(live.current ?? []).findLast(s => s.kind === "tool") ?? items.findLast(s => s.kind === "tool");
        if (item)
            setDetail(current => current?.id === item.id ? null : item);
    };
    const selected = detail ? [...collapseTools(segments ?? []), ...items].findLast(s => s.kind === "tool" && (s.id === detail.id || s.calls?.some(c => c.id === detail.id))) ?? detail : null;
    return h(Box, { flexDirection: "column" }, ready ? h(Transcript, { items, root: server.root, generation }) : h(Box, { flexDirection: "column" }, h(Text, {}, bannerText(columns))), segments ? h(Turn, { segments, root: server.root, waiting: false }) : null, activity && !ask && !pick ? h(Progress, { activity }) : null, selected ? h(Box, { flexDirection: "column", marginTop: 1 }, h(Text, { bold: true }, `Tool output: ${selected.name} (Ctrl-O or Esc to close)`), h(ToolLine, { item: { ...selected, expanded: true }, root: server.root, frame: 0 }), h(Text, { dimColor: true }, session.journal ? `Full call records: ${session.journal.path}` : "Full results remain in the current conversation.")) : null, ask ? h(PermissionPrompt, { name: ask.name, input: ask.input }) : null, pick ? h(Picker, { title: pick.title, options: pick.options, index: pick.index }) : null, h(Notices, { notices }), helpShown ? h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, shortcuts)) : null, h(InputBox, {
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
            if (detail) {
                setDetail(null);
                return;
            }
            if (busy)
                session.interrupt();
            setNotices([]);
            setHelpShown(false);
        },
    }), h(Footer, { status, busy, helpShown }));
}
// Draws the app on this terminal and resolves when the person leaves.
export async function runApp(session, server, info) {
    const { render } = await import("ink");
    let left = false;
    // When the window changes size, the terminal rewraps the rows already on screen, so Ink's
    // count of the frame's rows no longer holds and pieces are left behind. Clear what's visible
    // first (what was above stays in the scrollback); Ink's own resize handler, registered after
    // this one, then draws the live frame afresh at the top. Same as Claude Code.
    process.stdout.on("resize", () => process.stdout.write("\x1b[2J\x1b[H"));
    const instance = render(h(App, { session, server, info, onExit: () => (left = true) }), { exitOnCtrlC: false, patchConsole: true });
    await instance.waitUntilExit();
    if (!left)
        await session.submit("exit");
}
