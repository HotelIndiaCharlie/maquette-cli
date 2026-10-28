# DesignCraft orchestration: ideas for Maquette's agentic layer

Brainstorm on how to harness DesignCraft's surfaces together, and how to organise an intermediate layer that Maquette's agent calls. Checked against the DesignCraft API Map for storytold/designcraft at commit 855d606: 26 MCP tools, 31 control-channel methods, 10 CLI subcommands and 727 commands.

Each idea has a title, a description of at most 150 characters, and a **Uses** line naming the DesignCraft surfaces it rests on. Tags say how much work Maquette has:

- **wrap**: DesignCraft already has the command; Maquette adds intent, defaults, checks and a coarse tool around it.
- **build**: Maquette needs its own logic on top, such as vision, maths or memory.
- **app**: needs the desktop app running, through `--connect` or the control channel.

## How to organise the layer

The intermediate layer sits between the model and DesignCraft's three doors, in six tiers. The model mostly sees tiers 4 and 5; tiers 1 to 3 are plumbing it never has to think about.

1. **Doors.** One client for MCP over stdio, the control channel on 127.0.0.1 and the CLI, picking the door per command from its kind.
2. **Grounding.** Units, spread coordinates, UTF-8 offsets, labels and the command catalogue, so the model speaks design terms, not engine terms.
3. **Safety.** Previews, undo steps, history, file roots and recovery saves wrapped around every write the agent makes.
4. **Intent tools.** Coarse tools like the chart tool: one call, dozens of commands, a verified result and a render.
5. **Perception and critique.** Renders, inspection, preflight and story data turned into observations the model can act on.
6. **Collaboration.** Notes, tracked changes, states, locks and memory that keep the human in charge of taste and the final call.

## 1. Doors and plumbing

1. **Dual-Door Router.** Send engine commands through MCP and the 185 window-only commands through the control channel, chosen by each command's kind. *build*
   Uses: `execute`, `engine.execute`, `list_commands`
2. **Live Mirror Mode.** Switch from headless to `--connect` mid-session, so the human watches the agent's edits appear live in the window. *app*
   Uses: `designcraft-cli mcp --connect`, `ui.set` page and zoom
3. **Follow the Agent.** In connected mode, page and zoom the window to wherever the agent is editing, like a camera operator. *app*
   Uses: `ui.set` page, zoom, fit; `layout.selectPage`
4. **Recipe Scripts.** Store proven sequences as parameterised command scripts that humans, CI or the agent replay through any door. *wrap*
   Uses: `script.run`, `batch`, `designcraft-cli script`
5. **Control Channel Guard.** The channel has no authentication: open it only while needed, behind a token proxy, and close it when idle. *build*
   Uses: `designcraft --control PORT`, `app.quit`
6. **Connection Pool.** Share the channel's 16 connections between Maquette's HTTP callers, and send only well-formed lines, since a bad one drops the link. *build*
   Uses: control channel JSON lines
7. **Sandboxed Roots.** Always start MCP with read and write roots set to the project folder, so the agent cannot touch files outside it. *wrap*
   Uses: `--automation-read-root`, `--automation-write-root`
8. **Desktop Root Gap.** The app has no file roots yet, so Maquette checks every path argument itself before sending a command over the channel. *build*
   Uses: `app.open`, `file.place`, `file.exportPdf` paths
9. **Performance Guard.** Benchmark heavy documents before long agent runs, and warn when a step will be slow enough to block other sessions. *wrap*
   Uses: `designcraft-cli bench`, `designcraft-cli perf`

## 2. Grounding the model

10. **Command Atlas.** Index the command list at startup into a search tool with params docs and needs, so the agent finds commands by intent. *wrap*
    Uses: `designcraft://commands`, `list_commands`, `designcraft-cli describe`
11. **Capability Probe.** Show the model only commands enabled in the current state, cutting noise from 727 down to what can run now. *wrap*
    Uses: `list_commands` with `enabledOnly`
12. **Intent Compiler.** Translate one coarse intent into a checked command script, wiring step results together with `$N.path` references. *build*
    Uses: `batch`, `script.run`
