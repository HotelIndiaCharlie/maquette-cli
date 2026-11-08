// Keep Ink's live frame in one cursor-owned terminal line. Hard newlines let
// terminal reflow push pieces of an old prompt into unreachable scrollback.
// Soft wraps and a hidden cursor at the frame origin keep it available to erase,
// without replaying Static output or moving the prompt away from the transcript.
import { readFileSync } from "node:fs";
import stringWidth from "string-width";

type Position = { x: number; y: number };
type Log = ((text: string) => boolean) & {
  clear(): void;
  done(): void;
  reset(): void;
  sync(text: string): void;
  setCursorPosition(position: Position | undefined): void;
  getCursorPosition(): Position | undefined;
  isCursorDirty(): boolean;
  willRender(text: string): boolean;
};
type Renderer = {
  interactive: boolean;
  isUnmounted: boolean;
  isScreenReaderEnabled: boolean;
  lastTerminalWidth: number;
  lastTerminalHeight: number;
  lastOutputToRender: string;
  lastOutputHeight: number;
  options: { stdout: NodeJS.WriteStream; debug?: boolean };
  clear(): void;
  renderInteractiveFrame(output: string, height: number, staticOutput: string): void;
  log: Log;
  throttledLog: (text: string) => unknown;
};

export async function repairResize(stdout: NodeJS.WriteStream): Promise<() => void> {
  const entry = import.meta.resolve("ink");
  const version = JSON.parse(readFileSync(new URL("../package.json", entry), "utf8")).version;
  if (version !== "8.0.0") throw new Error("Review Maquette's resize adapter before changing the pinned Ink version.");
  // Ink has no public hook for its live-frame writer. Keep all private access
  // here and review both these modules when updating the pinned dependency.
  const instances = (await import(new URL("./instances.js", entry).href)).default as WeakMap<object, Renderer>;
  const renderer = instances.get(stdout);
  if (!renderer
    || typeof renderer.interactive !== "boolean"
    || typeof renderer.isUnmounted !== "boolean"
    || typeof renderer.isScreenReaderEnabled !== "boolean"
    || typeof renderer.lastTerminalWidth !== "number"
    || typeof renderer.lastTerminalHeight !== "number"
    || typeof renderer.lastOutputToRender !== "string"
    || typeof renderer.lastOutputHeight !== "number"
    || renderer.options?.stdout !== stdout
    || typeof renderer.clear !== "function"
    || typeof renderer.renderInteractiveFrame !== "function"
    || typeof renderer.throttledLog !== "function"
    || typeof renderer.log !== "function"
    || ["clear", "done", "reset", "sync", "setCursorPosition", "getCursorPosition", "isCursorDirty", "willRender"]
      .some(key => typeof (renderer.log as unknown as Record<string, unknown>)[key] !== "function")) {
    throw new Error("The pinned Ink resize adapter could not find its renderer.");
  }
  if (!renderer.interactive || renderer.options.debug || renderer.isScreenReaderEnabled || !stdout.isTTY) return () => {};

  const originalLog = renderer.log;
  const originalRender = renderer.renderInteractiveFrame;
  const unthrottled = renderer.throttledLog === originalLog;
  let frame: string | undefined;
  let staticOutput: string | undefined;
  let showCursor = false;
  const withFrame = <T>(text: string, action: () => T): T => {
    const previous = frame;
    frame = text;
    try { return action(); } finally { frame = previous; }
  };
  // Give log-update its own stream facade; do not patch the real stdout writer.
  // Only the live frame is padded into soft wraps. Static and console output
  // retain their original bytes and hard line breaks.
  const stream = new Proxy(stdout, {
    get(target, key) {
      if (key !== "write") return Reflect.get(target, key, target);
      return (chunk: string | Uint8Array, ...args: unknown[]) => {
        if (typeof chunk !== "string") return Reflect.apply(stdout.write, stdout, [chunk, ...args]);
        let data = chunk;
        if (frame && data !== staticOutput) {
          const at = data.lastIndexOf(frame);
          if (at >= 0) {
            const lines = frame.split("\n");
            const wrapped = lines.map((line, i) => i < lines.length - 1
              ? line + " ".repeat(Math.max(0, stdout.columns - stringWidth(line)))
              : line || " ").join("");
            data = data.slice(0, at) + wrapped + data.slice(at + frame.length);
          }
        }
        if (!showCursor) data = data.replaceAll("\x1b[?25h", "\x1b[?25l");
        return Reflect.apply(stdout.write, stdout, [data, ...args]);
      };
    },
  });
  const logUpdate = (await import(new URL("./log-update.js", entry).href)).default as { create(stream: NodeJS.WriteStream): Log };
  const log = logUpdate.create(stream);
  const parked = Object.assign((text: string) => withFrame(text, () => log(text)), log, {
    setCursorPosition() { log.setCursorPosition({ x: 0, y: 0 }); },
    sync(text: string) {
      log.setCursorPosition({ x: 0, y: 0 });
      log.sync(text);
    },
    done() {
      showCursor = true;
      try { log.done(); } finally { showCursor = false; }
    },
  });
  // The initial render used Ink's ordinary hard lines. Clear it once before
  // switching writers; committed conversation output is outside that frame.
  const initialOutput = renderer.lastOutputToRender;
  const initialHeight = renderer.lastOutputHeight;
  renderer.clear();
  renderer.log = parked;
  if (unthrottled) renderer.throttledLog = parked;
  renderer.renderInteractiveFrame = (output, height, saved) => {
    staticOutput = saved;
    renderer.options.stdout = stream;
    try { withFrame(height >= stdout.rows ? output : output + "\n", () => originalRender(output, height, saved)); }
    finally { staticOutput = undefined; renderer.options.stdout = stdout; }
  };
  const beforeResize = () => {
    if (stdout.columns > 0 && stdout.rows > 0 && (stdout.columns !== renderer.lastTerminalWidth || stdout.rows !== renderer.lastTerminalHeight) && renderer.lastOutputToRender) renderer.clear();
  };
  stdout.prependListener("resize", beforeResize);
  // Force a redraw even if the app is idle when the adapter is installed.
  parked.setCursorPosition();
  renderer.renderInteractiveFrame(initialOutput.replace(/\n$/, ""), initialHeight, "");
  return () => {
    stdout.off("resize", beforeResize);
    if (!renderer.isUnmounted) parked.done();
    renderer.log = originalLog;
    if (unthrottled) renderer.throttledLog = originalLog;
    renderer.options.stdout = stdout;
    renderer.renderInteractiveFrame = originalRender;
    originalLog.reset();
    if (!renderer.isUnmounted && renderer.lastOutputHeight > 0) originalLog.sync(renderer.lastOutputToRender);
  };
}

// Optional terminal repair: a different Ink layout must never prevent startup.
export async function optionalResizeRepair(stdout: NodeJS.WriteStream, warn: (message: string) => void): Promise<() => void> {
  try { return await repairResize(stdout); }
  catch (e) { warn(`Resize repair disabled: ${(e as Error).message}`); return () => {}; }
}
