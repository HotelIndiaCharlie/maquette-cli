// The chart tool: draws a whole chart into a frame in one call, as ordinary DesignCraft items
// in the document's Chart styles, checks it against the data and returns a render; later it
// redraws the chart with new data or spec fields.
import { randomUUID } from "node:crypto";
import { chartLabel, drawChart, handChanges, prepareChart, resolveFrame } from "./draw.js";
import { SpecError } from "./spec.js";
const SPEC = `A Vega-Lite subset:
- data: {url: "example/data/file.csv"} (CSV with a header row, inside the folder Maquette runs in) or {values: [rows]}
- transform: [{fold: [fieldA, fieldB], as: [key, value]}] turns wide columns into one series each
- mark: "bar" | "line" | "point"
- encoding.x, encoding.y: {field, type: "quantitative"|"temporal"|"ordinal"|"nominal", title?, sort?: "ascending"|"descending"|"x"|"-x"|"y"|"-y"|[values], axis?: {format?, grid?, split?} | null, scale?: {zero?, domain?}}
  Bars: categorical x with quantitative y draws columns; quantitative x with categorical y draws horizontal bars. Bars start at zero; negative values hang below a zero line in Chart/Bar Negative. axis.split (e.g. "-") shows "2023-Q1" as "Q1", with "2023" once below its group.
- encoding.color: {field, legend?: null, scale?: {domain: [order]}} splits lines or points into at most two series
- title: "text" or {text, subtitle}
Print extensions:
- source: the source line under the chart
- highlight: [category values] drawn in Chart/Bar; the other bars in Chart/Bar Muted
- labels, one form per mark:
  bars: {"values": true, "format": ",.1f"} puts each value at its bar's end
  lines: {"ends": true} names each line at its end instead of a legend
  points: {"field": "farm", "top": 3, "by": "hectares"} names the 3 largest by hectares; or {"field": "farm", "include": ["Elmstead"]}
- names: {raw value: display name} for series, legend entries and categories
Axis titles appear only when given. Formats are d3-format (",.1f") and d3-time-format ("%b %Y"); negative numbers get a true minus sign.`;
function itemIds(ins) {
    const ids = new Set();
    const visit = (i) => { ids.add(i.id); i.children?.forEach(visit); };
    ins.spreads.forEach(s => s.items.forEach(visit));
    return ids;
}
const text = (t) => ({ type: "text", text: t });
function describe(check) {
    return [
        check.misplaced.length ? `${check.misplaced.length} of ${check.marks} marks are off the layout: ${check.misplaced.join(", ")}.` : `All ${check.marks} marks sit where the data puts them (largest difference ${check.maxErrorPt.toFixed(2)} pt).`,
        check.overset.length ? `Overset text: ${check.overset.join(" | ")}.` : "No overset text.",
        check.outside.length ? `Outside the frame: ${check.outside.join(", ")}.` : "Nothing outside the frame.",
        check.collisions.length ? `Overlapping labels: ${check.collisions.join("; ")}.` : "No overlapping labels.",
    ].join(" ");
}
const chart = ({ dc, root, readRoots }) => {
    // Charts drawn or loaded in this session, by chart id (the id of the frame they fill).
    const charts = new Map();
    async function render(entry, wanted) {
        if (wanted === false)
            return [];
        const r = await dc.call("render_page", { page: entry.page });
        if (r.isError)
            throw new SpecError("Page render failed.");
        return r.content.filter((c) => c.type === "image");
    }
    async function create(args) {
        const ins = await dc.inspect();
        const frame = await resolveFrame(dc, ins, String(args.frame));
        const chart = String(frame.id);
        const { ids } = await dc.execute("object.findByLabel", { label: chartLabel(chart) });
        if (ids.length)
            throw new SpecError(`frame ${args.frame} already holds chart ${chart}; change it with chart_update`);
        const { entry, check } = await drawChart(dc, { chart, frame, spec: args.spec, root, readRoots });
        const image = await render(entry, args.render);
        if (args.preview) {
            await dc.execute("edit.clear", { ids: [entry.group] });
            return { content: [text(`Preview of chart ${chart} for frame ${args.frame} on page ${entry.page + 1}; the chart has been removed again. ${describe(check)} Call chart_create without preview to place it.`), ...image] };
        }
        charts.set(chart, entry);
        return { content: [text(`Chart ${chart} placed in frame ${args.frame} on page ${entry.page + 1}: ${entry.items.length} items grouped as "Chart ${chart}" (label ${chartLabel(chart)}). ${describe(check)}`), ...image] };
    }
    async function update(args) {
        const ins = await dc.inspect();
        let entry = charts.get(String(args.chart));
        if (!entry) {
            const f = await resolveFrame(dc, ins, String(args.chart));
            entry = charts.get(String(f.id));
        }
        if (!entry)
            throw new SpecError(`no chart ${args.chart} in this session; chart_list shows the charts there are`);
        const found = handChanges(entry, ins);
        if (!found)
            throw new SpecError(`chart ${entry.chart}'s group is no longer in the document`);
        const spec = { ...entry.spec, ...(args.spec ?? {}), ...(args.data ? { data: args.data } : {}) };
        if (found.changes.length)
            throw new SpecError(`Chart ${entry.chart} was not changed. Internal hand changes cannot be preserved yet (HOT-66): ${found.changes.map(c => `${c.key}: ${c.change}`).join("; ")}. Keep the original and review these changes before updating.`);
        const [dx, dy] = found.offset;
        const group = ins.spreads[entry.spread].items.find(i => i.id === entry.group);
        const rect = [entry.rect[0] + dx, entry.rect[1] + dy, entry.rect[2] + dx, entry.rect[3] + dy];
        const prepared = prepareChart(spec, root, readRoots, rect);
        const before = itemIds(ins);
        let candidate;
        let check;
        let committing = false;
        try {
            const drawn = await drawChart(dc, { chart: entry.chart, labelChart: `${entry.chart}:pending:${randomUUID()}`, frame: { id: entry.frame, spread: entry.spread, page: entry.page, rect, layer: group?.layer }, spec: prepared.spec, prepared, root, readRoots });
            candidate = drawn.entry;
            check = drawn.check;
            // batch is sequential, not atomic. The original is the very last effect removed.
            const labels = candidate.items.map(i => ({ command: "object.label", params: { ids: [i.id], label: chartLabel(entry.chart, i.key) } }));
            committing = true;
            await dc.batch([...labels, { command: "object.label", params: { ids: [candidate.group], label: chartLabel(entry.chart) } }, { command: "edit.clear", params: { ids: [entry.group] } }]);
        }
        catch (e) {
            let current;
            try {
                current = await dc.inspect();
            }
            catch {
                throw new SpecError(`Chart update outcome is uncertain; the engine could not be inspected. Do not retry automatically. Inspect the original and any pending group before continuing.`);
            }
            const currentIds = itemIds(current);
            if (!currentIds.has(entry.group)) {
                if (candidate && currentIds.has(candidate.group))
                    charts.set(entry.chart, candidate);
                throw new SpecError(`Chart replacement outcome is uncertain: original group ${entry.group} is absent${candidate ? `; candidate group ${candidate.group}` : ""}. No call was retried. Inspect current state before continuing.`);
            }
            // All calls are in the runtime FIFO; only newly created top-level roots belong to this attempt.
            const added = current.spreads.flatMap(s => s.items.filter(i => !before.has(i.id)).map(i => i.id));
            try {
                if (added.length)
                    await dc.execute("edit.clear", { ids: added });
            }
            catch {
                throw new SpecError(`Original chart ${entry.chart} was kept; cleanup of candidate items ${added.join(", ")} failed. Inspect these items before retrying.`);
            }
            throw new SpecError(`Original chart ${entry.chart} was kept; ${committing ? "replacement" : "drawing"} failed: ${e.message}`);
        }
        charts.set(entry.chart, candidate);
        const moved = Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 ? ` The chart had been moved by ${dx.toFixed(1)}, ${dy.toFixed(1)} pt; it was redrawn there.` : "";
        let images = [];
        let previewWarning = "";
        try {
            images = await render(candidate, args.render);
        }
        catch {
            previewWarning = " Chart updated; preview unavailable. Inspect or render the page before further edits.";
        }
        return { content: [text(`Chart ${entry.chart} redrawn on page ${candidate.page + 1}.${moved} No hand changes inside the chart. ${describe(check)}${previewWarning}`), ...images] };
    }
    return {
        name: "chart",
        instructions: "To make a chart, call chart_create once with the target frame and a spec; it draws the whole chart in the document's Chart styles, checks it against the data and returns a render. To change a chart's data or spec later, call chart_update. With a designer, propose before placing: call chart_create with preview: true, show the render, and place the chart once they agree.",
        tools: [
            {
                name: "chart_create",
                description: `Draw a whole chart into a frame of the open document in one call: ordinary DesignCraft items in the document's Chart paragraph, character and object styles, grouped and labelled. It then checks the drawing (marks where the data puts them, no overset text, nothing outside the frame, no overlapping labels) and returns a render of the page. Use this instead of building charts from DesignCraft commands.\n\nspec: ${SPEC}`,
                inputSchema: {
                    type: "object",
                    properties: {
                        frame: { type: "string", description: 'The frame the chart fills: its label (e.g. "firstlight:slot:01") or its id' },
                        spec: { type: "object", description: "The chart spec (see the tool description)" },
                        preview: { type: "boolean", description: "Draw, check and render, then remove the chart again: a proposal to show before placing it" },
                        render: { type: "boolean", description: "Return a render of the page (default true)" },
                    },
                    required: ["frame", "spec"],
                },
            },
            {
                name: "chart_update",
                description: "Redraw a chart made with chart_create in place, with new data or a changed spec. It refuses to redraw when internal hand changes are detected, preserving the original until HOT-66 implements keeping them. Invalid input or a failed candidate leaves the original in place. A move of the whole chart is kept.",
                inputSchema: {
                    type: "object",
                    properties: {
                        chart: { type: "string", description: "The chart id from chart_create, or the label or id of its frame" },
                        data: { type: "object", description: "New data: {url} or {values}" },
                        spec: { type: "object", description: "Spec fields to replace (top-level keys)" },
                        render: { type: "boolean", description: "Return a render of the page (default true)" },
                    },
                    required: ["chart"],
                },
            },
            { name: "chart_list", description: "The charts drawn or loaded in this session, with their frames and specs.", inputSchema: { type: "object", properties: {} } },
        ],
        async call(name, args) {
            if (name === "chart_create")
                return create(args);
            if (name === "chart_update")
                return update(args);
            return { content: [text(JSON.stringify([...charts.values()].map(({ chart, frame, page, spec }) => ({ chart, frame, page: page + 1, spec })), null, 2))] };
        },
        saved: () => (charts.size ? { charts: [...charts.values()] } : undefined),
        opened(state) {
            charts.clear();
            for (const e of state?.charts ?? [])
                charts.set(e.chart, e);
        },
    };
};
export default chart;