13. **Error Explainer.** Turn "unknown param" and "needs selection" refusals into a corrective hint the model can act on in its next step. *build*
    Uses: enabled checks, unknown-param errors
14. **Unit Normaliser.** Accept mm, picas, cm, percent of page and baseline units from the model, and convert all of them to points. *build*
    Uses: the points convention
15. **Spread Coordinate Mapper.** The agent says "right page, top margin" and the layer adds the page width offset and margins in spread space. *build*
    Uses: `inspect_document` pages and spreads
16. **Byte-Offset Shield.** Let the agent address text by characters, words or sentences, and convert to UTF-8 bytes for every text command. *build*
    Uses: `story.replaceRange`, `find.find`, `text.select`
17. **Semantic Addressing.** Label objects by role, such as headline or figure 2, and resolve them by label instead of by id. *wrap*
    Uses: `object.label`, `object.findByLabel`, `find.objects` label
18. **Selection Navigator.** Move through structure in words, such as "the frame under this one", instead of hunting for ids. *wrap*
    Uses: `select.container`, `select.content`, `select.nextBelow`, `select.nextInGroup`
19. **Document Knowledge Graph.** Model stories, frames, threads, styles and anchors as a graph, so the agent reasons on structure, not ids. *build*
    Uses: `inspect_document`, `story.get`, `anchored.list`, `xml.structure`
20. **Live Document Context.** Keep a compact summary of the document resource in the system prompt, refreshed after every change. *build*
    Uses: `designcraft://document`

## 3. Safety and reversibility

21. **Preview First.** Run every agent write as a preview the human sees, then commit it as one named undo step or cancel it. *wrap*
    Uses: `edit.preview`, `edit.commitPreview`, `edit.cancelPreview`
22. **Transaction Wrapper.** Group a batch into one undo step, and roll back to the step before it when a later command fails. *wrap*
    Uses: `batch` stops at first error; `edit.undo`, `document.history`
23. **Dry-Run Planner.** Check every step's enabled condition and params before a batch runs, and report the problems up front. *build*
    Uses: `list_commands`, `designcraft-cli describe`
24. **Undo by Sentence.** "Undo the last caption change" reverts just that step, by matching the sentence to history and the call log. *build*
    Uses: `document.history`, `edit.undo`, Maquette's call log
25. **Recovery Checkpoints.** Save a recovery point before each agent turn, so a crashed or confused run can always be reopened. *wrap*
    Uses: `file.recovery.save`, `file.recovery.list`, `file.recovery.open`
26. **Version Snapshots.** Save a copy and a render at each milestone and commit both to git, so any state can be revisited. *wrap*
    Uses: `file.saveACopy`, `render_page`
27. **Lock Zones.** Let the human lock objects or pages, so the agent treats them as fixed context and never edits them. *wrap*
    Uses: `object.lock`, `layer.set`, Maquette permissions
28. **Change Budget.** Cap how many objects one agent turn may touch in ask mode, and require approval for wider edits. *build*
    Uses: `document.history`, Maquette permissions
29. **Role Permissions.** Give each connected session a role that limits command namespaces, so the proofreader can edit only text. *build*
    Uses: command namespaces, Maquette HTTP server

## 4. Coarse intent tools

30. **layout_from_brief.** Build a full spread from a text brief: margins, columns, frames, styles and placeholder copy in one call. *build*
    Uses: `new_document`, `layout.marginsAndColumns`, `frame.grid`, `type.fillWithPlaceholder`
31. **flow_story.** Place long copy across threaded frames, adding pages until no text is overset. *wrap*
    Uses: `text.thread` with `autoflow`, `story.get` overset, `layout.pages.insert`
32. **place_image_smart.** Place an image, fill the frame and shift the crop toward the subject, found by vision rather than centred. *build*
    Uses: `place_image`, `fit.fillFrameProportionally`, `object.fittingOptions`
33. **style_sheet_from_sample.** Load paragraph and character styles from a reference document or IDML, resolving name conflicts sensibly. *wrap*
    Uses: `style.load`, `style.load.list`
