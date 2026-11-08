// Exclusive local ownership. A dead process may be reclaimed, never a live writer.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
export class OwnershipError extends Error { code = "OWNERSHIP"; }
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}
export function acquireLock(path: string, metadata: Record<string, unknown> = {}): () => void {
  const token = JSON.stringify({ ...metadata, pid: process.pid, token: randomUUID() });
  const attempt = () => {
    const fd = openSync(path, "wx", 0o600);
    try { writeSync(fd, token); fsyncSync(fd); } finally { closeSync(fd); }
  };
  try { attempt(); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let reap = `${path}.reap`;
    let fd: number;
    // Never unlink a stale reaper: a second starter may already have observed
    // it. Elect a recovery owner under a deterministic successor name instead.
    // A crash at any depth is recoverable without deleting a live guard.
    for (;;) {
      try { fd = openSync(reap, "wx", 0o600); break; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        let before: string;
        try { before = readFileSync(reap, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
        let owner: { pid?: number } = {};
        try { owner = JSON.parse(before); } catch {}
        const dead = Number.isInteger(owner.pid) && owner.pid! > 0 && !processAlive(owner.pid!);
        let age: number;
        try { age = Date.now() - statSync(reap).mtimeMs; } catch { continue; }
        if (!dead && (owner.pid || age < 10_000)) throw new OwnershipError(`Ownership is being checked: ${path}. Try again.`);
        reap = `${path}.reap-${createHash("sha256").update(reap + before).digest("hex").slice(0, 24)}`;
      }
    }
    try {
      writeSync(fd, token); fsyncSync(fd);
      if (existsSync(path)) {
        let owner: { pid: number; port?: number };
        try { owner = JSON.parse(readFileSync(path, "utf8")); } catch { throw new OwnershipError(`Unreadable ownership lock ${path}; inspect it before removing it.`); }
        if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new OwnershipError(`Invalid ownership lock ${path}.`);
        if (processAlive(owner.pid)) throw new OwnershipError(`Already owned by process ${owner.pid}${owner.port ? ` on port ${owner.port}` : ""}: ${path}. Close that writer or start a new session.`);
        unlinkSync(path);
      }
      attempt();
    } finally { closeSync(fd); if (existsSync(reap) && readFileSync(reap, "utf8") === token) unlinkSync(reap); }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).token === JSON.parse(token).token) unlinkSync(path);
  };
}
