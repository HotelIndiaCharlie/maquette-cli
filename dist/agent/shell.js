// `!command` at the prompt: runs in Maquette's folder, output capped so a long listing can't
// swamp the conversation.
import { spawn } from "node:child_process";
export function runShell(command, cwd, options = {}) {
    const cap = options.cap ?? 20_000;
    return new Promise((done) => {
        const shell = process.platform === "win32" ? "cmd" : "/bin/sh";
        const flag = process.platform === "win32" ? "/c" : "-c";
        const child = spawn(shell, [flag, command], { cwd, env: process.env, signal: options.signal, timeout: options.timeout ?? 120_000 });
        let output = "";
        let dropped = 0;
        const take = (d) => {
            const s = d.toString();
            if (output.length < cap)
                output += s.slice(0, cap - output.length);
            else
                dropped += s.length;
        };
        child.stdout.on("data", take);
        child.stderr.on("data", take);
        child.on("error", (e) => done({ output: `${output}${e.code === "ABORT_ERR" ? "Interrupted." : e.message}`, code: null }));
        child.on("close", (code) => done({ output: `${output.replace(/\n$/, "")}${dropped ? `\n… ${dropped} more characters left out` : ""}`, code }));
    });
}