34. **styles_from_formatting.** Turn a hand-formatted sample paragraph into a named style, then apply it to every matching paragraph. *wrap*
    Uses: `style.paragraph.redefine`, `style.paragraph.create`, `style.paragraph.apply`
35. **apply_grid.** Set margins, columns and a baseline grid on parent spreads from a few numbers such as column count and leading. *wrap*
    Uses: `layout.marginsAndColumns` with `parent`, `layout.createGuides`, `type.gridSettings`
36. **table_from_csv.** Turn a CSV into a styled table with header rows, decimal tabs and alternating fills, sorted on request. *wrap*
    Uses: `table.convertFromText`, `table.convertRowsToHeader`, `style.table.apply`, `table.sortRows`
37. **infographic_kit.** Extend the chart tool to pictograms, timelines and callouts built from paths, lines and pathfinder shapes. *build*
    Uses: `path.create`, `line.create`, `object.pathfinder`, `ui.paste` SVG
38. **cover_variants.** Generate several covers as states of one object, render each, and let the human flip between them. *wrap*
    Uses: `states.create`, `states.show`, `render_page`
39. **master_page_builder.** Create parent spreads with folios, running heads and sections from a short description. *wrap*
    Uses: `layout.parents.new`, `variables.define` runningHeader, `layout.section`
40. **caption_binder.** Generate live captions from alt text or file metadata, kept current as images change, in the caption style. *wrap*
    Uses: `object.caption` with `live`, `object.altText`
41. **pull_quote.** Pick a strong line from the story, style it, and place it with text wrap where the page stays balanced. *build*
    Uses: `story.get`, `frame.create`, `object.textWrap`, `style.paragraph.apply`
42. **data_merge.** Fill a template from a CSV or rows into catalogues or badges, then report missing images and overset records. *wrap*
    Uses: `data.source.select`, `data.placeholder.add`, `data.preview`, `data.merge`
43. **swatch_harmoniser.** Extract a theme from a key image, check contrast pairs, and register the colours as a swatch group. *wrap*
    Uses: `color.extractTheme`, `swatch.addColorTheme`, `swatch.newColorGroup`
44. **object_styler.** Capture a look as an object style and apply it to every object of the same role across the document. *wrap*
    Uses: `style.object.create` with `fromSelection`, `style.object.apply`, `find.objects`
45. **brand_enforcer.** Load brand fonts, swatches and styles, then replace every off-brand font and colour in one pass. *wrap*
    Uses: `style.load`, `swatch.load`, `font.replace`, `find.changeObjects`
46. **resize_adapt.** Make an alternate layout at a new page size, with liquid rules deciding how each object scales or pins. *wrap*
    Uses: `layout.createAlternate`, `liquid.pageRule`, `liquid.object`
47. **localise_document.** Duplicate stories per language with conditions or linked layouts, and fix frames for text expansion. *wrap*
    Uses: `condition.new`, `condition.apply`, `story.placeAndLink`, `story.setDirection`
48. **component_layouts.** Build cards and rows as flex containers, so adding or removing an item re-spaces the rest automatically. *wrap*
    Uses: `flex.add`, `flex.set`, `flex.reorder`
49. **inline_icons.** Anchor icons, logos or figures inside text, so they travel with the copy when it reflows. *wrap*
    Uses: `anchored.insert`, `anchored.options`
50. **qr_and_links.** Add QR codes, hyperlinks and cross-references for print-to-web and interactive PDF in one call. *wrap*
    Uses: `object.qrCode`, `hyperlink.create`, `xref.insert`
51. **equation_setter.** Typeset maths from LaTeX inline or as frames, sized to match the surrounding text. *wrap*
    Uses: `math.insert`
52. **step_and_repeat_sheet.** Lay out labels, tickets or cards as an imposed sheet with crop gaps, from one master item. *wrap*
    Uses: `edit.stepAndRepeat`, `frame.grid`
53. **list_styler.** Define bullets and numbering once, including multi-level outlines, and apply them across stories. *wrap*
    Uses: `list.define`, `list.bullets`, `list.numbers`

