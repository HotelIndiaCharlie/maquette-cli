// Maquette's settings. Four layers, each overriding the one before key by key: the user's
// ~/.maquette/settings.json, the project's .maquette/settings.json in the folder Maquette runs
// in, environment variables, then command-line flags. `maquette config` shows the result and
// where each value came from; `maquette config set` writes one key. API keys never go in these
// files: a provider names the environment variable that holds its key.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Source = "default" | "user" | "project" | "env" | "flag";
type Kind = "string" | "number" | "boolean";
type Spec = { kind: Kind; default?: unknown; choices?: readonly string[]; min?: number; max?: number; env?: string; about: string };

export const providerNames = ["anthropic", "openai-compatible"] as const;
export type ProviderName = (typeof providerNames)[number];
export const efforts = ["default", "low", "medium", "high", "xhigh", "max"] as const;
export const permissionModes = ["ask", "auto", "plan"] as const;

// Every setting, by its dotted key.
export const schema: Record<string, Spec> = {
  provider: { kind: "string", default: "anthropic", choices: providerNames, env: "MAQUETTE_PROVIDER", about: "Which model provider to use" },
  model: { kind: "string", env: "MAQUETTE_MODEL", about: "The model's id; unset means the provider's default (anthropic: claude-opus-5-5)" },
  port: { kind: "number", default: 8787, min: 1, max: 65535, env: "MAQUETTE_PORT", about: "The local port Maquette listens on for other sessions" },
  designcraft: { kind: "string", env: "DESIGNCRAFT_CLI", about: "A DesignCraft CLI to run instead of the pinned one" },
  "providers.anthropic.apiKeyEnv": { kind: "string", default: "ANTHROPIC_API_KEY", about: "The environment variable holding the API key (else ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile)" },
  "providers.anthropic.baseUrl": { kind: "string", env: "ANTHROPIC_BASE_URL", about: "Another endpoint for the Claude API, such as a gateway" },
  "providers.anthropic.effort": { kind: "string", default: "high", choices: efforts, about: "How hard the model thinks; default leaves it to the model" },
  "providers.anthropic.maxTokens": { kind: "number", default: 64000, min: 1, about: "The longest reply, in tokens" },
  "providers.anthropic.refusalFallback": { kind: "boolean", default: true, about: "When the model declines on policy grounds, let the API retry on its default fallback model" },
  "providers.anthropic.compaction": { kind: "boolean", default: true, about: "Let the API summarise early history when a conversation gets long" },
  "providers.openai-compatible.baseUrl": { kind: "string", default: "http://localhost:11434/v1", env: "OPENAI_BASE_URL", about: "The server's /v1 address: Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, …" },
  "providers.openai-compatible.apiKeyEnv": { kind: "string", default: "OPENAI_API_KEY", about: "The environment variable holding the API key, if the server needs one" },
  "providers.openai-compatible.vision": { kind: "boolean", default: true, about: "Whether the model accepts images; when false, images are left out with a note" },
  "providers.openai-compatible.maxTokens": { kind: "number", min: 1, about: "The longest reply, in tokens; unset leaves it to the server" },
  "permissions.mode": { kind: "string", default: "ask", choices: permissionModes, env: "MAQUETTE_PERMISSIONS", about: "What the model may do unasked at the prompt: ask (reads run, changes ask y/n/always), auto (everything runs), plan (reading only)" },
};

export type Settings = {
  provider: ProviderName;
  model?: string;
  port: number;
  designcraft?: string;
  providers: {
    anthropic: { apiKeyEnv: string; baseUrl?: string; effort: (typeof efforts)[number]; maxTokens: number; refusalFallback: boolean; compaction: boolean };
    "openai-compatible": { baseUrl: string; apiKeyEnv: string; vision: boolean; maxTokens?: number };
  };
  permissions: { mode: (typeof permissionModes)[number] };
};

export type Origin = { source: Source; path?: string };
export type Loaded = { settings: Settings; origins: Map<string, Origin>; files: { user: string; project: string }; warnings: string[] };
// `lenient` turns a bad value in a file or variable into a warning, and keeps the value before
// it, so `maquette config` can still show and fix the settings.
export type Where = { home?: string; cwd?: string; env?: NodeJS.ProcessEnv; flags?: Record<string, string | undefined>; lenient?: boolean };

export class SettingsError extends Error {}

export function files(where: Where = {}) {
  return {
    user: join(where.home ?? homedir(), ".maquette", "settings.json"),
    project: join(where.cwd ?? process.cwd(), ".maquette", "settings.json"),
  };
}

// The dotted keys and values of a JSON object: {"providers": {"anthropic": {"effort": "low"}}}
// gives providers.anthropic.effort = "low".
function flatten(value: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) out[prefix] = value;
  return out;
}

function check(key: string, value: unknown, where: string): unknown {
  const spec = schema[key];
  const bad = (why: string) => new SettingsError(`${key} ${why} (${where}).`);
  if (typeof value !== spec.kind) throw bad(`must be a ${spec.kind}, not ${JSON.stringify(value)}`);
  if (spec.choices && !spec.choices.includes(value as string)) throw bad(`must be one of ${spec.choices.join(", ")}, not "${value}"`);
  if (spec.kind === "number") {
    const n = value as number;
    if (!Number.isInteger(n)) throw bad(`must be a whole number, not ${n}`);
    if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) throw bad(`must be from ${spec.min ?? "-∞"} to ${spec.max ?? "∞"}, not ${n}`);
  }
  return value;
}

