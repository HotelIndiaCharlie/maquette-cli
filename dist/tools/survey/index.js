// The survey tool: everything /init needs to learn a document, in one call. It inspects the
// open document, reads every story's text, lists styles, swatches and fonts, names the labelled
// frames page by page and renders the pages small, so the model can study the design without
// thirty calls. With nothing open, it lists the documents in the folder instead.
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { readZipEntry } from "./zip.js";
// The files DesignCraft can open: its own, IDML, and InDesign documents and templates.
export const openable = /\.(designcraft|idml|indd|indt)$/i;
const skip = new Set(["node_modules", "maquette-renders", ".git", ".maquette"]);
// Documents in the folder and the one below it, where an InDesign package keeps its file.
export function documentsIn(root) {
    const out = [];
    const walk = (dir, depth) => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (e.name.startsWith(".") || skip.has(e.name))
                continue;
            if (e.isDirectory() && depth < 2)
                walk(join(dir, e.name), depth + 1);
            else if (e.isFile() && openable.test(e.name))
                out.push(relative(root, join(dir, e.name)));
        }
    };
    walk(root, 0);
    return out;
}
export function fileFacts(doc) {
    const labels = new Map();
    const used = { paragraph: {}, character: {}, object: {} };
    const count = (into, name, by = 1) => {
        if (name && !name.startsWith("["))
            into[name] = (into[name] ?? 0) + by;
    };
    const visit = (item) => {
        if (item.label)
            labels.set(item.id, item.label);
        count(used.object, item.objectStyle);
        for (const c of item.content?.items ?? [])
            visit(c);
    };
    for (const spread of doc.spreads)
        for (const item of spread.items)
            visit(item);
    for (const story of Object.values(doc.stories)) {
        for (const p of story.paras ?? [])
            count(used.paragraph, p.style);
        for (const c of story.chars ?? [])
            count(used.character, c.style);
    }
    return { labels, objectStyles: (doc.styles.object ?? []).map((o) => o.name).filter((n) => !n.startsWith("[")), used };
}
// A copy of the open document saved to a scratch file and read back; the document itself, its
// path and its unsaved state don't change.
async function readFacts(dc, root) {
    const dir = join(root, ".maquette");
    const path = join(dir, `survey-${process.pid}.designcraft`);
    try {
        mkdirSync(dir, { recursive: true });
        await dc.execute("file.saveACopy", { path });
        const json = readZipEntry(readFileSync(path), "document.json");
        return json ? fileFacts(JSON.parse(json.toString("utf8"))) : undefined;
    }
    catch {
        return undefined;
    }
    finally {
        rmSync(path, { force: true });
    }
}
const text = (t) => ({ type: "text", text: t });
// Names DesignCraft gives items on its own carry no meaning; a designer's label does.
const withUse = (names, used) => {
    const real = names.filter((n) => !n.startsWith("["));
    return used ? Object.fromEntries(real.map((n) => [n, used[n] ?? 0])) : real;
};
const named = (i) => typeof i.name === "string" && i.name.trim() !== "" && !/^(<.*>|Rectangle|Text Frame|Graphic Frame|Group|Line|Path|Oval|Polygon)( \d+)?$/i.test(i.name);
const survey = ({ dc, root, warnings }) => {
    async function run(args) {
        const scale = typeof args.scale === "number" && args.scale > 0 ? Math.min(args.scale, 2) : 0.4;
        const maxPages = typeof args.pages === "number" && args.pages >= 0 ? Math.floor(args.pages) : 24;
        const textLimit = typeof args.text === "number" && args.text >= 0 ? Math.floor(args.text) : 12000;
        let doc;
        try {
            doc = await dc.json("inspect_document");
        }
        catch {
            const found = documentsIn(root);
            return { content: [text(found.length ? `No document is open. Documents in this folder:\n${found.map((f) => `  ${f}`).join("\n")}\nOpen one with open_document, then call document_survey again.` : "No document is open, and there's no .designcraft, .idml, .indd or .indt file in this folder or the one below it.")] };
        }
        const facts = await readFacts(dc, root);
        // Where each item sits: its page, by the centre of its bounds, and its top, for reading order.
        const pageOf = new Map();
        const labels = [];
        for (const spread of doc.spreads) {
            const visit = (item) => {
                const cx = (item.bounds[0] + item.bounds[2]) / 2;
                const page = spread.pages.find((p) => cx >= p.bounds[0] && cx <= p.bounds[2]) ?? spread.pages[0];
                pageOf.set(item.id, { page: page?.index ?? 0, top: item.bounds[1] });
                const label = facts?.labels.get(item.id);
                if (named(item) || label)
                    labels.push({ page: (page?.index ?? 0) + 1, id: item.id, kind: item.kind, ...(named(item) ? { name: item.name } : {}), ...(label ? { label } : {}) });
                for (const c of item.children ?? [])
                    visit(c);
            };
            for (const item of spread.items)
                visit(item);
        }
        // Stories in reading order, page then top, each up to its share of the text limit.
        const where = (s) => pageOf.get(s.frames[0]) ?? { page: Infinity, top: Infinity };
        const ordered = [...doc.stories].sort((a, b) => where(a).page - where(b).page || where(a).top - where(b).top);
        const stories = [];
        let left = textLimit;
        for (const s of ordered) {
            let body = "";
            try {
                body = (await dc.execute("story.get", { story: s.id })).text ?? "";
            }
            catch { }
            const cut = body.length > left ? `${body.slice(0, Math.max(0, left))}…` : body;
            left -= Math.min(body.length, left);
            const w = where(s);
            // A story whose frames aren't on a document page sits on a parent page.
            stories.push({ story: s.id, page: Number.isFinite(w.page) ? w.page + 1 : "parent", frames: s.frames, overset: s.overset, text: cut });
        }
        let fonts = [];
        try {
            fonts = (await dc.execute("font.list")).map((f) => ({ family: f.family, style: f.style, status: f.missing ? `missing${f.replacementFamily ? `, shown in ${f.replacementFamily}` : ""}` : (f.matchStatus ?? "ok") }));
        }
        catch { }
        const pages = doc.spreads.flatMap((s) => s.pages.map((p) => ({ page: p.index + 1, name: p.name, spread: s.index, parent: p.parent ?? null, columns: p.columns })));
        const count = doc.pageCount ?? pages.length;
        const rendered = Math.min(count, maxPages);
        const images = [];
        for (let page = 0; page < rendered; page++) {
            const r = await dc.call("render_page", { page, scale });
            images.push(...r.content.filter((c) => c.type === "image"));
        }
        const recorded = warnings();
        const summary = {
            title: doc.title,
            path: doc.path,
            pages: count,
            size: doc.settings ? `${Math.round(doc.settings.pageWidth)} × ${Math.round(doc.settings.pageHeight)} pt${doc.settings.facingPages ? ", facing pages" : ""}` : undefined,
            parents: doc.parents?.map((p) => p.label).filter(Boolean),
            layers: doc.layers.map((l) => l.name),
            // Each style with how often it's used: paragraphs, character runs, frames.
            paragraphStyles: withUse(doc.paragraphStyles, facts?.used.paragraph),
            characterStyles: withUse(doc.characterStyles, facts?.used.character),
            objectStyles: facts ? withUse(facts.objectStyles, facts.used.object) : undefined,
            swatches: (doc.swatches ?? []).filter((s) => !s.startsWith("[")),
            fonts,
            pageList: pages,
            labelledItems: labels,
            stories,
            warnings: recorded.length,
        };
        const notes = [
            `Survey of ${doc.title ?? doc.path ?? "the open document"}: ${count} page${count === 1 ? "" : "s"}, ${rendered === count ? "all" : rendered ? `the first ${rendered}` : "none"} rendered below at ${scale} px/pt, in order.`,
            left <= 0 ? `The stories' text was cut at ${textLimit} characters in all; story.get gives one story's whole text.` : "",
            labels.length ? "" : "No item carries a designer's name or label; describe slots by page and position.",
            facts ? "" : "The script labels, object styles and style use couldn't be read from a copy of the document, so they're left out.",
            recorded.length ? `Opened with ${recorded.length} warning${recorded.length === 1 ? "" : "s"} (missing links or fonts, conversion notes); the person has been told, and they're kept beside the document when it's saved. Don't put them in MAQUETTE.md.` : "",
        ].filter(Boolean);
        return { content: [text(`${notes.join(" ")}\n\n${JSON.stringify(summary)}`), ...images] };
    }
    return {
        name: "survey",
        instructions: "To learn a document as a whole, as /init does, call document_survey once: it returns the styles, swatches, fonts, labelled frames, the stories' text and a small render of every page. For a single fact, inspect_document is enough.",
        tools: [
            {
                name: "document_survey",
                description: "Survey the open document in one call: title, size and pages, parent pages, layers, paragraph and character styles, swatches, fonts with any missing, the items a designer labelled (by page), every story's text in reading order, the count of warnings from opening it, and a small render of each page. Read-only. With no document open, it lists the documents in the folder instead.",
                inputSchema: {
                    type: "object",
                    properties: {
                        scale: { type: "number", description: "Render size in pixels per point (default 0.4, small: enough to judge layout and colour)" },
                        pages: { type: "integer", description: "Render at most this many pages, from the first (default 24)" },
                        text: { type: "integer", description: "Characters of story text in all (default 12000)" },
                    },
                },
                annotations: { readOnlyHint: true },
            },
        ],
        call: (_name, args) => run(args),
    };
};
export default survey;