## 5. Typography

54. **Rag Doctor.** Inspect the rag on the render and adjust the composer, hyphenation or tracking until no holes or ladders remain. *build*
    Uses: `type.para` composer and hyphenate, `type.char`, `render_page`
55. **Widow and Orphan Hunter.** Find short last lines and stranded lines from story line data, and fix them with tracking or frame nudges. *build*
    Uses: `story.get` lines, `type.char`, `transform.resize`
56. **Hyphenation Dictionary.** Keep a project list of break points and never-break words like brand names, applied to every document. *wrap*
    Uses: `hyphenation.addException`, `hyphenation.list`
57. **Baseline Lock.** Put every body paragraph on the baseline grid, and report frames or styles that drift off it. *wrap*
    Uses: `type.gridSettings`, `ui.set` baselineGrid
58. **Font Pairing Advisor.** Propose pairings from installed fonts only, with reasons based on classification and x-height. *build*
    Uses: `font.list`
59. **Copyfit.** Make copy fit a frame through small steps in size, leading and tracking, inside limits the art director sets. *build*
    Uses: `story.get` overset, `type.char`, `type.sizeDown`
60. **Typographic Scale.** Generate a modular type scale from one base size and ratio, and write it into heading and body styles. *build*
    Uses: `style.paragraph.create`, `style.paragraph.edit`
61. **Smart Punctuation.** Clean quotes, apostrophes and dashes with regular-expression find and change, and add non-breaking spaces. *wrap*
    Uses: `find.change` with `grep`
62. **Drop Cap Composer.** Set drop caps by lines and characters with a character style, checked on the render for optical fit. *wrap*
    Uses: `type.para` dropCapLines, dropCapChars, dropCapStyle
63. **Hanging Punctuation.** Turn on optical margin alignment for display text and pull quotes, so the edge reads straight. *wrap*
    Uses: `type.para` opticalMargin, `story.options`
64. **Kerning Pass.** Render display lines at high scale, spot uneven pairs visually, and kern only the headlines. *build*
    Uses: `ui.render` scale, `type.kernPair`
65. **OpenType Stylist.** Turn on small caps, old-style figures, ligatures and stylistic sets where the font has them. *wrap*
    Uses: `type.openTypeFeatures`, `type.feature`
66. **CJK Typesetter.** Set Japanese and Chinese text with ruby, warichu, tate-chu-yoko and composite fonts, checked in byte offsets. *wrap*
    Uses: `type.ruby`, `type.warichu`, `type.tateChuYoko`, `style.compositeFont.set`
67. **Vertical and RTL Stories.** Switch stories to vertical or right-to-left direction and check that frames, tabs and wraps still work. *wrap*
    Uses: `story.setDirection`, `type.storyDirection`
68. **Headline Rewriter.** Offer headline variants that fit the frame exactly, and let the human choose the final wording. *build*
    Uses: `story.get` lines, `set_story_text`
69. **Readability Meter.** Score measure, leading and contrast per text frame, and flag lines outside 45 to 75 characters. *build*
    Uses: `story.get` lines, `inspect_document`
70. **Tab Setter.** Set decimal, right and leader tabs for price lists and menus from a description of the columns. *wrap*
    Uses: `type.tabs.add`, `type.tabs.get`

## 6. Layout and structure

71. **Grid Reasoner.** Read margins, columns and guides and describe them in words, so the agent places objects on the grid, not near it. *build*
    Uses: `inspect_document`, `guide.list`
72. **Hierarchy Check.** Rank elements on the render by size, weight and position, and compare with the intended reading order. *build*
    Uses: `render_page`, `inspect_document`
73. **Gap Negotiator.** Widen or narrow the space between two objects with the gap tool, so both sides resize instead of one moving. *wrap*
    Uses: `gap.move`
74. **Alignment Snapper.** Find objects a fraction of a point off a shared edge, then align and distribute them in one step. *wrap*
    Uses: `object.align`, `object.distribute`
75. **Layout Diff.** Compare two document states and describe every move, resize and style change in plain sentences. *build*
    Uses: `inspect_document` before and after
