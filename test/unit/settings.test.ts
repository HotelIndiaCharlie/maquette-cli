import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { load, parse, SettingsError, write } from "../../src/settings.ts";

function folders() {
  const base = mkdtempSync(join(tmpdir(), "maquette-settings-"));
  const home = join(base, "home");
  const cwd = join(base, "project");
  mkdirSync(join(home, ".maquette"), { recursive: true });
  mkdirSync(join(cwd, ".maquette"), { recursive: true });
  return { home, cwd, user: join(home, ".maquette", "settings.json"), project: join(cwd, ".maquette", "settings.json") };
}

test("defaults hold when there are no files", () => {
  const { home, cwd } = folders();
  const { settings, origins } = load({ home, cwd, env: {} });
  assert.equal(settings.provider, "anthropic");
  assert.equal(settings.model, undefined);
  assert.equal(settings.port, 8787);
  assert.equal(settings.providers.anthropic.effort, "high");
  assert.equal(settings.providers["openai-compatible"].baseUrl, "http://localhost:11434/v1");
  assert.deepEqual(origins.get("port"), { source: "default" });
});

test("user, project, environment and flags override in that order, key by key", () => {
  const { home, cwd, user, project } = folders();
  writeFileSync(user, JSON.stringify({ provider: "openai-compatible", model: "llama3.1", port: 9000, providers: { anthropic: { effort: "low" } } }));
  writeFileSync(project, JSON.stringify({ model: "qwen3", providers: { "openai-compatible": { vision: false } } }));
  const { settings, origins } = load({ home, cwd, env: { MAQUETTE_PORT: "9100", OPENAI_BASE_URL: "http://gpu:8000/v1" }, flags: { model: "mistral", provider: undefined } });
  assert.equal(settings.provider, "openai-compatible");
  assert.deepEqual(origins.get("provider"), { source: "user", path: user });
  assert.equal(settings.model, "mistral");
  assert.deepEqual(origins.get("model"), { source: "flag" });
  assert.equal(settings.port, 9100);
  assert.deepEqual(origins.get("port"), { source: "env", path: "MAQUETTE_PORT" });
  assert.equal(settings.providers.anthropic.effort, "low");
  assert.equal(settings.providers.anthropic.maxTokens, 64000);
  assert.equal(settings.providers["openai-compatible"].vision, false);
  assert.equal(settings.providers["openai-compatible"].baseUrl, "http://gpu:8000/v1");
});

test("unknown keys are warned about and ignored; wrong types and bad JSON are errors", () => {
  const { home, cwd, user, project } = folders();
  writeFileSync(user, JSON.stringify({ colour: "blue", providers: { anthropic: { temperature: 1 } } }));
  const { warnings } = load({ home, cwd, env: {} });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /"colour"/);
  writeFileSync(project, JSON.stringify({ port: "8787" }));
  assert.throws(() => load({ home, cwd, env: {} }), /port must be a number/);
  writeFileSync(project, JSON.stringify({ provider: "openai" }));
  assert.throws(() => load({ home, cwd, env: {} }), /must be one of anthropic, openai-compatible/);
  writeFileSync(project, "{ not json");
  assert.throws(() => load({ home, cwd, env: {} }), SettingsError);
  assert.throws(() => load({ home, cwd: folders().cwd, env: { MAQUETTE_PORT: "99999" } }), /from 1 to 65535/);
});

test("lenient loading keeps going past bad values, so they can be fixed", () => {
  const { home, cwd, user, project } = folders();
  writeFileSync(user, JSON.stringify({ port: 9000 }));
  writeFileSync(project, JSON.stringify({ provider: "openai", port: "x" }));
  const { settings, warnings } = load({ home, cwd, env: { MAQUETTE_MODEL: "", MAQUETTE_PORT: "0" }, lenient: true });
  assert.equal(settings.provider, "anthropic");
  assert.equal(settings.port, 9000);
  assert.equal(settings.model, undefined);
  assert.equal(warnings.length, 3);
  assert.match(warnings[2], /port must be from 1 to 65535, not 0 \(MAQUETTE_PORT\)\. It's ignored until it's fixed\./);
});

test("parse reads values by the key's type", () => {
  assert.equal(parse("port", "8800"), 8800);
  assert.equal(parse("providers.anthropic.compaction", "false"), false);
  assert.equal(parse("model", "claude-sonnet-5-5"), "claude-sonnet-5-5");
  assert.throws(() => parse("providers.anthropic.compaction", "no"), /true or false/);
  assert.throws(() => parse("port", "1.5"), /whole number/);
  assert.throws(() => parse("nope", "1"), /no setting "nope"/);
});

test("write sets one key, keeps the others, and unset tidies empty objects", () => {
  const { user } = folders();
  writeFileSync(user, JSON.stringify({ port: 9000 }));
  write(user, "providers.anthropic.effort", "max");
  write(user, "model", "claude-fable-5-1");
  assert.deepEqual(JSON.parse(readFileSync(user, "utf8")), { port: 9000, providers: { anthropic: { effort: "max" } }, model: "claude-fable-5-1" });
  assert.equal(write(user, "providers.anthropic.effort", undefined), true);
  assert.equal(write(user, "providers.anthropic.effort", undefined), false);
  assert.deepEqual(JSON.parse(readFileSync(user, "utf8")), { port: 9000, model: "claude-fable-5-1" });
  const fresh = join(folders().cwd, "elsewhere", "settings.json");
  write(fresh, "port", 8000);
  assert.deepEqual(JSON.parse(readFileSync(fresh, "utf8")), { port: 8000 });
});
