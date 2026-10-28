// An answer's Markdown as Ink text: bold, italics, headings, lists, code and links. It draws
// what the lexer makes of the text so far, so a streaming answer renders as it arrives.
import { lexer, type Token, type Tokens } from "marked";
import { Box, h, type ReactNode, Text } from "./h.ts";

let keys = 0;
const key = () => `md${keys++}`;

function inline(tokens: Token[] | undefined, style: { bold?: boolean; italic?: boolean } = {}): ReactNode[] {
  if (!tokens) return [];
  return tokens.map((t): ReactNode => {
    switch (t.type) {
      case "strong":
        return h(Text, { key: key(), bold: true }, ...inline((t as Tokens.Strong).tokens, { ...style, bold: true }));
      case "em":
        return h(Text, { key: key(), italic: true }, ...inline((t as Tokens.Em).tokens, { ...style, italic: true }));
      case "del":
        return h(Text, { key: key(), strikethrough: true }, ...inline((t as Tokens.Del).tokens, style));
      case "codespan":
        return h(Text, { key: key(), color: "cyan" }, (t as Tokens.Codespan).text);
      case "link": {
        const l = t as Tokens.Link;
        const label = inline(l.tokens, style);
        return h(Text, { key: key() }, ...label, l.href && l.text !== l.href ? h(Text, { dimColor: true }, ` (${l.href})`) : null);
      }
      case "image":
        return h(Text, { key: key(), dimColor: true }, `[image: ${(t as Tokens.Image).href}]`);
      case "br":
        return h(Text, { key: key() }, "\n");
      case "escape":
      case "text":
        return (t as Tokens.Text).tokens ? h(Text, { key: key() }, ...inline((t as Tokens.Text).tokens, style)) : h(Text, { key: key(), ...style }, unescape((t as Tokens.Text).text));
      default:
        return h(Text, { key: key() }, unescape((t as Tokens.Generic).raw ?? ""));
    }
  });
}

const unescape = (s: string) => s.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'");

function block(t: Token, depth = 0): ReactNode {
  switch (t.type) {
    case "heading":
      return h(Text, { key: key(), bold: true, underline: (t as Tokens.Heading).depth <= 2 }, ...inline((t as Tokens.Heading).tokens, { bold: true }));
    case "paragraph":
      return h(Text, { key: key() }, ...inline((t as Tokens.Paragraph).tokens));
    case "text":
      return h(Text, { key: key() }, ...inline((t as Tokens.Text).tokens ?? [{ type: "text", raw: (t as Tokens.Text).text, text: (t as Tokens.Text).text } as Token]));
    case "code":
      return h(Box, { key: key(), paddingLeft: 2 }, h(Text, { color: "cyan" }, (t as Tokens.Code).text));
    case "blockquote":
      return h(Box, { key: key(), paddingLeft: 2, flexDirection: "column" }, ...((t as Tokens.Blockquote).tokens ?? []).map((c) => h(Text, { key: key(), dimColor: true, italic: true }, block(c, depth))));
    case "list": {
      const list = t as Tokens.List;
      return h(
        Box,
        { key: key(), flexDirection: "column" },
        ...list.items.map((item: Tokens.ListItem, i: number) => {
          const marker = list.ordered ? `${(Number(list.start) || 1) + i}.` : "•";
          return h(Box, { key: key() }, h(Text, { dimColor: true }, `${"  ".repeat(depth)}${marker} `), h(Box, { flexDirection: "column", flexGrow: 1 }, ...item.tokens.map((c) => block(c, depth + 1))));
        }),
      );
    }
    case "hr":
      return h(Text, { key: key(), dimColor: true }, "────────");
    case "table": {
      const tb = t as Tokens.Table;
      const rows = [tb.header, ...tb.rows].map((r) => r.map((c) => c.text).join("  │  "));
      return h(Text, { key: key() }, rows.join("\n"));
    }
    case "space":
      return null;
    case "html":
      return h(Text, { key: key(), dimColor: true }, (t as Tokens.HTML).text.trim());
    default:
      return h(Text, { key: key() }, (t as Tokens.Generic).raw ?? "");
  }
}

// The blocks of a Markdown text, with a blank line between paragraphs.
export function Markdown({ text }: { text: string }) {
  const tokens = lexer(text);
  const nodes: ReactNode[] = [];
  for (const t of tokens) {
    const node = block(t);
    if (node === null) continue;
    if (nodes.length) nodes.push(h(Text, { key: key() }, " "));
    nodes.push(node);
  }
  return h(Box, { flexDirection: "column" }, ...nodes);
}
