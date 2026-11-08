import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chart from "../../src/tools/chart/index.ts";
import type { ChartEntry } from "../../src/tools/chart/draw.ts";
import type { ChartSpec } from "../../src/tools/chart/spec.ts";
const spec: ChartSpec = { mark: "bar", data: { values: [{ x: "A", y: 2 }] }, encoding: { x: { field: "x", type: "nominal" }, y: { field: "y", type: "quantitative" } } };
function fixture(failure?: string, creating = false) {
  let nextId = 100; let phase = 0;
  const original: any = { id: 90, kind: "Group", bounds: [0, 0, 300, 200], children: [{ id: 91, kind: "Rectangle", bounds: [0, 0, 300, 200], fill: "blue" }] };
  const items: any[] = creating ? [{ id: 1, kind: "Rectangle", bounds: [0, 0, 300, 200] }] : [original]; const calls: any[] = [];
  const all = (): any[] => items.flatMap(i => [i, ...(i.children ?? [])]);
  const dc = {
    async inspect() { if (failure === "lost" && phase > 0) throw new Error("lost"); return structuredClone({ spreads: [{ index: 0, pages: [{ index: 0, bounds: [0, 0, 300, 200] }], items }], stories: [] }); },
    async execute(command: string, p: any = {}) {
      calls.push({ command, params: p });
      if (command === "object.findByLabel") return { ids: [] };
      if (command === "edit.clear") {
        if ((failure === "cleanup" || failure === "finalize-cleanup") && !p.ids.includes(90)) throw new Error("cleanup failed");
        if (failure === "missing-both" && p.ids.includes(90)) { items.length = 0; throw new Error("commit failed after deletion"); }
        for (let i = items.length - 1; i >= 0; i--) if (p.ids.includes(items[i].id)) items.splice(i, 1);
      }
      if (command === "frame.create" || command === "line.create" || command === "path.create") {
        const id = nextId++; const bounds = p.rect ?? (p.a ? [p.a[0], p.a[1], p.b[0], p.b[1]] : [0,0,10,10]);
        items.push({ id, kind: command === "frame.create" && p.content === "text" ? "TextFrame" : "Rectangle", bounds, fill: "blue" }); return { id, story: id };
      }
      if (command === "transform.move") for (const id of p.ids) { const i = all().find(i => i.id === id); i.bounds = i.bounds.map((v: number, n: number) => v + (n % 2 ? p.dy : p.dx)); }
      if (command === "object.group") {
        const children = items.filter(i => p.ids.includes(i.id)); const id = nextId++;
        for (let i = items.length - 1; i >= 0; i--) if (p.ids.includes(items[i].id)) items.splice(i, 1);
        items.push({ id, kind: "Group", bounds: [0,0,300,200], children }); return { id };
      }
      return {};
    },
    async batch(commands: any[]) {
      phase++; const results: any[] = [];
      const resolve = (v: any): any => typeof v === "string" && /^\$\d+\./.test(v) ? v.slice(1).split(".").reduce((o: any, k: string) => o[k], results) : Array.isArray(v) ? v.map(resolve) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k,v]) => [k,resolve(v)])) : v;
      for (const c of commands) {
        if ((failure === "draw" || failure === "cleanup" || failure === "lost") && c.command === "style.paragraph.apply") throw new Error("partial draw failed");
        results.push(await this.execute(c.command, resolve(c.params)));
        if ((failure === "finalize" || failure === "finalize-cleanup") && c.command === "object.label" && !String(c.params.label).includes(":pending:")) throw new Error("labels failed after applying one label");
      }
      return results;
    },
    async call() { if (failure === "render") return { isError: true, content: [] }; return { content: [] }; },
  };
  const root = mkdtempSync(join(tmpdir(), "maquette-chart-safety-"));
  const module = chart({ dc: dc as any, root, readRoots: [root], warnings: () => [] });
  const entry: ChartEntry = { chart: "1", frame: 1, group: 90, spread: 0, page: 0, rect: [0,0,300,200], spec, items: [{ id: 91, key: "bar:A", kind: "rect", bounds: [0,0,300,200], fill: "blue" }], drawn: "then" };
  module.opened!({ charts: creating ? [] : [entry] }); return { module, items, calls, entry, original };
}
test("invalid spec and missing data never clear or draw the existing chart", async () => {
  for (const args of [{ spec: { mark: "area" } }, { data: { url: "missing.csv" } }]) {
    const f = fixture(); await assert.rejects(() => f.module.call("chart_update", { chart: "1", ...args })); assert.equal(f.calls.length, 0); assert.deepEqual(f.items, [f.original]);
  }
});
test("internal hand changes block update before any effect", async () => {
  const f = fixture(); f.original.children[0].fill = "red";
  await assert.rejects(() => f.module.call("chart_update", { chart: "1" }), /was not changed.*hand changes/); assert.equal(f.calls.length, 0);
});
test("partial draw and finalization failures clean the candidate, retaining original and registry", async () => {
  for (const failure of ["draw", "finalize"]) {
    const f = fixture(failure); await assert.rejects(() => f.module.call("chart_update", { chart: "1" }), /Original chart 1 was kept/);
    assert.deepEqual(f.items, [f.original]); assert.equal((f.module.saved!() as any).charts[0].group, 90);
  }
});
test("cleanup failure and connection loss report uncertainty without clearing original", async () => {
  const cleanup = fixture("cleanup"); await assert.rejects(() => cleanup.module.call("chart_update", { chart: "1" }), /cleanup.*failed/); assert.ok(cleanup.items.some(i => i.id === 90));
  const lost = fixture("lost"); await assert.rejects(() => lost.module.call("chart_update", { chart: "1" }), /outcome is uncertain/); assert.ok(lost.items.some(i => i.id === 90));
});
test("successful staged replacement removes original last; preview failure is only a warning", async () => {
  for (const failure of [undefined, "render"]) {
    const f = fixture(failure); const r = await f.module.call("chart_update", { chart: "1" });
    assert.equal(f.items.length, 1); assert.notEqual(f.items[0].id, 90); assert.deepEqual(f.calls.at(-1), { command: "edit.clear", params: { ids: [90] } });
    assert.equal((f.module.saved!() as any).charts[0].group, f.items[0].id); if (failure) assert.match(r.content[0].text!, /Chart updated; preview unavailable/);
  }
});

