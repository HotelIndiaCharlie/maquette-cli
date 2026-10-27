// The DesignCraft CLI that Maquette runs. Maquette uses the one given with --designcraft or
// DESIGNCRAFT_CLI, else the pinned version (designcraft-pin.json) in ~/.maquette. That one
// is installed from DesignCraft's GitHub release: the headless CLI only, never the desktop
// app, checked against its pinned SHA-256 before it's unpacked.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";

type Pin = { version: string; release: string; cli: { asset: string; url: string; sha256: string; bytes: number; binary: string } };

export const pin: Pin = JSON.parse(readFileSync(new URL("../designcraft-pin.json", import.meta.url), "utf8"));
export const home = join(homedir(), ".maquette", "designcraft", pin.version);
export const pinned = join(home, pin.cli.binary);

// The CLI to run, or undefined when the pinned one isn't installed yet.
export function findDesignCraft(given = process.env.DESIGNCRAFT_CLI): string | undefined {
  if (given) {
    if (!existsSync(given)) throw new Error(`There's no DesignCraft CLI at ${given}.`);
    return given;
  }
  return existsSync(pinned) ? pinned : undefined;
}

// Downloads the pinned CLI (or reads `from`, a copy of the release's zip), checks it and
// unpacks it. `progress` hears the bytes read so far.
export async function installDesignCraft(from?: string, progress?: (bytes: number) => void): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error(`DesignCraft ${pin.version} publishes its CLI for macOS only. Elsewhere, build designcraft-cli from source and point Maquette at it with --designcraft <path> or DESIGNCRAFT_CLI.`);
  }
  mkdirSync(home, { recursive: true });
  const zip = join(home, pin.cli.asset);
  const part = `${zip}.part`;
  let source: Readable;
  if (from) source = createReadStream(from);
  else {
    const res = await fetch(pin.cli.url);
    if (!res.ok || !res.body) throw new Error(`Downloading ${pin.cli.url} failed: HTTP ${res.status}.`);
    source = Readable.fromWeb(res.body as ReadableStream);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    source,
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        progress?.((bytes += chunk.length));
        yield chunk;
      }
    },
    createWriteStream(part),
  );
  const sum = hash.digest("hex");
  if (sum !== pin.cli.sha256) {
    rmSync(part);
    throw new Error(`The CLI's SHA-256 is ${sum}, not the pinned ${pin.cli.sha256}, so it wasn't installed.`);
  }
  renameSync(part, zip);
  execFileSync("/usr/bin/ditto", ["-x", "-k", zip, home]);
  rmSync(zip);
  if (!existsSync(pinned)) throw new Error(`${pin.cli.asset} didn't hold ${pin.cli.binary}.`);
  return pinned;
}
