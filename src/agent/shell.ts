// `!command` at the prompt and the model's `bash` tool: runs in Maquette's folder, output
// capped so a long listing can't swamp the conversation.
import { spawn } from "node:child_process";

export type ShellResult = { output: string; code: number | null; timedOut?: boolean };

export function runShell(command: string, cwd: string, options: { signal?: AbortSignal; cap?: number; timeout?: number } = {}): Promise<ShellResult> {
  const cap = options.cap ?? 20_000;
  const timeout = options.timeout ?? 120_000;
  return new Promise((done) => {
    const windows = process.platform === "win32";
    // Its own process group off Windows, so a timeout or Ctrl-C stops what the command
    // started too; a `sleep` under sh would otherwise keep the output open after sh is gone.
    const child = spawn(windows ? "cmd" : "/bin/sh", [windows ? "/c" : "-c", command], { cwd, env: process.env, detached: !windows, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let dropped = 0;
    let ended: "timeout" | "abort" | undefined;
    const stop = (why: "timeout" | "abort") => {
      ended ??= why;
      try {
        if (!windows && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => stop("timeout"), timeout);
    const onAbort = () => stop("abort");
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const take = (d: Buffer) => {
      const s = d.toString();
      if (output.length < cap) output += s.slice(0, cap - output.length);
      else dropped += s.length;
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const finish = (result: ShellResult) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      done(result);
    };
    child.on("error", (e) => finish({ output: `${output}${e.message}`, code: null }));
    child.on("close", (code) => {
      const tail = ended === "timeout" ? `\nStopped after ${Math.round(timeout / 1000)} s.` : ended === "abort" ? "\nInterrupted." : "";
      finish({ output: `${output.replace(/\n$/, "")}${dropped ? `\n… ${dropped} more characters left out` : ""}${tail}`.replace(/^\n/, ""), code: ended ? null : code, ...(ended === "timeout" ? { timedOut: true } : {}) });
    });
  });
}