76. **Classical Canons.** Offer Van de Graaf, Tschichold and golden-section margins as presets for book pages. *build*
    Uses: `layout.marginsAndColumns`
77. **Layer Discipline.** Keep text, images, guides and notes on named layers, and delete empty layers when done. *wrap*
    Uses: `layer.new`, `layer.activate`, `layer.deleteUnused`
78. **Z-Order Narrator.** Explain the stacking order and fix overlaps, so captions never hide under images. *wrap*
    Uses: `object.arrange`, `object.bringToFront`, `object.group`
79. **Spread Pacing.** Read a whole publication and suggest rhythm: where to break, where to breathe, where a full bleed belongs. *build*
    Uses: thumbnail renders, `layout.pages.move`, `layout.spreadShuffle`
80. **Template Extractor.** Turn a finished spread into a parent spread or library item with labelled slots like firstlight:slot:01. *wrap*
    Uses: `layout.parents.new`, `library.add`, `object.label`
81. **Slot Contracts.** Give each labelled slot a type, aspect ratio and style, so tools place only content that fits it. *build*
    Uses: `object.label`, `object.attributes`
82. **Relation Rules.** Express "caption 6 pt below image" as flex containers or liquid pins, so relations survive edits. *wrap*
    Uses: `flex.set` gap, `liquid.object` pins
83. **Content Conveyor.** Collect objects from one layout and place them into another, to move content between versions quickly. *wrap*
    Uses: `conveyor.collect`, `conveyor.place`
84. **Asset Library.** Keep logos, sidebars and approved components in a library the agent places from, instead of redrawing them. *wrap*
    Uses: `library.new`, `library.add`, `library.place`, `snippet.place`

## 7. Long documents

85. **Book Conductor.** Run multi-chapter publications as a book: add chapters, sync styles, repaginate and export one PDF. *wrap*
    Uses: `book.new`, `book.add`, `book.syncStyles`, `book.paginate`, `book.exportPdf`
86. **toc_builder.** Generate a table of contents from heading styles with entry styles and leaders, and refresh it after edits. *wrap*
    Uses: `toc.generate`, `toc.update`
87. **index_builder.** Tag terms found in the text as index references, then generate and update the back-of-book index. *wrap*
    Uses: `find.find`, `index.addReference`, `index.generate`
88. **Notes Manager.** Insert footnotes and endnotes from marked text, and switch the whole document between the two. *wrap*
    Uses: `footnote.insert`, `endnote.insert`, `footnote.options`
89. **Cross-Reference Keeper.** Turn "see page 12" into live cross-references that stay right when pages move. *wrap*
    Uses: `anchor.create`, `xref.insert`, `xref.defineFormat`
90. **Section Numbering.** Set front matter in roman numerals and chapters in arabic, with prefixes and chapter numbers. *wrap*
    Uses: `layout.section`, `layout.chapterNumbering`
91. **Running Heads.** Pull the current chapter or section title into headers automatically with text variables. *wrap*
    Uses: `variables.define` runningHeader, `variables.insert`
92. **Linked Copy.** Reuse the same story in several layouts as linked copies, so one correction updates every version. *wrap*
    Uses: `story.placeAndLink`, `story.updateLink`, `story.links`
93. **Audience Versions.** Mark text for each edition, such as trade or retail, with conditions, and export each version. *wrap*
    Uses: `condition.new`, `condition.apply`
94. **XML Structured Authoring.** Tag content to a schema, map tags to styles, and round-trip XML with an editorial system. *wrap*
    Uses: `xml.tag`, `xml.mapStyle`, `xml.validate`, `file.importXml`, `file.exportXml`

## 8. Seeing the page

95. **Render-Look-Fix Loop.** Render after each change, send the image to the model, and let it critique and correct its own work. *wrap*
    Uses: `render_page`
96. **Detail Renders.** Render at higher scale for detail checks and with bleed for trim checks, cropping to the area that changed. *build*
    Uses: `ui.render` scale and bleed, `export_png`
