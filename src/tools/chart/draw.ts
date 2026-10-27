// Draws a planned chart as ordinary DesignCraft items, checks the result against the
// layout, and records what it drew so a later update can tell what the designer changed.
import { Batch, type Bounds, type DesignCraft, type Inspect, type InspectItem } from "../../designcraft.ts";
import { plan, type Rect, type Shape } from "./chart.ts";
import { type ChartSpec, loadRows, SpecError, validate } from "./spec.ts";

export type ChartItem = { key: string; id: number; kind: "text" | Shape["kind"]; bounds: Bounds; fill?: string; stroke?: string; text?: string };
export type ChartEntry = { chart: string; frame: number; page: number; spread: number; rect: Rect; group: number; spec: ChartSpec; items: ChartItem[]; drawn: string };
export type Check = { marks: number; misplaced: string[]; maxErrorPt: number; overset: string[]; outside: string[]; collisions: string[] };
export type HandChange = { key: string; change: string };

export const chartLabel = (chart: string, key?: string) => `firstlight:chart:${chart}${key ? `:${key}` : ""}`;
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const ref = Batch.ref;

// Top-level items and group children, children in their group's own coordinates.
function allItems(spread: { items: InspectItem[] }): InspectItem[] {
  return spread.items.flatMap((i) => [i, ...(i.children ?? [])]);
}

function findItem(ins: Inspect, id: number) {
  for (const sp of ins.spreads) {
    const item = allItems(sp).find((i) => i.id === id);
    if (item) {
      const page = sp.pages.find((p) => item.bounds[0] < p.bounds[2] && item.bounds[2] > p.bounds[0]) ?? sp.pages[0];
      return { item, spread: sp.index, page: page.index };
    }
  }
  return null;
}

export async function resolveFrame(dc: DesignCraft, ins: Inspect, frame: string | number) {
  let id = typeof frame === "number" ? frame : Number.isInteger(Number(frame)) ? Number(frame) : null;
  if (id == null) {
    const { ids } = await dc.execute<{ ids: number[] }>("object.findByLabel", { label: frame });
    if (ids.length !== 1) throw new SpecError(`${ids.length ? "several frames are" : "no frame is"} labelled "${frame}"`);
    id = ids[0];
  }
  const found = findItem(ins, id);
  if (!found) throw new SpecError(`no item ${id} in the document`);
  return { id, ...found, rect: found.item.bounds as Rect, layer: found.item.layer };
}

function shapeBounds(s: Shape): Bounds {
  if (s.kind === "line") return [Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]), Math.max(s.a[0], s.b[0]), Math.max(s.a[1], s.b[1])];
  if (s.kind === "path") { const xs = s.points.map((p) => p[0]), ys = s.points.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; }
  return s.rect;
}

export type DrawOptions = { chart: string; frame: { id: number; spread: number; page: number; rect: Rect; layer?: number }; spec: ChartSpec; root: string; readRoots: string[] };

