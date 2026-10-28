// The survey and memory tool modules, against a scripted DesignCraft: no engine, no key. The
// survey reads the example report's own file for what only the file holds.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { DesignCraft, ToolResult } from "../../src/designcraft.ts";
import memory, { addLine } from "../../src/tools/memory/index.ts";
import survey, { documentsIn } from "../../src/tools/survey/index.ts";
import { readZipEntry } from "../../src/tools/survey/zip.ts";
import { png } from "./fake-server.ts";

const example = fileURLToPath(new URL("../../examples/annual-report.designcraft", import.meta.url));
const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "maquette-tools-")));
const textOf = (r: ToolResult) => r.content.find((c) => c.type === "text")?.text ?? "";

// What document.inspect says about the example report, cut down to what the survey reads.
function inspectExample() {
  const doc = JSON.parse(readZipEntry(readFileSync(example), "document.json")!.toString("utf8"));
  let page = 0;
  return {
    title: doc.title,
    path: "example/annual-report.designcraft",
    pageCount: doc.spreads.length,
    settings: { pageWidth: doc.settings.pageWidth, pageHeight: doc.settings.pageHeight, facingPages: false, intent: "print" },
    layers: doc.layers.map((l: { id: number; name: string }) => ({ id: l.id, name: l.name })),
    parents: [],
    spreads: doc.spreads.map((s: { items: { id: number; name?: string; path: { subpaths: { anchors: { p: [number, number] }[] }[] } }[] }, index: number) => ({
      index,
      pages: [{ index: page++, name: String(page), bounds: [0, 0, doc.settings.pageWidth, doc.settings.pageHeight] }],
      items: s.items.map((i) => {
        const ps = i.path.subpaths[0].anchors.map((a) => a.p);
        return { id: i.id, name: i.name ?? null, kind: "Rectangle", bounds: [Math.min(...ps.map((p) => p[0])), Math.min(...ps.map((p) => p[1])), Math.max(...ps.map((p) => p[0])), Math.max(...ps.map((p) => p[1]))] };
      }),
    })),
    stories: Object.values(doc.stories).map((s: any) => ({ id: s.id, frames: s.frames, overset: false })),
    paragraphStyles: doc.styles.paragraph.map((p: { name: string }) => p.name),
    characterStyles: doc.styles.character.map((p: { name: string }) => p.name),
    swatches: doc.swatches.map((w: { name: string }) => w.name),
    _stories: doc.stories,
  };
}

function fakeDesignCraft(open = true) {
  const seen: string[] = [];
  const ins = inspectExample();
  const reply = (v: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
  const dc = {
    async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
      seen.push(name === "execute" ? String(args.command) : name);
      if (!open && name !== "execute") return { content: [{ type: "text", text: '{"error":"no document"}' }], isError: true };
      if (name === "inspect_document") return reply(ins);
      if (name === "render_page") return { content: [{ type: "image", data: png, mimeType: "image/png" }, { type: "text", text: JSON.stringify({ width: 238, height: 337, page: args.page, scale: args.scale }) }] };
      const { command, params } = args as { command: string; params: Record<string, unknown> };
      if (command === "story.get") return reply({ text: ins._stories[String(params.story)].text });
      if (command === "font.list") return reply([{ family: "Source Serif 4", style: "Regular", missing: false, matchStatus: "exact" }, { family: "Akzidenz", style: "Bold", missing: true, replacementFamily: "Inter" }]);
      if (command === "file.saveACopy") {
        copyFileSync(example, String(params.path));
        return reply({ path: params.path });
      }
      return { content: [{ type: "text", text: `unknown ${command}` }], isError: true };
    },
    async json(name: string, args: Record<string, unknown> = {}) {
      const r = await this.call(name, args);
      if (r.isError) throw new Error(textOf(r));
      return JSON.parse(textOf(r));
    },
    execute(command: string, params: Record<string, unknown> = {}) {
      return this.json("execute", { command, params });
    },
  };
  return { dc: dc as unknown as DesignCraft, seen };
}