97. **Before and After Strip.** Save a side-by-side of each page before and after every agent turn in the renders folder. *build*
    Uses: `render_page`
98. **Thumbnail Wall.** Render every page as a grid of thumbnails, so agent and human judge the whole publication at a glance. *wrap*
    Uses: `designcraft-cli run --all-pages`
99. **Saliency Map.** Estimate where the eye lands first on a render, and compare it with where the designer wants attention. *build*
    Uses: `render_page`
100. **Overset Radar.** Read overset from stories and tables after every edit, and report each case with a proposed fix. *wrap*
     Uses: `inspect_document` stories, `story.get`
101. **Separations Proof.** Preview ink separations to catch rich black text, unwanted spot colours and overprint mistakes. *wrap*
     Uses: `ink.separations`, `ink.list`, `ui.inspect` separations preview
102. **Reference Matcher.** Compare a render with a mood-board image and list concrete changes that move the page toward it. *build*
     Uses: `render_page`
103. **Visual Regression Tests.** Keep page renders as goldens, and fail CI when a template change moves pixels beyond tolerance. *build*
     Uses: `designcraft-cli run --export`

## 9. Quality and preflight

104. **Preflight Agent.** Run preflight, explain each issue in plain words, and fix the safe ones such as low resolution or missing links. *wrap*
     Uses: `preflight.run`, `links.relink`
105. **PDF/X Gate.** Validate exported PDFs against PDF/X-4, including unembedded fonts, before anything goes to print. *wrap*
     Uses: `designcraft-cli validate-pdf`
106. **Link Health.** Find missing or modified images and linked text, and relink by folder or update them in one step. *wrap*
     Uses: `links.list`, `links.relinkFolder`, `links.update`
107. **Print Package.** Collect the document, links, fonts, IDML and PDF with printer instructions into one folder. *wrap*
     Uses: `file.package`
108. **Style Audit.** Find local overrides that bypass styles, and fold them back into the style or clear them. *build*
     Uses: `style.paragraph.redefine`, `style.object.clearOverrides`, `layout.removeOverrides`
109. **Orphaned Object Sweep.** Find empty frames, hidden objects, unused layers and swatches, and remove them after confirmation. *wrap*
     Uses: `find.objects`, `layer.deleteUnused`, `swatch.delete`, `object.showAll`
110. **Consistency Linter.** Enforce MAQUETTE.md rules such as "captions 8/10 italic", and report each breach with its location. *build*
     Uses: `inspect_document`, `story.get`
111. **Proofreader.** Check spelling with suggestions, keep a project word list, and correct house style through find and change. *wrap*
     Uses: `spelling.check`, `spelling.addWord`, `find.change`
112. **Accessibility Lens.** Add alt text, set reading order with articles, add bookmarks, and check contrast for tagged PDF and EPUB. *wrap*
     Uses: `object.altText`, `article.new`, `bookmark.add`, `xml.structure`
113. **Export Profiles.** Save named presets for print, screen and proof, which the agent picks per request. *wrap*
     Uses: `file.savePreset`, `file.presets`, `file.exportPdf`
114. **Trace Replay.** Replay a traced session step by step, to see why the agent made each layout choice. *build*
     Uses: Maquette telemetry, `script.run`

## 10. Human and AI together

115. **Plan Preview.** In plan mode, show the proposed change as a live preview, and commit it only when the human says yes. *wrap*
     Uses: `edit.preview`, `edit.commitPreview`
116. **Edits as Tracked Changes.** The agent rewrites copy with change tracking on, so the human accepts or rejects each edit. *wrap*
     Uses: `changes.track`, `changes.list`, `changes.accept`, `changes.reject`
117. **Notes as Dialogue.** The agent leaves notes in the text with its reasoning or questions, and reads the human's replies. *wrap*
     Uses: `note.new`, `note.list`, `note.edit`
118. **Point and Say.** The human selects something in the window, Maquette reads the selection, and "make this bigger" just works. *app*
     Uses: `inspect_document` selection, connected mode
119. **Three Options Rule.** For subjective choices, offer three distinct variants as states of one object, with renders. *wrap*
     Uses: `states.create`, `states.show`, `render_page`
