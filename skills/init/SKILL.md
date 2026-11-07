---
name: init
description: Survey the document and write MAQUETTE.md, the project's design memory, or propose changes to the one there is.
---

# /init: write the project's design memory

You are starting a project the way a production designer joins one: study the existing pages, ask the few things the pages can't tell you, and write down what a new designer would need to keep the work consistent. The result is `MAQUETTE.md` in the folder Maquette runs in. It goes into your instructions on every turn from now on, so it has to be short and right.

## 1. Find and open the document

Call `document_survey`. If no document is open, it lists the documents in the folder:

- One document: open it with `open_document`, then call `document_survey` again.
- Several: ask which one in your round of questions (step 3), and survey it once the person answers.
- None: say so, and say that `open_document <file>` or `example` gets one; stop there.

If the document came from InDesign (`.idml`, `.indd`, `.indt`), DesignCraft never saves over it. Save a working copy once it's open, `save_document --path <same name>.designcraft`, and name that file in MAQUETTE.md as the working file. If there's already a `.designcraft` copy beside it, ask which is the working file instead of making another.

If the survey says the document opened with warnings, say "opened with N warnings" in one line and nothing more. They don't go in MAQUETTE.md.

## 1b. Read the folder's supporting evidence

The survey includes a bounded folder map even without an open document. Use that map (or tree with a narrower path) to select **at most five supporting text files and three reference/linked images**. State the chosen relative paths and a short reason for each before reading them with read_file/view_image. Names alone are not evidence: actually read selected files. Prefer the brief and explicit brand/style guides to visual guesses. Do not open extra files merely to exhaust the budget.

For a PDF guide, only use an already installed pdftotext through bash with normal permissions; first check its availability. If absent, explicitly state which PDF was not read and ask only for its missing guidance. Never install converters. Do not infer rules from an unread PDF.

If guides conflict, ask which authority governs and wait before choosing. Cite each authoritative source's project-relative path and its role concisely in MAQUETTE.md. Avoid copying whole sources. Reruns still require agreement before changing existing memory.

## 2. Study it

Look at every render and read the stories' text before you write a word. Work out, the way a designer reading the pages would:

- **Purpose and audience:** what kind of document this is, who reads it, in what setting.
- **Voice:** tone, register, language and spelling, how numbers, dates, units and currencies are written. Quote a short phrase only when it shows the voice better than a description.
- **Visual identity by role:** which swatch carries emphasis and which is for text; how many accents a spread uses; which named paragraph and character styles are display, headline, standfirst, body, caption, source. Prefer styles that are actually used (the survey gives counts). The grid, margins and rhythm in words. The character of the imagery.
- **Conventions:** how charts look (which styles, what's highlighted, where the source line goes), pullquotes, captions, running heads, page furniture. Labelled frames (`labelledItems`) show the slots the layout expects; name them by their labels.

Separate what you saw from what you guess. Anything you infer goes under Decisions, marked *(inferred)*.

If you can't see the renders (the model has no vision), work from the styles, swatches, labels and text, say once that the result is text-only and weaker, and mark more as inferred.

## 3. Ask one round of questions

Ask only unresolved questions, at most two or three together, using both the pages and the brief/guides already read. Omit questions already answered by those sources; if nothing remains unclear, do not manufacture questions:

1. What the document is for and who reads it, if the pages leave it open.
2. What you may change: text, charts, images, layout, or only some of these.
3. Whether a house style or brand guide exists, only if the selected files and memory have not already answered it.

Add the which-document or which-working-file question here if step 1 needed it. Don't ask about mechanics you can look up. Then stop and wait for the answers.

## 4. Write MAQUETTE.md

With the answers, call `memory_write` with the whole file. Keep it under about 2000 tokens: it is design memory, not inventory. Use this shape, and leave out a section only when there's nothing true to say:

```markdown
# <Document title>

Working file: <name>.designcraft

## Purpose and audience
## Voice
## Visual identity
### Palette
### Type
### Grid and rhythm
### Imagery
## Conventions
## Authoritative sources
- `<relative/path>` — role and concise evidence
## Decisions
### Stated
- <what the person told you, dated YYYY-MM-DD>
### Inferred
- <what you concluded from the design> *(inferred)*
## Do and don't
- Do …
- Don't …
```

Never put in item ids, bounds, file internals or warnings; those come from `inspect_document` when a job needs them. Name styles and swatches exactly as the document does.

## On a rerun

When MAQUETTE.md already exists, the person's words in it are theirs. Survey again, compare, and propose changes instead of rewriting: a short list of additions, corrections and inferred decisions the pages no longer support, each with its reason. Ask only what the file doesn't already answer, if anything. Once the person agrees, call `memory_write` with `replace: true` and the file with only the agreed changes made; everything else stays word for word.

## When you're done

Say in a few lines what MAQUETTE.md now covers, the working file, and that the person can edit the file by hand at any time. From now on, when the person makes a design call worth keeping, offer to record it with `memory_add`.
