// Exclusive local ownership. A dead process may be reclaimed, never a live writer.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
export function acquireLock(path) {
    const token = JSON.stringify({ pid: process.pid, token: randomUUID() });
    const attempt = () => {
        const fd = openSync(path, "wx", 0o600);
        try {
            writeSync(fd, token);
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
    };
    try {
        attempt();
    }
    catch (e) {
        if (e.code !== "EEXIST")
            throw e;
        // Serialize stale-owner reclamation itself, so two starters cannot unlink a new lock.
        const reap = `${path}.reap`;
        let fd;
        try {
            fd = openSync(reap, "wx", 0o600);
        }
        catch {
            throw new Error(`Ownership is being checked: ${path}. Try again.`);
        }
        try {
            if (existsSync(path)) {
                let owner;
                try {
                    owner = JSON.parse(readFileSync(path, "utf8"));
                }
                catch {
                    throw new Error(`Unreadable ownership lock ${path}; inspect it before removing it.`);
                }
                if (!Number.isInteger(owner.pid) || owner.pid < 1)
                    throw new Error(`Invalid ownership lock ${path}.`);
                let alive = true;
                try {
                    process.kill(owner.pid, 0);
                }
                catch (err) {
                    alive = err.code !== "ESRCH";
                }
                if (alive)
                    throw new Error(`Already owned by process ${owner.pid}: ${path}. Close that writer or start a new session.`);
                unlinkSync(path);
            }
            attempt();
        }
        finally {
            closeSync(fd);
            unlinkSync(reap);
        }
    }
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        if (existsSync(path) && readFileSync(path, "utf8") === token)
            unlinkSync(path);
    };
}