120. **Explain My Choice.** Attach a one-line design rationale to each decision, which the human can question or overturn. *build*
     Uses: `note.new`, Maquette call log
121. **Taste Memory.** Remember which proposals the human accepted or rejected, and lean future proposals toward their taste. *build*
     Uses: Maquette memory, `changes.list`
122. **Critique Mode.** The agent acts as art director: it reviews a spread and writes notes, changing nothing until asked. *build*
     Uses: `render_page`, `note.new`, plan mode
123. **Co-Pilot Nudges.** While the human works in the window, the agent suggests fixes for misalignments or widows but never acts alone. *app*
     Uses: `document.inspect` polling, `note.new`
124. **Survey to Brief.** Use Maquette's survey tool to interview the client in a few questions, then turn the answers into a layout brief. *build*
     Uses: Maquette survey tool
125. **Multi-Agent Studio.** Several sessions share one engine: a typesetter, an image editor and a proofreader on one file. *build*
     Uses: Maquette HTTP server, `--connect`

## 11. Driving the app window

126. **Show Me How.** Teach the human by opening the real menu item or dialog, pre-filling fields, and pausing before confirming. *app*
     Uses: `ui.menu.invoke` without params, `ui.dialog.open`, `ui.dialog.set`
127. **Dialog Autopilot.** Run UI-only workflows by opening, filling and confirming dialogs, then checking the result. *app*
     Uses: `ui.dialog.open`, `dialog_set`, `dialog_confirm`
128. **Workspace Setup.** Arrange panels, guides, rulers and screen mode for the task at hand, such as proofing or layout. *app*
     Uses: `ui.set`, `ui.dock`, `ui.docking`
129. **SVG Paste-In.** Paste generated SVG as editable paths, for icons and diagrams the agent draws in code. *app*
     Uses: `ui.paste` with SVG markup
130. **Gesture Fallback.** When no command covers an action, drive the tool with pointer and key events, then verify by inspection. *wrap*
     Uses: `select_tool`, `pointer`, `key`, `type_text`
131. **Input Method Tester.** Exercise Japanese and Chinese input through IME events to check typing works in real stories. *wrap*
     Uses: `ime`, `ui.ime`

## 12. Pipelines and output channels

132. **Markdown to Magazine.** Turn a folder of Markdown articles and images into a styled multi-page publication in one command. *build*
     Uses: `new_document`, `set_story_text`, `text.thread`, `place_image`
133. **Annual Report Autopilot.** Pull figures from spreadsheets, refresh charts and tables, and flag text that quotes changed numbers. *build*
     Uses: Maquette chart tool, `table.setCell`, `find.find`
134. **Catalogue Sync.** Rebuild product pages nightly from a feed with data merge, rendering the differences for approval. *wrap*
     Uses: `data.source.update`, `data.merge`
135. **Headless CI Publishing.** Build, preflight and export PDFs on every content commit, with no app and no window. *wrap*
     Uses: `designcraft-cli run --cmd --export`, `designcraft-cli validate-pdf`
136. **One Source, Many Channels.** Export one layout to print PDF, EPUB, HTML and slides, checking each output for what breaks. *wrap*
     Uses: `file.exportPdf`, `file.exportEpub`, `file.exportHtml`, `file.exportPptx`
137. **Interactive PDF Kit.** Add buttons, form fields, page transitions and media for interactive PDFs and presentations. *wrap*
     Uses: `button.set`, `form.set`, `page.transition`, `media.options`
138. **InDesign Bridge.** Open IDML from studios still on InDesign, work on it, and hand back IDML. *wrap*
     Uses: `file.openIdml`, `file.exportIdml`, `style.load` from IDML
139. **Watch Folder.** Watch a folder for new copy or images, and place each into the next free labelled slot. *build*
     Uses: `object.findByLabel`, `place_image`, `set_story_text`
140. **Genre Skill Packs.** Ship SKILL.md bundles for books, newspapers, packaging and posters, each with its own rules and recipes. *build*
     Uses: Maquette skills, `script.run` recipes
