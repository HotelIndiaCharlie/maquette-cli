// `--trace`: makes sure Phoenix is answering on localhost:6006 before Maquette traces to it.
// Phoenix already up is used as it is; otherwise it runs in Docker, in a container named
// maquette-phoenix whose traces are kept in a volume, and Docker itself is started first when
// its daemon isn't running. The container stays up after Maquette stops, so the traces can
// still be read, and the next --trace finds it running.
import { execFile } from "node:child_process";

export const phoenixUrl = "http://localhost:6006";
export const container = "maquette-phoenix";
// A release at least two weeks old, as with the other pins; bump it by hand.
export const image = "arizephoenix/phoenix:version-20.21.4";

export type Run = (command: string, args: string[], timeout?: number) => Promise<{ code: number | null; out: string; missing?: boolean }>;

const run: Run = (command, args, timeout = 30_000) =>
  new Promise((done) =>
    execFile(command, args, { timeout }, (e, stdout, stderr) => {
      const err = e as (NodeJS.ErrnoException & { code?: number | string }) | null;
      done({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: `${stdout}${stderr}`.trim(), ...(err?.code === "ENOENT" ? { missing: true } : {}) });
    }),
  );

export async function healthy(url = phoenixUrl): Promise<boolean> {
  try {
    return (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

export type EnsureOptions = {
  say: (text: string) => void; // progress, while the screen isn't up yet
  run?: Run;
  platform?: NodeJS.Platform;
  isHealthy?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
};

// Resolves with how Phoenix came to be running, for the line under the title; rejects with
// what to do when it can't be started.
export async function ensurePhoenix(options: EnsureOptions): Promise<string> {
  const { say, run: exec = run, platform = process.platform, isHealthy = () => healthy(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = options;
  const until = async (check: () => Promise<boolean>, seconds: number) => {
    for (let i = 0; i < seconds; i++) {
      if (await check()) return true;
      await sleep(1000);
    }
    return check();
  };
  if (await isHealthy()) return "Phoenix already running";

  let started = "";
  const docker = await exec("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (docker.missing) throw new Error("Docker isn't installed. Install Docker Desktop, or start Phoenix yourself: docs/telemetry.md");
  if (docker.code !== 0) {
    say("Starting Docker…");
    const start = platform === "darwin" ? await exec("open", ["-a", "Docker"]) : await exec("systemctl", ["start", "docker"]);
    if (start.code !== 0) throw new Error(`Docker isn't running, and it couldn't be started (${start.out.split("\n")[0] || "no reason given"}). Start it, then run again.`);
    if (!(await until(async () => (await exec("docker", ["info", "--format", "{{.ServerVersion}}"])).code === 0, 120))) throw new Error("Docker was started but didn't come up within two minutes. Run again once it's up.");
    started = "Docker started, ";
  }

  const state = (await exec("docker", ["ps", "-a", "--filter", `name=^${container}$`, "--format", "{{.State}}"])).out;
  if (!state) {
    say(`Starting Phoenix in Docker; the first time downloads ${image}…`);
    const made = await exec("docker", ["run", "-d", "--name", container, "-p", "127.0.0.1:6006:6006", "-v", `${container}:/mnt/data`, "-e", "PHOENIX_WORKING_DIR=/mnt/data", image], 900_000);
    if (made.code !== 0) throw new Error(`Phoenix's container wouldn't start: ${made.out.split("\n").at(-1)}`);
  } else if (state !== "running") {
    say("Starting Phoenix in Docker…");
    const resumed = await exec("docker", ["start", container]);
    if (resumed.code !== 0) throw new Error(`Phoenix's container wouldn't start: ${resumed.out.split("\n").at(-1)}`);
  }
  if (!(await until(isHealthy, 60))) throw new Error(`Phoenix's container is up but nothing answers on ${phoenixUrl}. \`docker logs ${container}\` says why.`);
  return `${started}Phoenix in Docker`;
}