test("document_survey: styles with their use, swatches, fonts, labelled slots, stories in reading order, a small render per page", async () => {
  const root = temp();
  const { dc, seen } = fakeDesignCraft();
  const m = survey({ dc, root, readRoots: [root], warnings: () => ["Missing link: cover.tif"] });
  assert.deepEqual(m.tools[0].annotations, { readOnlyHint: true }, "read-only, so it runs without asking");
  const r = await m.call("document_survey", {});
  const text = textOf(r);
  assert.match(text, /^Survey of Larkmoor Annual Report 2025: 5 pages, all rendered below at 0\.4 px\/pt/);
  assert.match(text, /Opened with 1 warning/);
  const data = JSON.parse(text.slice(text.indexOf("\n\n") + 2));
  assert.equal(text.split("\n").length, 3, "compact JSON: the survey goes to the model");
  assert.equal(data.pages, 5);
  assert.equal(data.size, "595 × 842 pt");
  assert.equal(data.paragraphStyles["Text/Body"] > 0, true, "styles come with how often they're used");
  assert.equal(data.paragraphStyles["Chart/Title"], 0);
  assert.ok(!("[Basic Paragraph]" in data.paragraphStyles), "DesignCraft's own [bracketed] styles are left out");
  assert.ok(data.objectStyles["Chart/Bar"] !== undefined);
  assert.deepEqual(data.swatches.slice(0, 2), ["Chart Series 1", "Chart Series 2"]);
  assert.deepEqual(data.fonts[1], { family: "Akzidenz", style: "Bold", status: "missing, shown in Inter" });
  assert.deepEqual(data.labelledItems[0], { page: 1, id: 36, kind: "Rectangle", name: "Chart slot 01", label: "firstlight:slot:01" });
  assert.equal(data.labelledItems.length, 5);
  assert.equal(data.stories[0].page, 1);
  assert.match(data.stories[0].text, /^A fifth consecutive year of growth/, "reading order: page, then top");
  assert.deepEqual(data.stories.map((s: { page: number | string }) => s.page), [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, "parent"]);
  assert.match(data.stories.at(-1).text, /^Larkmoor Growers’ Cooperative/, "the running head sits on the parent page");
  assert.equal(data.warnings, 1);
  assert.equal(r.content.filter((c) => c.type === "image").length, 5);
  assert.equal(seen.filter((s) => s === "render_page").length, 5);
  assert.ok(!existsSync(join(root, ".maquette", `survey-${process.pid}.designcraft`)), "the scratch copy is removed");

  const few = await m.call("document_survey", { pages: 2, text: 100 });
  assert.equal(few.content.filter((c) => c.type === "image").length, 2);
  assert.match(textOf(few), /the first 2 rendered/);
  assert.match(textOf(few), /cut at 100 characters/);
});

test("document_survey with nothing open lists the documents in the folder and the one below", async () => {
  const root = temp();
  mkdirSync(join(root, "Package", "Links"), { recursive: true });
  writeFileSync(join(root, "Package", "Brochure.indd"), "");
  writeFileSync(join(root, "draft.idml"), "");
  writeFileSync(join(root, "notes.txt"), "");
  mkdirSync(join(root, "maquette-renders"));
  writeFileSync(join(root, "maquette-renders", "old.designcraft"), "");
  assert.deepEqual(documentsIn(root), ["draft.idml", "Package/Brochure.indd"]);
  const { dc } = fakeDesignCraft(false);
  const r = await survey({ dc, root, readRoots: [root], warnings: () => [] }).call("document_survey", {});
  assert.match(textOf(r), /No document is open\. Documents in this folder:\n {2}draft\.idml\n {2}Package\/Brochure\.indd\nOpen one with open_document/);
  const empty = await survey({ dc, root: temp(), readRoots: [], warnings: () => [] }).call("document_survey", {});
  assert.match(textOf(empty), /there's no \.designcraft, \.idml, \.indd or \.indt file/);
});

test("memory_write writes MAQUETTE.md and won't replace it unless told; memory_add adds a dated line under Decisions", async () => {
  const root = temp();
  const { dc } = fakeDesignCraft();
  const m = memory({ dc, root, readRoots: [root], warnings: () => [] });
  const file = join(root, "MAQUETTE.md");
  const first = await m.call("memory_write", { text: "# Report\n\n## Voice\nPlain.\n" });
  assert.match(textOf(first), /^Wrote MAQUETTE\.md: 4 lines, about \d+ tokens\.$/);
  assert.equal(readFileSync(file, "utf8"), "# Report\n\n## Voice\nPlain.\n");
  const refused = await m.call("memory_write", { text: "# Other" });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /replace: true/);
  assert.equal(readFileSync(file, "utf8"), "# Report\n\n## Voice\nPlain.\n");
  await m.call("memory_add", { line: "Charts use Chart Series 1 for emphasis." });
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(readFileSync(file, "utf8"), `# Report\n\n## Voice\nPlain.\n\n## Decisions\n\n- ${today}: Charts use Chart Series 1 for emphasis.\n`);
  const long = await m.call("memory_write", { text: "x".repeat(9000), replace: true });
  assert.match(textOf(long), /over the 2000/);
});

test("addLine puts the line at the end of its section, before the next one, and makes what's missing", () => {
  const file = "# R\n\n## Decisions\n\n### Stated\n- a\n\n### Inferred\n- b *(inferred)*\n\n## Do and don't\n- Do c\n";
  assert.equal(addLine(file, "Decisions", "- new"), "# R\n\n## Decisions\n\n### Stated\n- a\n\n### Inferred\n- b *(inferred)*\n- new\n\n## Do and don't\n- Do c\n");
  assert.equal(addLine(file, "do and don't", "- Don't d"), "# R\n\n## Decisions\n\n### Stated\n- a\n\n### Inferred\n- b *(inferred)*\n\n## Do and don't\n- Do c\n- Don't d\n");
  assert.equal(addLine("", "Decisions", "- x"), "# Design memory\n\n## Decisions\n\n- x\n");
  assert.equal(addLine("# R\n\n## Decisions\n", "Decisions", "- x"), "# R\n\n## Decisions\n\n- x\n");
});