// A value as typed on the command line or in an environment variable, read by its key's type.
export function parse(key: string, raw: string, where = "command line"): unknown {
  const spec = schema[key];
  if (!spec) throw new SettingsError(`There's no setting "${key}". \`maquette config\` lists them.`);
  if (spec.kind === "number") {
    if (raw.trim() === "" || Number.isNaN(Number(raw))) throw new SettingsError(`${key} must be a number, not "${raw}" (${where}).`);
    return check(key, Number(raw), where);
  }
  if (spec.kind === "boolean") {
    if (raw !== "true" && raw !== "false") throw new SettingsError(`${key} must be true or false, not "${raw}" (${where}).`);
    return raw === "true";
  }
  return check(key, raw, where);
}

function readFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new SettingsError(`${path} isn't valid JSON: ${(e as Error).message}`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new SettingsError(`${path} must hold a JSON object.`);
  return json as Record<string, unknown>;
}

export function load(where: Where = {}): Loaded {
  const env = where.env ?? process.env;
  const paths = files(where);
  const values = new Map<string, unknown>();
  const origins = new Map<string, Origin>();
  const warnings: string[] = [];
  const take = (key: string, read: () => unknown, origin: Origin) => {
    try {
      values.set(key, read());
      origins.set(key, origin);
    } catch (e) {
      if (!where.lenient || !(e instanceof SettingsError)) throw e;
      warnings.push(`${e.message} It's ignored until it's fixed.`);
    }
  };
  for (const [key, spec] of Object.entries(schema)) {
    if (spec.default !== undefined) {
      values.set(key, spec.default);
      origins.set(key, { source: "default" });
    }
  }
  for (const source of ["user", "project"] as const) {
    const path = paths[source];
    for (const [key, value] of Object.entries(flatten(readFile(path)))) {
      if (!schema[key]) {
        warnings.push(`${path} has a setting Maquette doesn't know, "${key}"; it's ignored.`);
        continue;
      }
      take(key, () => check(key, value, path), { source, path });
    }
  }
  for (const [key, spec] of Object.entries(schema)) {
    const raw = spec.env ? env[spec.env] : undefined;
    if (spec.env && raw !== undefined && raw !== "") take(key, () => parse(key, raw, spec.env), { source: "env", path: spec.env });
  }
  for (const [key, raw] of Object.entries(where.flags ?? {})) {
    if (raw === undefined) continue;
    values.set(key, parse(key, raw, `--${key}`));
    origins.set(key, { source: "flag" });
  }
  const settings: Record<string, unknown> = {};
  for (const [key, value] of values) {
    const path = key.split(".");
    let into = settings;
    for (const k of path.slice(0, -1)) into = (into[k] ??= {}) as Record<string, unknown>;
    into[path.at(-1)!] = value;
  }
  return { settings: settings as Settings, origins, files: paths, warnings };
}

// Writes one key into a settings file, or removes it when value is undefined, keeping the
// file's other keys. Returns false when there was nothing to remove.
export function write(path: string, key: string, value: unknown): boolean {
  if (!schema[key]) throw new SettingsError(`There's no setting "${key}". \`maquette config\` lists them.`);
  const json = readFile(path);
  const parts = key.split(".");
  const chain: Record<string, unknown>[] = [json];
  for (const k of parts.slice(0, -1)) {
    const next = chain.at(-1)![k];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      if (value === undefined) return false;
      chain.at(-1)![k] = {};
    }
    chain.push(chain.at(-1)![k] as Record<string, unknown>);
  }
  const last = parts.at(-1)!;
  if (value === undefined) {
    if (!(last in chain.at(-1)!)) return false;
    delete chain.at(-1)![last];
    // Drop the objects left empty, innermost first.
    for (let i = chain.length - 1; i > 0 && !Object.keys(chain[i]).length; i--) delete chain[i - 1][parts[i - 1]];
  } else chain.at(-1)![last] = value;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  return true;
}

// Every setting that has a default, as a settings file would hold it. `maquette config edit`
// writes this beside the settings as a reference; Maquette never reads it back, so a default
// that changes in a later version still reaches everyone who hasn't set that key.
export function defaults(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const flat = { ...Object.fromEntries(Object.entries(schema).filter(([, spec]) => spec.default !== undefined).map(([k, spec]) => [k, spec.default])), ...extra };
  for (const key of Object.keys(schema)) {
    if (!(key in flat)) continue;
    const path = key.split(".");
    let into = out;
    for (const k of path.slice(0, -1)) into = (into[k] ??= {}) as Record<string, unknown>;
    into[path.at(-1)!] = flat[key];
  }
  return out;
}

// Creates an empty settings file ({}) when there's none yet. Returns true when it made one.
export function ensure(path: string): boolean {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{}\n");
  return true;
}
