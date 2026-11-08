// Real native objects, including failures injected after actual partial drawing/labeling.
// No model, network service, production document or release is involved.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DesignCraft } from "../src/designcraft.ts";
import { findDesignCraft } from "../src/install.ts";
import chart from "../src/tools/chart/index.ts";
import type { ChartEntry } from "../src/tools/chart/draw.ts";
const cli = findDesignCraft(); if (!cli) throw new Error("Install the pinned DesignCraft CLI first.");
const root = realpathSync(mkdtempSync(join(tmpdir(), "maquette-chart-safety-live-")));
cpSync(fileURLToPath(new URL("../examples", import.meta.url)), join(root, "example"), { recursive: true });
const dc = await DesignCraft.start(cli, root);
try {
  await dc.json("open_document", { path: "example/annual-report.designcraft" });
  const module = chart({ dc, root, readRoots: [root], warnings: () => [] });
  const spec = JSON.parse(readFileSync(join(root, "example/specs/01-revenue.json"), "utf8"));
  await module.call("chart_create", { frame: "firstlight:slot:01", spec, render: false });
  const entry = () => (module.saved!() as { charts: ChartEntry[] }).charts[0];
  const chartId = entry().chart, originalGroup = entry().group;
  const baseline = await dc.inspect(); const originalState = structuredClone(module.saved!());
  for (const args of [{ spec: { mark: "area" } }, { data: { url: "missing.csv" } }]) {
    await assert.rejects(() => module.call("chart_update", { chart: chartId, ...args }));
    assert.deepEqual((await dc.inspect()).spreads, baseline.spreads); assert.deepEqual(module.saved!(), originalState);
  }
  const batch = dc.batch.bind(dc);
  for (const phase of ["drawing", "labels"]) {
    let injected = false;
    dc.batch = async commands => {
      const target = phase === "drawing" ? commands.some(c => c.command === "frame.create") : commands.at(-1)?.command === "edit.clear";
      if (target && !injected) { injected = true; await batch(commands.slice(0, 1)); throw new Error(`Injected native ${phase} failure`); }
      return batch(commands);
    };
    await assert.rejects(() => module.call("chart_update", { chart: chartId }), /Original chart .* was kept/);
    assert.equal(injected, true); dc.batch = batch;
    assert.deepEqual((await dc.inspect()).spreads, baseline.spreads); assert.deepEqual(module.saved!(), originalState);
  }
  await dc.execute("transform.move", { ids: [originalGroup], dx: 12, dy: 9 });
  const moved = await module.call("chart_update", { chart: chartId, data: { url: "example/data/01-revenue-updated.csv" }, render: false });
  assert.match(moved.content[0].text!, /moved by 12.0, 9.0 pt/); assert.notEqual(entry().group, originalGroup);
  const call = dc.call.bind(dc);
  dc.call = async (name, args) => name === "render_page" ? { isError: true, content: [] } : call(name, args);
  const preview = await module.call("chart_update", { chart: chartId }); dc.call = call;
  assert.match(preview.content[0].text!, /Chart updated; preview unavailable/);
  const changed = entry().items.find(i => i.kind !== "text")!;
  await dc.execute("transform.move", { ids: [changed.id], dx: 4, dy: 0 });
  const handEdited = await dc.inspect(), handState = structuredClone(module.saved!());
  await assert.rejects(() => module.call("chart_update", { chart: chartId }), /was not changed.*hand changes/);
  assert.deepEqual((await dc.inspect()).spreads, handEdited.spreads); assert.deepEqual(module.saved!(), handState);
  await dc.json("save_document", { path: "safety-checked.designcraft" });
  console.log(`PASS: native validation, partial-draw cleanup, partial-label cleanup, whole-chart move, preview warning and hand-change refusal. Artifacts: ${root}`);
} finally { await dc.client.close(); }
