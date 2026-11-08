import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireLock } from "../../src/runtime/lock.ts";

test("orphaned reapers can recover a dead owner, while live owners and live reapers remain exclusive", () => {
  const child = spawnSync(process.execPath, ["-e", ""]); assert.equal(child.status, 0);
  const path = join(mkdtempSync(join(tmpdir(), "maquette-lock-")), "owner.lock");
  writeFileSync(path, JSON.stringify({ pid: child.pid })); writeFileSync(`${path}.reap`, JSON.stringify({ pid: child.pid }));
  const release = acquireLock(path); assert.throws(() => acquireLock(path), /Already owned|Ownership is being checked/); release();
  const again = acquireLock(path); again();
  writeFileSync(path, JSON.stringify({ pid: child.pid })); writeFileSync(`${path}.reap`, JSON.stringify({ pid: process.pid }));
  assert.throws(() => acquireLock(path), /Ownership is being checked/);
});
