// Ink 8.0.0 clears a narrowed frame using its old logical row count. Terminals
// have already reflowed those rows, so borders can leave ghost prompts (#907).
// Its public clear() has the same limitation. Keep this version-checked adapter
// isolated: sync and clear only the existing frame's physical rows before Ink
// redraws it at the bottom. Never erase/replay Static or clear scrollback.
import { readFileSync } from "node:fs";
import wrapAnsi from "wrap-ansi";

type Renderer = { lastTerminalWidth: number; lastTerminalHeight: number; lastOutputToRender: string; clear(): void; log: { sync(text: string): void } };

export async function repairResize(stdout: NodeJS.WriteStream): Promise<() => void> {
  const entry = import.meta.resolve("ink");
  const version = JSON.parse(readFileSync(new URL("../package.json", entry), "utf8")).version;
  if (version !== "8.0.0") throw new Error("Review Maquette's resize adapter before changing the pinned Ink version.");
  // Ink exposes no public API for synchronizing the old frame after terminal
  // reflow. This is the only access to its pinned internal renderer in Maquette.
  const instances = (await import(new URL("./instances.js", entry).href)).default as WeakMap<object, Renderer>;
  const renderer = instances.get(stdout);
  if (!renderer || typeof renderer.lastTerminalWidth !== "number" || typeof renderer.lastTerminalHeight !== "number" || typeof renderer.lastOutputToRender !== "string" || typeof renderer.clear !== "function" || typeof renderer.log?.sync !== "function") throw new Error("The pinned Ink resize adapter could not find its renderer.");
  const beforeResize = () => {
    if (stdout.columns > 0 && stdout.rows > 0 && (stdout.columns !== renderer.lastTerminalWidth || stdout.rows !== renderer.lastTerminalHeight) && renderer.lastOutputToRender) {
      renderer.log.sync(wrapAnsi(renderer.lastOutputToRender, stdout.columns, { hard: true, trim: false, wordWrap: false }));
      renderer.clear();
      // Widening can reflow history upward and leave the cursor near the top.
      // Anchor the next frame at the bottom, otherwise the next narrowing can
      // push parts of that frame into scrollback, where erasing cannot reach it.
      stdout.write(`\x1b[${stdout.rows};1H`);
    }
  };
  stdout.prependListener("resize", beforeResize);
  return () => { stdout.off("resize", beforeResize); };
}
