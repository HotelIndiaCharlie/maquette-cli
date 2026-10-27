// The chart spec: a Vega-Lite subset plus a few print extensions, and loading its data.
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
export class SpecError extends Error {
}
const types = new Set(["quantitative", "temporal", "ordinal", "nominal"]);
export function markOf(spec) {
    const mark = typeof spec.mark === "string" ? spec.mark : spec.mark?.type;
    if (mark !== "bar" && mark !== "line" && mark !== "point")
        throw new SpecError(`mark must be "bar", "line" or "point", not ${JSON.stringify(spec.mark)}`);
    return mark;
}
// Unknown keys are errors, not silently ignored: an agent that guesses a shape must hear
// so. Vega-Lite keys that don't change a print chart are accepted and ignored.
const KEYS = {
    spec: ["data", "transform", "mark", "encoding", "title", "source", "highlight", "labels", "names", "$schema", "description", "width", "height", "autosize", "config", "padding", "background"],
    encoding: ["x", "y", "color"],
    channel: ["field", "type", "title", "sort", "axis", "scale", "legend"],
    axis: ["title", "format", "grid", "split"],
    labels: ["values", "format", "ends", "field", "top", "by", "include"],
};
function onlyKeys(obj, allowed, where) {
    if (!obj || typeof obj !== "object")
        return;
    const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
    if (extra.length)
        throw new SpecError(`${where}: unknown key${extra.length > 1 ? "s" : ""} ${extra.map((k) => `"${k}"`).join(", ")}; allowed: ${allowed.filter((k) => !k.startsWith("$")).join(", ")}`);
}
export function validate(spec) {
    if (!spec || typeof spec !== "object")
        throw new SpecError("spec must be an object");
    onlyKeys(spec, KEYS.spec, "spec");
    onlyKeys(spec.encoding, KEYS.encoding, "encoding");
    for (const ch of ["x", "y", "color"]) {
        onlyKeys(spec.encoding?.[ch], KEYS.channel, `encoding.${ch}`);
        if (spec.encoding?.[ch]?.axis)
            onlyKeys(spec.encoding[ch].axis, KEYS.axis, `encoding.${ch}.axis`);
    }
    onlyKeys(spec.labels, KEYS.labels, 'labels (bars: {"values": true}; lines: {"ends": true}; points: {"field": "name", "top": 3, "by": "size"})');
    markOf(spec);
    if (!spec.data?.url && !Array.isArray(spec.data?.values))
        throw new SpecError("data needs a url (a CSV file) or values (an array of rows)");
    for (const ch of ["x", "y"]) {
        const c = spec.encoding?.[ch];
        if (!c?.field)
            throw new SpecError(`encoding.${ch}.field is required`);
        if (!types.has(c.type))
            throw new SpecError(`encoding.${ch}.type must be quantitative, temporal, ordinal or nominal`);
    }
    const mark = markOf(spec), l = spec.labels;
    if (l && (l.top != null || l.by != null || l.include != null) && !l.field)
        throw new SpecError("labels: name points with labels.field (the field holding the names)");
    if (l?.field && mark !== "point")
        throw new SpecError("labels.field names points; bars take labels.values, lines labels.ends");
    if (l?.ends && mark !== "line")
        throw new SpecError("labels.ends names lines at their ends; bars take labels.values");
    if (l?.values && mark !== "bar")
        throw new SpecError("labels.values labels bars; lines take labels.ends, points labels.field");
    for (const t of spec.transform ?? []) {
        if (!Array.isArray(t.fold))
            throw new SpecError("the only transform supported is fold: {fold: [fields], as: [key, value]}");
    }
}
// CSV with a header row; quoted fields may contain commas and doubled quotes.
function parseCsv(text) {
    const records = [];
    let field = "", record = [], quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"' && text[i + 1] === '"') {
                field += '"';
                i++;
            }
            else if (ch === '"')
                quoted = false;
            else
                field += ch;
        }
        else if (ch === '"')
            quoted = true;
        else if (ch === ",") {
            record.push(field);
            field = "";
        }
        else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && text[i + 1] === "\n")
                i++;
            record.push(field);
            field = "";
            if (record.some((f) => f !== ""))
                records.push(record);
            record = [];
        }
        else
            field += ch;
    }
    record.push(field);
    if (record.some((f) => f !== ""))
        records.push(record);
    const [head, ...rows] = records;
    return rows.map((r) => Object.fromEntries(head.map((k, i) => [k.trim(), (r[i] ?? "").trim()])));
}
// Data files must sit inside the folders DesignCraft may read.
function readData(url, root, readRoots) {
    const path = realpathSync(isAbsolute(url) ? url : join(root, url));
    const inside = readRoots.some((r) => { const rel = relative(realpathSync(r), path); return !rel.startsWith("..") && !isAbsolute(rel); });
    if (!inside)
        throw new SpecError(`data.url must be inside ${readRoots.map((r) => relative(root, r) ? `${relative(root, r)}/` : "the folder Maquette runs in").join(" or ")}`);
    return readFileSync(path, "utf8");
}
export function parseValue(v, type) {
    if (type === "quantitative") {
        const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").replace("−", "-"));
        if (!Number.isFinite(n))
            throw new SpecError(`${JSON.stringify(v)} is not a number`);
        return n;
    }
    if (type === "temporal") {
        if (v instanceof Date)
            return v;
        const m = String(v).match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);
        const d = m ? new Date(Date.UTC(+m[1], m[2] ? +m[2] - 1 : 0, m[3] ? +m[3] : 1)) : new Date(String(v));
        if (Number.isNaN(d.getTime()))
            throw new SpecError(`${JSON.stringify(v)} is not a date`);
        return d;
    }
    return String(v);
}
export function loadRows(spec, root, readRoots) {
    let raw = spec.data.values ?? parseCsv(readData(spec.data.url, root, readRoots));
    for (const t of spec.transform ?? []) {
        const [key, value] = t.as ?? ["key", "value"];
        raw = raw.flatMap((r) => t.fold.map((f) => {
            if (!(f in r))
                throw new SpecError(`fold: no field "${f}" in the data`);
            const rest = Object.fromEntries(Object.entries(r).filter(([k]) => !t.fold.includes(k)));
            return { ...rest, [key]: f, [value]: r[f] };
        }));
    }
    const channels = [spec.encoding.x, spec.encoding.y, spec.encoding.color].filter(Boolean);
    for (const c of channels) {
        if (raw.length && !(c.field in raw[0]))
            throw new SpecError(`no field "${c.field}" in the data; fields: ${Object.keys(raw[0]).join(", ")}`);
    }
    return raw.map((r) => {
        const row = {};
        for (const [k, v] of Object.entries(r))
            row[k] = v;
        for (const c of channels)
            row[c.field] = parseValue(r[c.field], c.type ?? "nominal");
        return row;
    });
}
