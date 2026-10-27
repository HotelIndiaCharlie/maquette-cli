import { tilde } from "../args.js";
import { bannerText } from "../banner.js";
import { Box, h, Text, useApp, useEffect, useRef, useState, useStdout } from "./h.js";
import { InputBox } from "./input.js";
import { Footer, Notices, PermissionPrompt, shortcuts, Turn } from "./parts.js";
import { Transcript } from "./transcript.js";
export function startLines(info, root, status) {
    const tick = "\x1b[32m✓\x1b[0m";
    const bold = (s) => `\x1b[1m${s}\x1b[0m`;
    return [
        `  ${tick} ${info.engineName}, headless, with Maquette's tools (${info.toolCount} tools)`,
        `  ${tick} Working in ${bold(tilde(root))}: DesignCraft reads and writes only here`,
        `  ${tick} Listening on ${bold(`http://127.0.0.1:${info.port}`)} for other sessions`,
        `  ${tick} Renders go to ${info.images}/`,
        `  ${tick} Model ${bold(status.model)} from ${status.provider}${status.effort ? `, effort ${status.effort}` : ""}, permission mode ${bold(status.mode)}`,
        "",
        `  Type what you want done, or a tool and its flags. ${bold("help")} shows how, ${bold("/help")} the slash commands.`,
        ...(info.hint ? [`  ${info.hint}`] : []),
    ];
}
export function App({ session, server, info, onExit }) {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const columns = stdout.columns || 80;
    const [items, setItems] = useState(() => [{ key: 0, kind: "banner", lines: [...bannerText(columns).split("\n"), ...startLines(info, server.root, session.status)] }]);
    const [segments, setSegments] = useState(null);
    const [busy, setBusy] = useState(false);
    const [ask, setAsk] = useState(null);
    const [status, setStatus] = useState(session.status);
    const [notices, setNotices] = useState([]);
    const [helpShown, setHelpShown] = useState(false);
    const keys = useRef(1);
    const add = (...more) => setItems((all) => [...all, ...more.map((m) => ({ ...m, key: keys.current++ }))]);
    useEffect(() => {
        const offSession = session.on((e) => {
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
                        if (last?.kind === "text")
                            all[all.length - 1] = { kind: "text", text: last.text + e.text };
                        else
                            all.push({ kind: "text", text: e.text });
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
                case "shell":
                    add({ kind: "shell", command: e.command, output: e.output, code: e.code });
                    break;
                case "output":
                    add({ kind: "output", text: e.text, ok: e.ok ?? true, images: e.images });
                    break;
                case "notice":
                    if (e.level === "info")
                        add({ kind: "notice", text: e.text, level: e.level });
                    else
                        setNotices((n) => [...n.slice(-2), { text: e.text, level: e.level }]);
                    break;
                case "done":
                    setSegments((s) => {
                        const finished = (s ?? []).map((seg) => (seg.kind === "text" ? { kind: "answer", text: seg.text } : seg.done ? seg : { ...seg, done: true, ok: false, text: "interrupted" }));
                        if (e.interrupted)
                            finished.push({ kind: "notice", text: "Interrupted.", level: "info" });
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
        const offServer = server.on((e) => {
            if (e.type === "call" && e.reply.source === "http")
                add({ kind: "tool", id: `http${e.reply.id}`, name: e.reply.tool, input: e.args, source: "http", done: true, ok: e.reply.ok, text: e.reply.text, images: e.reply.images, ms: e.reply.ms });
            else if (e.type === "engine_log")
                add({ kind: "notice", text: e.text.trimEnd(), level: "info" });
        });
        session.sendStatus();
        return () => {
            offSession();
            offServer();
        };
    }, []);
    const toggleExpand = () => setItems((all) => {
        const i = all.findLastIndex((it) => it.kind === "tool");
        if (i < 0)
            return all;
        const copy = [...all];
        // Static never redraws an item, so the expanded copy is added as a new one.
        const it = copy[i];
        copy.push({ ...it, key: keys.current++, expanded: !it.expanded });
        return copy;
    });
    return h(Box, { flexDirection: "column" }, h(Transcript, { items, root: server.root }), segments ? h(Turn, { segments, root: server.root, waiting: busy && !ask }) : null, ask ? h(PermissionPrompt, { name: ask.name, input: ask.input }) : null, h(Notices, { notices }), helpShown ? h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, shortcuts)) : null, h(InputBox, {
        byName: server.byName,
        root: server.root,
        busy,
        permission: ask,
        onSubmit: (line) => void session.submit(line),
        onInterrupt: () => session.interrupt(),
        onExit: () => void session.submit("exit"),
        onToggleExpand: toggleExpand,
        onHelp: () => setHelpShown((s) => !s),
        onEscape: () => {
            if (busy)
                session.interrupt();
            setNotices([]);
            setHelpShown(false);
        },
    }), h(Footer, { status, busy, columns, helpShown }));
}
// Draws the app on this terminal and resolves when the person leaves.
export async function runApp(session, server, info) {
    const { render } = await import("ink");
    let left = false;
    const instance = render(h(App, { session, server, info, onExit: () => (left = true) }), { exitOnCtrlC: false, patchConsole: true });
    await instance.waitUntilExit();
    if (!left)
        await session.submit("exit");
}
