import { createHash } from "node:crypto";
import { realpathSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processAlive } from "./lock.ts";
export const runtimeLockPath = (root: string) => join(tmpdir(), `maquette-runtime-${process.getuid?.() ?? "user"}-${createHash("sha256").update(realpathSync(root)).digest("hex")}.lock`);
export function runtimeOwner(root: string): { pid: number; port: number } | undefined {
  try { const o = JSON.parse(readFileSync(runtimeLockPath(root), "utf8")); if (Number.isInteger(o.pid) && processAlive(o.pid) && Number.isInteger(o.port) && o.port > 0) return o; } catch {}
}
export function publishPort(root: string, port: number) {
  const path = runtimeLockPath(root), data = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...data, port }), { mode: 0o600 });
}