test("create render errors keep a registered chart; preview render errors always remove it", async () => {
  for (const preview of [false, true]) {
    const f = fixture("render", true);
    const r = await f.module.call("chart_create", { frame: "1", spec, preview });
    assert.match(JSON.stringify(r), /Preview unavailable/);
    const charts = (f.module.saved!() as any)?.charts ?? [];
    assert.equal(charts.length, preview ? 0 : 1);
    assert.equal(f.items.filter(i => i.kind === "Group").length, preview ? 0 : 1);
  }
});

test("discarding hand changes requires an explicit boolean override and reports what was lost", async () => {
  const f = fixture(); f.original.children[0].fill = "red";
  await assert.rejects(() => f.module.call("chart_update", { chart: "1", discard_hand_changes: "true" }), /discard_hand_changes: true/);
  const r = await f.module.call("chart_update", { chart: "1", discard_hand_changes: true });
  assert.match(r.content[0].text!, /Discarded confirmed hand changes/); assert.doesNotMatch(r.content[0].text!, /No hand changes/);
});

test("failed finalization cleanup names definitive labels and persists uncertainty when both groups disappear", async () => {
  const cleanup = fixture("finalize-cleanup");
  await assert.rejects(() => cleanup.module.call("chart_update", { chart: "1" }), /Potentially duplicated definitive labels: firstlight:chart:1/);
  const missing = fixture("missing-both");
  await assert.rejects(() => missing.module.call("chart_update", { chart: "1" }), /candidate group .*also absent/);
  const listed = await missing.module.call("chart_list", {}); assert.match(listed.content[0].text!, /uncertain/);
  await assert.rejects(() => missing.module.call("chart_update", { chart: "1" }), /outcome is uncertain/);
});