export async function drawChart(dc: DesignCraft, o: DrawOptions): Promise<{ entry: ChartEntry; check: Check }> {
  validate(o.spec);
  const rows = loadRows(o.spec, o.root, o.readRoots);
  const p = plan(o.spec, rows, o.frame.rect);
  const [fx0, fy0, fx1] = o.frame.rect;
  const spread = o.frame.spread;

  // 1. Set every text in its Chart style, in frames that size themselves to it.
  const b1 = new Batch();
  if (o.frame.layer != null) b1.add("layer.activate", { id: o.frame.layer });
  const textStep = new Map<string, number>();
  for (const t of p.texts) {
    const s = b1.add("frame.create", { spread, rect: t.wrap ? [fx0, fy0, fx1, fy0 + 12] : [fx0, fy0, fx0 + 40, fy0 + 10], content: "text", text: t.text });
    textStep.set(t.key, s);
    if (t.wrap) b1.add("object.textFrameOptions", { inset: 0, autoSize: "heightOnly", ids: [ref(s, "id")] });
    else b1.add("style.object.apply", { name: "Chart/Label Frame", ids: [ref(s, "id")] });
    b1.add("text.select", { story: ref(s, "story"), anchor: 0, focus: bytes(t.text) });
    b1.add("style.paragraph.apply", { name: t.style, clearOverrides: true });
    if (t.charStyle) b1.add("style.character.apply", { name: t.charStyle });
  }
  const r1 = await dc.batch(b1.commands);
  const textId = new Map([...textStep].map(([k, s]) => [k, r1[s].id as number]));
  const storyOf = new Map([...textStep].map(([k, s]) => [k, r1[s].story as number]));

  // 2. Measure, lay out, move the texts into place and draw the marks.
  const ins1 = await dc.inspect();
  const boundsOf = (id: number) => findItem(ins1, id)!.item.bounds;
  const layout = p.layout((key) => {
    const b = boundsOf(textId.get(key)!);
    return { w: b[2] - b[0], h: b[3] - b[1] };
  });
  const b2 = new Batch();
  for (const t of layout.texts) {
    const id = textId.get(t.key)!, b = boundsOf(id);
    const dx = t.x - b[0], dy = t.y - b[1];
    if (Math.abs(dx) > 1e-3 || Math.abs(dy) > 1e-3) b2.add("transform.move", { ids: [id], dx, dy });
    b2.add("object.label", { label: chartLabel(o.chart, t.key), ids: [id] });
  }
  const shapeStep = new Map<string, number>();
  for (const s of layout.shapes) {
    const step = s.kind === "line" ? b2.add("line.create", { spread, a: s.a, b: s.b })
      : s.kind === "path" ? b2.add("path.create", { spread, anchors: s.points.map((pt) => ({ p: pt })), closed: false })
        : b2.add("frame.create", { spread, rect: s.rect, shape: s.kind === "ellipse" ? "ellipse" : "rectangle", content: "graphic" });
    shapeStep.set(s.key, step);
    b2.add("style.object.apply", { name: s.style, ids: [ref(step, "id")] });
    b2.add("object.label", { label: chartLabel(o.chart, s.key), ids: [ref(step, "id")] });
  }
  const r2 = await dc.batch(b2.commands);
  const shapeId = new Map([...shapeStep].map(([k, s]) => [k, r2[s].id as number]));

  // 3. Check what was drawn: marks where the layout put them, no overset text,
  //    nothing outside the frame, no labels on top of each other.
  const ins2 = await dc.inspect();
  const drawn = (id: number) => findItem(ins2, id)!.item;
  const check: Check = { marks: layout.shapes.length, misplaced: [], maxErrorPt: 0, overset: [], outside: [], collisions: [] };
  for (const s of layout.shapes) {
    const b = drawn(shapeId.get(s.key)!).bounds, want = shapeBounds(s);
    const err = Math.max(...b.map((v, i) => Math.abs(v - want[i])));
    check.maxErrorPt = Math.max(check.maxErrorPt, err);
    if (err > 0.25) check.misplaced.push(`${s.key} (${err.toFixed(2)} pt)`);
  }
  const ourStories = new Set(storyOf.values());
  for (const st of ins2.stories) if (ourStories.has(st.id) && st.overset) check.overset.push(st.preview);
  const [rx0, ry0, rx1, ry1] = o.frame.rect;
  const all = [...[...textId].map(([k, id]) => [k, drawn(id).bounds] as const), ...[...shapeId].map(([k, id]) => [k, drawn(id).bounds] as const)];
  for (const [k, b] of all) if (b[0] < rx0 - 0.5 || b[1] < ry0 - 0.5 || b[2] > rx1 + 0.5 || b[3] > ry1 + 0.5) check.outside.push(k);
  const textBoxes = [...textId].map(([k, id]) => [k, drawn(id).bounds] as const);
  for (let i = 0; i < textBoxes.length; i++) for (let j = i + 1; j < textBoxes.length; j++) {
    const [ka, a] = textBoxes[i], [kb, b] = textBoxes[j];
    const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    if (w > 0.5 && h > 0.5) check.collisions.push(`${ka} / ${kb}`);
  }

  // Record what was drawn, then bring the texts to the front and group the chart.
  const items: ChartItem[] = [
    ...[...textId].map(([key, id]) => ({ key, id, kind: "text" as const, bounds: drawn(id).bounds, text: p.texts.find((t) => t.key === key)!.text })),
    ...layout.shapes.map((s) => { const it = drawn(shapeId.get(s.key)!); return { key: s.key, id: it.id, kind: s.kind, bounds: it.bounds, fill: it.fill, stroke: it.stroke?.swatch }; }),
  ];
  const b3 = new Batch();
  b3.add("selection.set", { ids: [...textId.values()] });
  b3.add("object.bringToFront");
  const g = b3.add("object.group", { ids: [...shapeId.values(), ...textId.values()] });
  b3.add("object.label", { label: chartLabel(o.chart), ids: [ref(g, "id")] });
  b3.add("object.rename", { id: ref(g, "id"), name: `Chart ${o.chart}` });
  b3.add("selection.set", { ids: [] });
  const r3 = await dc.batch(b3.commands);

  const entry: ChartEntry = { chart: o.chart, frame: o.frame.id, page: o.frame.page, spread, rect: o.frame.rect, group: r3[g].id, spec: o.spec, items, drawn: new Date().toISOString() };
  return { entry, check };
}

// What the designer changed by hand since the chart was drawn. Children keep their
// group-local coordinates, so a move of the whole chart shows up only as `offset`.
export function handChanges(entry: ChartEntry, ins: Inspect): { changes: HandChange[]; offset: [number, number] } | null {
  const found = findItem(ins, entry.group);
  if (!found || !found.item.children) return null;
  const group = found.item, kids = group.children!;
  const union = kids.reduce<Bounds>((u, k) => [Math.min(u[0], k.bounds[0]), Math.min(u[1], k.bounds[1]), Math.max(u[2], k.bounds[2]), Math.max(u[3], k.bounds[3])], [Infinity, Infinity, -Infinity, -Infinity]);
  const offset: [number, number] = [group.bounds[0] - union[0], group.bounds[1] - union[1]];
  const stories = new Map(ins.stories.map((s) => [s.frames[0], s]));
  const changes: HandChange[] = [];
  for (const it of entry.items) {
    const cur = kids.find((k) => k.id === it.id);
    if (!cur) { changes.push({ key: it.key, change: "deleted" }); continue; }
    const moved = Math.max(...cur.bounds.map((v, i) => Math.abs(v - it.bounds[i])));
    if (moved > 0.5) changes.push({ key: it.key, change: `moved or resized (${moved.toFixed(1)} pt)` });
    if (it.kind !== "text" && (cur.fill !== it.fill || cur.stroke?.swatch !== it.stroke)) changes.push({ key: it.key, change: `recoloured (fill ${cur.fill}, stroke ${cur.stroke?.swatch})` });
    if (it.kind === "text") {
      const st = stories.get(it.id);
      if (st && it.text && !it.text.startsWith(st.preview.replace(/…$/, "")) && st.preview !== it.text) changes.push({ key: it.key, change: `text changed to "${st.preview}"` });
    }
  }
  for (const k of kids) if (!entry.items.some((it) => it.id === k.id)) changes.push({ key: `item ${k.id}`, change: "added inside the chart" });
  return { changes, offset };
}
