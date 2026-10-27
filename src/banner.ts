// The start screen's title: the name in block letters, shaded cyan to magenta to yellow like
// the process inks, or in spaced capitals when the terminal is too narrow. No Ink here, so
// the plain start-up path can show it too.
import { paint } from "./args.ts";

const inks = [51, 81, 111, 141, 171, 201, 206, 211, 216, 221, 226];
const shade = (row: string) => [...row].map((ch, i, all) => (ch === " " ? ch : paint(`38;5;${inks[Math.round((i / (all.length - 1)) * (inks.length - 1))]}`, ch))).join("");
const title = [
  "███╗   ███╗ █████╗  ██████╗ ██╗   ██╗███████╗████████╗████████╗███████╗",
  "████╗ ████║██╔══██╗██╔═══██╗██║   ██║██╔════╝╚══██╔══╝╚══██╔══╝██╔════╝",
  "██╔████╔██║███████║██║   ██║██║   ██║█████╗     ██║      ██║   █████╗  ",
  "██║╚██╔╝██║██╔══██║██║▄▄ ██║██║   ██║██╔══╝     ██║      ██║   ██╔══╝  ",
  "██║ ╚═╝ ██║██║  ██║╚██████╔╝╚██████╔╝███████╗   ██║      ██║   ███████╗",
  "╚═╝     ╚═╝╚═╝  ╚═╝ ╚══▀▀═╝  ╚═════╝ ╚══════╝   ╚═╝      ╚═╝   ╚══════╝",
];

export function bannerText(columns = process.stdout.columns || 80): string {
  const rows = columns < title[0].length + 2 ? ["M A Q U E T T E"] : title;
  const swatches = [51, 201, 226, 244].map((n) => paint(`38;5;${n}`, "■")).join(" ");
  return `\n${rows.map((r) => `  ${shade(r)}`).join("\n")}\n\n  ${swatches}  ${paint(1, "one DesignCraft for every session")}\n`;
}
