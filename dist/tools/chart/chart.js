// Chart planning and layout. A plan lists every text the chart needs, so DesignCraft
// can set and measure it; the layout then places marks and texts using those sizes.
// Scales, ticks and number formats come from the d3 modules Vega itself is built on.
import { scaleBand, scaleLinear, scalePoint, scaleUtc } from "d3-scale";
import { format as d3format, precisionFixed } from "d3-format";
import { utcFormat } from "d3-time-format";
import { utcMonth, utcYear } from "d3-time";
import { markOf, SpecError } from "./spec.js";
const GAP = { title: 2, header: 10, legend: 7, legendItem: 12, legendKey: 3, axisTitle: 4, tickLabel: 4, yLabel: 6, value: 2.5, source: 10, end: 5, point: 3, group: 2 };
const TICK = 3;
const DOT = 5.5;
const MAX_SERIES = 2;
const keyOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
const decimals = (vals) => Math.max(0, ...vals.map((v) => { const s = String(v); const i = s.indexOf("."); return i < 0 ? 0 : s.length - i - 1; }));
const max = (v) => Math.max(0, ...v);
const overlaps = (a, b, pad = 0.5) => a[0] < b[2] + pad && b[0] < a[2] + pad && a[1] < b[3] + pad && b[1] < a[3] + pad;
function linear(values, count, zero, domain) {
    let lo = domain ? Number(domain[0]) : Math.min(...values);
    let hi = domain ? Number(domain[1]) : Math.max(...values);
    if (zero) {
        lo = Math.min(0, lo);
        hi = Math.max(0, hi);
    }
    if (lo === hi)
        hi = lo + 1;
    const s = scaleLinear().domain([lo, hi]);
    if (!domain)
        s.nice(count);
    const ticks = s.ticks(count);
    return { domain: s.domain(), ticks };
}
function numberFormat(ticks, spec) {
    if (spec)
        return d3format(spec);
    const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 1;
    return d3format(`,.${precisionFixed(step)}f`);
}
// Categories in the order the channel's sort asks for (Vega-Lite's default: ascending).
function categories(rows, cat, val, valueChannel) {
    const seen = [...new Set(rows.map((r) => keyOf(r[cat.field])))];
    const value = (c) => rows.find((r) => keyOf(r[cat.field]) === c)[val.field];
    const s = cat.sort;
    if (Array.isArray(s)) {
        const order = s.map(String);
        return [...order.filter((c) => seen.includes(c)), ...seen.filter((c) => !order.includes(c))];
    }
    if (s === null)
        return seen;
    if (s === `-${valueChannel}`)
        return [...seen].sort((a, b) => value(b) - value(a));
    if (s === valueChannel)
        return [...seen].sort((a, b) => value(a) - value(b));
    const asc = [...seen].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    return s === "descending" ? asc.reverse() : asc;
}
// Title, subtitle and source above and below every chart, and the axis titles when given.
function frameTexts(spec) {
    const t = [];
    const title = typeof spec.title === "string" ? { text: spec.title } : spec.title;
    if (title?.text)
        t.push({ key: "title", text: title.text, style: "Chart/Title", wrap: true });
    if (title?.subtitle)
        t.push({ key: "subtitle", text: title.subtitle, style: "Chart/Subtitle", wrap: true });
    if (spec.source)
        t.push({ key: "source", text: spec.source, style: "Chart/Source", wrap: true });
    for (const ch of ["x", "y"]) {
        const c = spec.encoding[ch];
        const title = c.title ?? c.axis?.title;
        if (title)
            t.push({ key: `${ch}-title`, text: title, style: "Chart/Axis Title" });
    }
    return t;
}
// Places title, subtitle, legend and y-axis title from the top, and source and x-axis
// title from the bottom; returns the space left for the plot and axis labels.
function frameLayout(F, texts, size, place, shapes, legend) {
    const has = (k) => texts.some((t) => t.key === k);
    let top = F.y0;
    for (const k of ["title", "subtitle"]) {
        if (!has(k))
            continue;
        place.push({ key: k, x: F.x0, y: top });
        top += size(k).h + (k === "title" ? GAP.title : 0);
    }
    if (has("title") || has("subtitle"))
        top += GAP.header;
    if (legend?.length) {
        const h = max(legend.map((_, i) => size(`legend:${i}`).h));
        const widths = legend.map((_, i) => DOT + GAP.legendKey + size(`legend:${i}`).w);
        let x = F.x1 - widths.reduce((a, b) => a + b, 0) - GAP.legendItem * (legend.length - 1);
        legend.forEach((item, i) => {
            const cy = top + h / 2;
            shapes.push(item.key === "path"
                ? { kind: "line", key: `legend-key:${i}`, a: [x - 3, cy], b: [x + DOT + 3, cy], style: item.style }
                : { kind: item.key, key: `legend-key:${i}`, rect: [x, cy - DOT / 2, x + DOT, cy + DOT / 2], style: item.style });
            place.push({ key: `legend:${i}`, x: x + DOT + GAP.legendKey, y: cy - size(`legend:${i}`).h / 2 });
            x += widths[i] + GAP.legendItem;
        });
        top += h + GAP.legend;
    }
    if (has("y-title")) {
        place.push({ key: "y-title", x: F.x0, y: top });
        top += size("y-title").h + GAP.axisTitle;
    }
    let bottom = F.y1;
    if (has("source")) {
        bottom -= size("source").h;
        place.push({ key: "source", x: F.x0, y: bottom });
        bottom -= GAP.source;
    }
    let xTitleY = null;
    if (has("x-title")) {
        bottom -= size("x-title").h;
        xTitleY = bottom;
        bottom -= GAP.axisTitle;
    }
    return { top, bottom, placeXTitle: (plotL, plotR) => { if (xTitleY != null)
            place.push({ key: "x-title", x: (plotL + plotR) / 2 - size("x-title").w / 2, y: xTitleY }); } };
}
function planBars(spec, rows, F) {
    const { x, y } = spec.encoding;
    const horizontal = x.type === "quantitative" && y.type !== "quantitative";
    if (!horizontal && (y.type !== "quantitative" || x.type === "quantitative"))
        throw new SpecError("bars need one quantitative and one categorical axis (ordinal, nominal or temporal)");
    if (spec.encoding.color)
        throw new SpecError("bars coloured by a field (grouped or stacked) aren't supported yet; use highlight to pick out categories");
    const cat = horizontal ? y : x, val = horizontal ? x : y;
    const cats = categories(rows, cat, val, horizontal ? "x" : "y");
    const value = new Map();
    for (const r of rows) {
        const k = keyOf(r[cat.field]);
        if (value.has(k))
            throw new SpecError(`two rows for "${k}": bars need one row per category`);
        value.set(k, r[val.field]);
    }
    const vals = cats.map((c) => value.get(c));
    const lin = linear(vals, Math.max(3, Math.round((horizontal ? F.w : F.h) / 60)), true, val.scale?.domain);
    const showAxis = horizontal ? val.axis !== null && (val.axis !== undefined || !spec.labels?.values) : val.axis !== null;
    const grid = showAxis && val.axis?.grid !== false;
    const tickFmt = numberFormat(lin.ticks, val.axis?.format);
    const valueFmt = d3format(spec.labels?.format ?? `,.${decimals(vals)}f`);
    const split = cat.axis?.split;
    const name = (c) => spec.names?.[c] ?? c;
    const label = (c) => (split && c.includes(split) ? c.slice(c.indexOf(split) + split.length) : name(c));
    const groupOf = (c) => (split && c.includes(split) ? c.slice(0, c.indexOf(split)) : null);
    const groups = [...new Set(cats.map(groupOf).filter((g) => g != null))];
    const highlight = spec.highlight?.map((h) => keyOf(h));
    if (highlight)
        for (const h of highlight)
            if (!value.has(h))
                throw new SpecError(`highlight: no category "${h}"`);
    const texts = frameTexts(spec);
    if (showAxis)
        lin.ticks.forEach((t) => texts.push({ key: `tick:${t}`, text: tickFmt(t), style: "Chart/Tick Label" }));
    cats.forEach((c) => texts.push({ key: `cat:${c}`, text: label(c), style: "Chart/Category Label" }));
    groups.forEach((g) => texts.push({ key: `group:${g}`, text: name(g), style: "Chart/Category Label" }));
    if (spec.labels?.values)
        cats.forEach((c) => texts.push({ key: `value:${c}`, text: valueFmt(value.get(c)), style: "Chart/Value Label", charStyle: value.get(c) < 0 ? "Chart/Negative" : undefined }));
    const barStyle = (c) => (value.get(c) < 0 ? "Chart/Bar Negative" : highlight && !highlight.includes(c) ? "Chart/Bar Muted" : "Chart/Bar");
    return {
        kind: horizontal ? "bar" : "column",
        texts,
        layout: (size) => {
            const place = [], shapes = [];
            const { top, bottom, placeXTitle } = frameLayout(F, texts, size, place, shapes);
            const tickW = showAxis ? max(lin.ticks.map((t) => size(`tick:${t}`).w)) : 0;
            const tickH = showAxis ? max(lin.ticks.map((t) => size(`tick:${t}`).h)) : 0;
            const valueW = spec.labels?.values ? max(cats.map((c) => size(`value:${c}`).w)) : 0;
            const valueH = spec.labels?.values ? max(cats.map((c) => size(`value:${c}`).h)) : 0;
            let plot;
            if (!horizontal) {
                const catH = max(cats.map((c) => size(`cat:${c}`).h));
                const groupH = groups.length ? max(groups.map((g) => size(`group:${g}`).h)) + GAP.group : 0;
                plot = [F.x0 + (showAxis ? tickW + GAP.yLabel : 0), top + Math.max(valueH + GAP.value, tickH / 2), F.x1, bottom - catH - GAP.tickLabel - groupH];
                const [pl, pt, pr, pb] = plot;
                const xs = scaleBand().domain(cats).range([pl, pr]).paddingInner(0.3).paddingOuter(0.15);
                // A label under the lowest negative bar needs room above the category labels:
                // extend the scale below it just enough (the ticks stay where they are).
                const domain = [...lin.domain];
                const vmin = Math.min(...vals);
                if (spec.labels?.values && vmin < 0 && !val.scale?.domain) {
                    const room = valueH + GAP.value + 1, H = pb - pt;
                    domain[0] = Math.min(domain[0], vmin - (room * (domain[1] - vmin)) / (H - room));
                }
                const ys = scaleLinear().domain(domain).range([pb, pt]);
                if (grid)
                    lin.ticks.filter((t) => t !== 0).forEach((t) => shapes.push({ kind: "line", key: `grid:${t}`, a: [pl, ys(t)], b: [pr, ys(t)], style: "Chart/Gridline" }));
                shapes.push({ kind: "line", key: "axis", a: [pl, ys(0)], b: [pr, ys(0)], style: "Chart/Axis" });
                for (const c of cats) {
                    const v = value.get(c), bx = xs(c), bw = xs.bandwidth(), cx = bx + bw / 2;
                    shapes.push({ kind: "rect", key: `bar:${c}`, rect: [bx, Math.min(ys(v), ys(0)), bx + bw, Math.max(ys(v), ys(0))], style: barStyle(c) });
                    place.push({ key: `cat:${c}`, x: cx - size(`cat:${c}`).w / 2, y: pb + GAP.tickLabel });
                    if (spec.labels?.values) {
                        const s = size(`value:${c}`);
                        place.push({ key: `value:${c}`, x: cx - s.w / 2, y: v >= 0 ? ys(v) - GAP.value - s.h : ys(v) + GAP.value });
                    }
                }
                for (const g of groups) {
                    const members = cats.filter((c) => groupOf(c) === g);
                    const g0 = xs(members[0]), g1 = xs(members[members.length - 1]) + xs.bandwidth();
                    place.push({ key: `group:${g}`, x: (g0 + g1) / 2 - size(`group:${g}`).w / 2, y: pb + GAP.tickLabel + max(cats.map((c) => size(`cat:${c}`).h)) + GAP.group });
                }
                if (showAxis)
                    lin.ticks.forEach((t) => place.push({ key: `tick:${t}`, x: pl - GAP.yLabel - size(`tick:${t}`).w, y: ys(t) - size(`tick:${t}`).h / 2 }));
            }
            else {
                const catW = max(cats.map((c) => size(`cat:${c}`).w));
                plot = [F.x0 + catW + 8, top, F.x1 - (valueW ? valueW + GAP.value + 1 : 0), bottom - (showAxis ? tickH + GAP.tickLabel : 0)];
                const [pl, pt, pr, pb] = plot;
                const ys = scaleBand().domain(cats).range([pt, pb]).paddingInner(0.35).paddingOuter(0.1);
                const xs = scaleLinear().domain(lin.domain).range([pl, pr]);
                if (grid)
                    lin.ticks.filter((t) => t !== 0).forEach((t) => shapes.push({ kind: "line", key: `grid:${t}`, a: [xs(t), pt], b: [xs(t), pb], style: "Chart/Gridline" }));
                shapes.push({ kind: "line", key: "axis", a: [xs(0), pt], b: [xs(0), pb], style: "Chart/Axis" });
                for (const c of cats) {
                    const v = value.get(c), by = ys(c), bh = ys.bandwidth(), cy = by + bh / 2;
                    shapes.push({ kind: "rect", key: `bar:${c}`, rect: [Math.min(xs(0), xs(v)), by, Math.max(xs(0), xs(v)), by + bh], style: barStyle(c) });
                    place.push({ key: `cat:${c}`, x: F.x0, y: cy - size(`cat:${c}`).h / 2 });
                    if (spec.labels?.values) {
                        const s = size(`value:${c}`);
                        place.push({ key: `value:${c}`, x: v >= 0 ? xs(v) + GAP.value : xs(v) - GAP.value - s.w, y: cy - s.h / 2 });
                    }
                }
                if (showAxis)
                    lin.ticks.forEach((t) => place.push({ key: `tick:${t}`, x: xs(t) - size(`tick:${t}`).w / 2, y: pb + GAP.tickLabel }));
            }
            placeXTitle(plot[0], plot[2]);
            return { shapes, texts: place, plot };
        },
    };
}
// Series for lines and points: one per colour value (at most two), in the colour
// scale's domain order or first appearance.
function seriesOf(spec, rows) {
    const color = spec.encoding.color;
    if (!color)
        return [{ key: spec.encoding.y.field, rows }];
    const seen = [...new Set(rows.map((r) => keyOf(r[color.field])))];
    const order = color.scale?.domain ? color.scale.domain.map(String) : seen;
    const series = order.filter((k) => seen.includes(k)).map((k) => ({ key: k, rows: rows.filter((r) => keyOf(r[color.field]) === k) }));
    if (series.length > MAX_SERIES)
        throw new SpecError(`${series.length} series; the document's Chart styles cover ${MAX_SERIES}`);
    return series;
}
// The x axis of lines and points: time, numbers or categories.
function xAxis(spec, rows, F) {
    const x = spec.encoding.x;
    const vals = rows.map((r) => r[x.field]);
    if (x.type === "temporal") {
        const times = vals.map((d) => d.getTime());
        const d0 = new Date(Math.min(...times)), d1 = new Date(Math.max(...times));
        const months = (d1.getUTCFullYear() - d0.getUTCFullYear()) * 12 + d1.getUTCMonth() - d0.getUTCMonth();
        const target = Math.max(3, Math.round(F.w / 100));
        const step = [1, 2, 3, 6, 12, 24, 60].find((k) => months / k <= target) ?? 120;
        const interval = step >= 12 ? utcYear.every(step / 12) : utcMonth.every(step);
        const ticks = interval.range(d0, new Date(d1.getTime() + 1));
        const fmt = utcFormat(x.axis?.format ?? (step >= 12 ? "%Y" : "%b %Y"));
        return { kind: "time", domain: [d0, d1], ticks, text: (t) => fmt(t) };
    }
    if (x.type === "quantitative") {
        const lin = linear(vals, Math.max(3, Math.round(F.w / 80)), x.scale?.zero ?? false, x.scale?.domain);
        const fmt = numberFormat(lin.ticks, x.axis?.format);
        return { kind: "linear", domain: lin.domain, ticks: lin.ticks, text: (t) => fmt(t) };
    }
    const cats = [...new Set(vals.map(keyOf))];
    const every = Math.ceil(cats.length / 12);
    return { kind: "point", domain: cats, ticks: cats.filter((_, i) => i % every === 0), text: (t) => spec.names?.[String(t)] ?? String(t) };
}
function planXY(spec, rows, F, mark) {
    const { x, y } = spec.encoding;
    if (y.type !== "quantitative")
        throw new SpecError(`${mark}s need a quantitative y`);
    if (mark === "point" && x.type !== "quantitative")
        throw new SpecError("points need a quantitative x and y");
    const series = seriesOf(spec, rows);
    const name = (k) => spec.names?.[k] ?? k;
    const xa = xAxis(spec, rows, F);
    const yl = linear(rows.map((r) => r[y.field]), Math.max(3, Math.round(F.h / 60)), y.scale?.zero ?? false, y.scale?.domain);
    const yFmt = numberFormat(yl.ticks, y.axis?.format);
    const style = (kind, i) => `Chart/${kind} Series ${i + 1}`;
    const ends = mark === "line" && !!spec.labels?.ends;
    const showLegend = !!spec.encoding.color && spec.encoding.color.legend !== null && !ends && series.length > 1;
    const legend = showLegend ? series.map((s, i) => ({ name: name(s.key), key: mark === "line" ? "path" : "ellipse", style: style(mark === "line" ? "Line" : "Point", i) })) : undefined;
    let named = [];
    if (mark === "point" && spec.labels?.field) {
        const lf = spec.labels.field;
        if (!(lf in rows[0]))
            throw new SpecError(`labels.field: no field "${lf}"`);
        if (spec.labels.include)
            named = rows.filter((r) => spec.labels.include.map(String).includes(String(r[lf])));
        else if (spec.labels.top) {
            const by = spec.labels.by ?? x.field;
            named = [...rows].sort((a, b) => Number(b[by]) - Number(a[by])).slice(0, spec.labels.top);
        }
        else
            named = rows;
    }
    const texts = frameTexts(spec);
    yl.ticks.forEach((t) => texts.push({ key: `ytick:${t}`, text: yFmt(t), style: "Chart/Tick Label" }));
    xa.ticks.forEach((t) => texts.push({ key: `xtick:${keyOf(t)}`, text: xa.text(t), style: "Chart/Tick Label" }));
    if (ends)
        series.forEach((s, i) => texts.push({ key: `end:${s.key}`, text: name(s.key), style: "Chart/Direct Label", charStyle: `Chart/Series ${i + 1}` }));
    legend?.forEach((l, i) => texts.push({ key: `legend:${i}`, text: l.name, style: "Chart/Legend Label" }));
    named.forEach((r) => texts.push({ key: `label:${keyOf(r[spec.labels.field])}`, text: String(r[spec.labels.field]), style: "Chart/Direct Label" }));
    return {
        kind: mark,
        texts,
        layout: (size) => {
            const place = [], shapes = [];
            const { top, bottom, placeXTitle } = frameLayout(F, texts, size, place, shapes, legend);
            const yTickW = max(yl.ticks.map((t) => size(`ytick:${t}`).w));
            const yTickH = max(yl.ticks.map((t) => size(`ytick:${t}`).h));
            const xTickH = max(xa.ticks.map((t) => size(`xtick:${keyOf(t)}`).h));
            const lastHalf = xa.ticks.length ? size(`xtick:${keyOf(xa.ticks[xa.ticks.length - 1])}`).w / 2 : 0;
            const endW = ends ? max(series.map((s) => size(`end:${s.key}`).w)) + GAP.end : 0;
            const plot = [F.x0 + yTickW + GAP.yLabel, top + yTickH / 2, F.x1 - Math.max(endW, lastHalf), bottom - xTickH - TICK - 2];
            const [pl, pt, pr, pb] = plot;
            const ys = scaleLinear().domain(yl.domain).range([pb, pt]);
            const xpos = xa.kind === "time"
                ? ((s) => (v) => s(v))(scaleUtc().domain(xa.domain).range([pl, pr]))
                : xa.kind === "linear"
                    ? ((s) => (v) => s(v))(scaleLinear().domain(xa.domain).range([pl, pr]))
                    : ((s) => (v) => s(keyOf(v)))(scalePoint().domain(xa.domain).range([pl, pr]));
            if (y.axis?.grid !== false)
                yl.ticks.filter((t) => Math.abs(ys(t) - pb) > 0.5).forEach((t) => shapes.push({ kind: "line", key: `grid:${t}`, a: [pl, ys(t)], b: [pr, ys(t)], style: "Chart/Gridline" }));
            shapes.push({ kind: "line", key: "axis", a: [pl, pb], b: [pr, pb], style: "Chart/Axis" });
            for (const t of xa.ticks) {
                const tx = xpos(t), s = size(`xtick:${keyOf(t)}`);
                shapes.push({ kind: "line", key: `tick:${keyOf(t)}`, a: [tx, pb], b: [tx, pb + TICK], style: "Chart/Tick" });
                place.push({ key: `xtick:${keyOf(t)}`, x: Math.min(Math.max(tx - s.w / 2, F.x0), F.x1 - s.w), y: pb + TICK + 2 });
            }
            yl.ticks.forEach((t) => place.push({ key: `ytick:${t}`, x: pl - GAP.yLabel - size(`ytick:${t}`).w, y: ys(t) - size(`ytick:${t}`).h / 2 }));
            if (mark === "line") {
                const lasts = [];
                series.forEach((s, i) => {
                    const pts = [...s.rows].sort((a, b) => xpos(a[x.field]) - xpos(b[x.field])).map((r) => [xpos(r[x.field]), ys(r[y.field])]);
                    shapes.push({ kind: "path", key: `line:${s.key}`, points: pts, style: style("Line", i) });
                    if (ends)
                        lasts.push({ key: s.key, y: pts[pts.length - 1][1], h: size(`end:${s.key}`).h });
                });
                // End labels sit level with their line's last point, pushed apart where they would touch.
                lasts.sort((a, b) => a.y - b.y);
                const tops = lasts.map((l) => l.y - l.h / 2);
                for (let i = 1; i < tops.length; i++)
                    tops[i] = Math.max(tops[i], tops[i - 1] + lasts[i - 1].h + 1);
                const shift = Math.max(0, tops.length ? tops[tops.length - 1] + lasts[lasts.length - 1].h - pb : 0);
                lasts.forEach((l, i) => place.push({ key: `end:${l.key}`, x: pr + GAP.end, y: tops[i] - shift }));
            }
            else {
                const dots = [];
                series.forEach((s, i) => s.rows.forEach((r) => {
                    const cx = xpos(r[x.field]), cy = ys(r[y.field]);
                    const rect = [cx - DOT / 2, cy - DOT / 2, cx + DOT / 2, cy + DOT / 2];
                    dots.push(rect);
                    const id = spec.labels?.field ? keyOf(r[spec.labels.field]) : `${keyOf(r[x.field])},${keyOf(r[y.field])}`;
                    shapes.push({ kind: "ellipse", key: `point:${id}`, rect, style: style("Point", i) });
                }));
                // Name labels go right of their dot, else left, above or below, wherever nothing else is.
                const taken = [];
                for (const r of named) {
                    const k = `label:${keyOf(r[spec.labels.field])}`, s = size(k);
                    const cx = xpos(r[x.field]), cy = ys(r[y.field]), d = DOT / 2 + GAP.point;
                    const tries = [[cx + d, cy - s.h / 2], [cx - d - s.w, cy - s.h / 2], [cx - s.w / 2, cy - d - s.h], [cx - s.w / 2, cy + d]];
                    const own = [cx - DOT / 2, cy - DOT / 2, cx + DOT / 2, cy + DOT / 2];
                    const fits = ([lx, ly]) => {
                        const box = [lx, ly, lx + s.w, ly + s.h];
                        return box[0] >= pl && box[2] <= F.x1 && box[1] >= pt - yTickH && box[3] <= pb
                            && !dots.some((dt) => dt !== own && overlaps(box, dt) && !(dt[0] === own[0] && dt[1] === own[1]))
                            && !taken.some((t) => overlaps(box, t));
                    };
                    const [lx, ly] = tries.find(fits) ?? tries[0];
                    taken.push([lx, ly, lx + s.w, ly + s.h]);
                    place.push({ key: k, x: lx, y: ly });
                }
            }
            placeXTitle(pl, pr);
            return { shapes, texts: place, plot };
        },
    };
}
export function plan(spec, rows, rect) {
    if (!rows.length)
        throw new SpecError("the data has no rows");
    const F = { x0: rect[0], y0: rect[1], x1: rect[2], y1: rect[3], w: rect[2] - rect[0], h: rect[3] - rect[1] };
    const mark = markOf(spec);
    return mark === "bar" ? planBars(spec, rows, F) : planXY(spec, rows, F, mark);
}
