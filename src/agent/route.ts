// What a typed line means. A tool's name or one of the prompt's own commands runs directly,
// `/…` is a slash command, `!…` runs in the shell, and anything else goes to the model.

export type Route =
  | { kind: "empty" }
  | { kind: "exit" }
  | { kind: "command"; name: string; rest: string }
  | { kind: "tool"; name: string; rest: string }
  | { kind: "slash"; name: string; args: string }
  | { kind: "shell"; command: string }
  | { kind: "message"; text: string };

export const promptCommands = ["help", "tools", "example", "open", "exit"];
export const slashCommands = ["/help", "/model", "/provider", "/permissions", "/clear", "/cost", "/tools"];

export function route(line: string, isTool: (name: string) => boolean): Route {
  const text = line.trim();
  if (!text) return { kind: "empty" };
  if (text.startsWith("!")) return { kind: "shell", command: text.slice(1).trim() };
  const [, word = "", rest = ""] = /^(\S*)\s*(.*)$/s.exec(text) ?? [];
  if (word.startsWith("/")) return { kind: "slash", name: word.slice(1).toLowerCase(), args: rest.trim() };
  if (word === "exit" || word === "quit") return { kind: "exit" };
  // A prompt command stands alone (`help <tool>` aside); "open the report" is a sentence.
  if (promptCommands.includes(word) && (!rest.trim() || (word === "help" && !/\s/.test(rest.trim())))) return { kind: "command", name: word, rest: rest.trim() };
  if (isTool(word)) return { kind: "tool", name: word, rest };
  return { kind: "message", text };
}
