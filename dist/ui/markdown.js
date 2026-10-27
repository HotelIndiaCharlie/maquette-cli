// An answer's Markdown as Ink text: bold, italics, headings, lists, code and links. It draws
// what the lexer makes of the text so far, so a streaming answer renders as it arrives.
import { lexer } from "marked";
import { Box, h, Text } from "./h.js";
let keys = 0;
const key = () => `md${keys++}`;
function inline(tokens, style = {}) {
    if (!tokens)
        return [];
    return tokens.map((t) => {
        switch (t.type) {
            case "strong":
                return h(Text, { key: key(), bold: true }, ...inline(t.tokens, { ...style, bold: true }));
            case "em":
                return h(Text, { key: key(), italic: true }, ...inline(t.tokens, { ...style, italic: true }));
            case "del":
                return h(Text, { key: key(), strikethrough: true }, ...inline(t.tokens, style));
            case "codespan":
                return h(Text, { key: key(), color: "cyan" }, t.text);
            case "link": {
                const l = t;
                const label = inline(l.tokens, style);
                return h(Text, { key: key() }, ...label, l.href && l.text !== l.href ? h(Text, { dimColor: true }, ` (${l.href})`) : null);
            }
            case "image":
                return h(Text, { key: key(), dimColor: true }, `[image: ${t.href}]`);
            case "br":
                return h(Text, { key: key() }, "\n");
            case "escape":
            case "text":
                return t.tokens ? h(Text, { key: key() }, ...inline(t.tokens, style)) : h(Text, { key: key(), ...style }, unescape(t.text));
            default:
                return h(Text, { key: key() }, unescape(t.raw ?? ""));
        }
    });
}
const unescape = (s) => s.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
function block(t, depth = 0) {
    switch (t.type) {
        case "heading":
            return h(Text, { key: key(), bold: true, underline: t.depth <= 2 }, ...inline(t.tokens, { bold: true }));
        case "paragraph":
            return h(Text, { key: key() }, ...inline(t.tokens));
        case "text":
            return h(Text, { key: key() }, ...inline(t.tokens ?? [{ type: "text", raw: t.text, text: t.text }]));
        case "code":
            return h(Box, { key: key(), paddingLeft: 2 }, h(Text, { color: "cyan" }, t.text));
        case "blockquote":
            return h(Box, { key: key(), paddingLeft: 2, flexDirection: "column" }, ...(t.tokens ?? []).map((c) => h(Text, { key: key(), dimColor: true, italic: true }, block(c, depth))));
        case "list": {
            const list = t;
            return h(Box, { key: key(), flexDirection: "column" }, ...list.items.map((item, i) => {
                const marker = list.ordered ? `${(Number(list.start) || 1) + i}.` : "•";
                return h(Box, { key: key() }, h(Text, { dimColor: true }, `${"  ".repeat(depth)}${marker} `), h(Box, { flexDirection: "column", flexGrow: 1 }, ...item.tokens.map((c) => block(c, depth + 1))));
            }));
        }
        case "hr":
            return h(Text, { key: key(), dimColor: true }, "────────");
        case "table": {
            const tb = t;
            const rows = [tb.header, ...tb.rows].map((r) => r.map((c) => c.text).join("  │  "));
            return h(Text, { key: key() }, rows.join("\n"));
        }
        case "space":
            return null;
        case "html":
            return h(Text, { key: key(), dimColor: true }, t.text.trim());
        default:
            return h(Text, { key: key() }, t.raw ?? "");
    }
}
// The blocks of a Markdown text, with a blank line between paragraphs.
export function Markdown({ text }) {
    const tokens = lexer(text);
    const nodes = [];
    for (const t of tokens) {
        const node = block(t);
        if (node === null)
            continue;
        if (nodes.length)
            nodes.push(h(Text, { key: key() }, " "));
        nodes.push(node);
    }
    return h(Box, { flexDirection: "column" }, ...nodes);
}
