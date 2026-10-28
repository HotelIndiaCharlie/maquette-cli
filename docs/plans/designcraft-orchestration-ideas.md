# DesignCraft orchestration: 100 ideas for Maquette's agentic layer

Brainstorm on how to harness DesignCraft's MCP tools, control channel, CLI and engine commands together, and how to organise an intermediate layer Maquette's agent can call. Each idea is a title and a description of at most 150 characters.

## The intermediate layer

1. **Command Atlas.** Index designcraft://commands at startup into a searchable catalogue with params, needs and examples, so the agent picks by intent.
2. **Intent Compiler.** Translate one coarse intent like "two-column article" into a validated batch of engine commands, resolving $N chaining itself.
3. **Dry-Run Planner.** Check every step's enabled condition before a batch runs, and return refusal reasons up front instead of failing halfway.
4. **Transaction Wrapper.** Run a batch as one undoable unit: snapshot, apply, verify, and restore the saved copy if any step fails.
5. **Unit Normaliser.** Accept mm, picas, cm, percent of page and baseline units from the model, and convert them all to points in spread space.
6. **Byte-Offset Shield.** Let the agent address text by characters, words or paragraphs, and convert to UTF-8 byte offsets before story calls.
7. **Semantic Addressing.** Name objects by role, such as headline or caption of figure 2, and resolve them with object.findByLabel instead of ids.
8. **Spread Coordinate Mapper.** Hide facing-spread maths: the agent says "right page, top margin" and the layer adds the page width offset.
9. **Dual-Door Router.** Send engine commands through MCP and window-only commands through the control channel, choosing the door per command.
10. **Live Mirror Mode.** Switch from headless to --connect mid-session, so the human watches the agent's edits appear live in the window.
11. **Recipe Scripts.** Store proven batches as parameterised recipes that humans, CI or the agent replay through designcraft-cli script.
12. **Capability Probe.** List the commands enabled in the current state and show the model only usable ones, cutting noise from 727 commands.
13. **Error Explainer.** Turn "unknown param" and "needs selection" refusals into a corrective hint the model can act on in its next step.
14. **Sandboxed Roots.** Always launch MCP with read and write roots set to the project folder, so the agent never touches files outside it.
15. **Control Channel Guard.** Open the unauthenticated control port only while needed, behind a token proxy, and close it when idle.

## Coarse intent tools

16. **layout_from_brief.** Build a full spread from a text brief: grid, frames, styles and placeholder content in one call.
17. **flow_story.** Place long copy across linked frames and pages, adding pages until no text is overset.
18. **place_image_smart.** Place an image, fit it proportionally and crop to the subject with focal-point detection rather than a centre crop.
19. **style_sheet_from_sample.** Derive paragraph and character styles from a sample page or PDF, and register them in the document.
20. **apply_grid.** Create a modular or baseline grid on parent spreads from columns, gutter, margins and leading.
21. **table_from_csv.** Turn a CSV into a styled table with header rows, decimal-aligned numbers and alternating row fills.
22. **infographic_kit.** Extend the chart tool to icons, pictograms, timelines and callouts built from paths and lines.
23. **cover_variants.** Generate several covers from one brief, render them and return a contact sheet for the human to pick from.
24. **master_page_builder.** Create parent spreads with folios, running heads and section markers from a short description.
25. **caption_binder.** Attach captions to images as grouped, labelled pairs that move together when the layout changes.
26. **pull_quote.** Pick a strong line from the story, style it, and place it with text wrap where the page stays balanced.
27. **toc_generator.** Scan headings across stories and build a table of contents with page numbers that refresh on demand.
28. **index_builder.** Collect tagged terms with find.find, and lay out a back-of-book index with page references.
29. **footnote_flow.** Keep notes anchored to their text, and reflow them at the page foot or as endnotes when copy moves.
30. **localise_document.** Duplicate a layout per language, swap the stories, and resize frames for text expansion in German or Japanese.
31. **resize_adapt.** Adapt a layout from A4 to Letter, a social square or tabloid, re-flowing frames onto the new grid.
32. **brand_enforcer.** Load brand tokens for colour, type and spacing, and apply them to every style and object in one call.
33. **data_merge.** Fill a template from data rows to make catalogues, badges or price lists, one record per page or frame.
34. **swatch_harmoniser.** Propose a palette from an image or brief, check contrast pairs, and register the swatches in the document.
35. **object_styler.** Apply strokes, fills, corners and effects consistently to every object that plays the same role.

## Typography

36. **Rag Doctor.** Inspect the rag on the render and adjust hyphenation or tracking until no holes or ladders remain.
37. **Widow and Orphan Hunter.** Find single lines at frame tops and bottoms, and fix them with tracking, frame nudges or rewording offers.
38. **Baseline Lock.** Snap every text frame and style to the baseline grid, and report anything that drifts off it.
39. **Font Pairing Advisor.** Use font.list to propose pairings that are installed, with reasons based on classification and x-height.
40. **Copyfit.** Make copy fit a frame through small steps in size, leading and tracking, inside limits the art director sets.
41. **Typographic Scale.** Generate a modular type scale from one base size and ratio, and write it into heading and body styles.
42. **Smart Punctuation.** Clean a story's quotes, apostrophes and dashes, and add non-breaking spaces before units and after initials.
43. **Drop Cap Composer.** Set drop caps that align to cap height and baseline, measured on the render rather than guessed.
44. **Hanging Punctuation.** Push quotes and bullets outside the margin on display text, so the left edge reads optically straight.
45. **Multilingual Typesetter.** Handle CJK, Arabic and accented text safely with byte offsets, and check glyph coverage for each font.
46. **Headline Rewriter.** Offer headline variants that fit the frame exactly, and let the human choose the final wording.
47. **Kerning Pass.** Render display lines at high zoom, spot uneven pairs visually, and kern only the headlines.
48. **Readability Meter.** Score measure, leading and contrast per text frame, and flag lines outside 45 to 75 characters.

## Layout and structure

49. **Grid Reasoner.** Read the grid from inspect_document and describe it in words, so the agent places objects on it, not near it.
50. **Hierarchy Check.** Rank elements on the render by size, weight and position, and compare with the intended reading order.
51. **White Space Balancer.** Measure gaps between objects and even them out to the grid's spacing unit.
52. **Alignment Snapper.** Find objects a fraction of a point off a shared edge, and snap them into line with transform.move.
53. **Layout Diff.** Compare two document states and describe every move, resize and style change in plain sentences.
54. **Classical Canons.** Offer Van de Graaf, Tschichold and golden-section margins as presets for book pages.
55. **Layer Discipline.** Keep text, images, guides and notes on named layers, activating the right layer before each create.
56. **Z-Order Narrator.** Explain the stacking order and fix overlaps, so captions never hide under images.
57. **Spread Pacing.** Read a whole publication and suggest its rhythm: where to break, where to breathe, where a full bleed belongs.
58. **Template Extractor.** Turn a finished spread into a reusable parent spread with labelled slots like firstlight:slot:01.
59. **Slot Contracts.** Give each labelled slot a type, aspect ratio and style, so tools place only content that fits it.
60. **Relation Rules.** Store constraints like "caption 6 pt below image", and have the layer repair them after any move.

## Seeing the page

61. **Render-Look-Fix Loop.** Render after each change, send the image to the model, and let it critique and correct its own work.
62. **Region Renders.** Render only the changed area at high resolution, so the model checks detail without paying for whole pages.
63. **Before and After Strip.** Save a side-by-side of each page before and after every agent turn in the renders folder.
64. **Saliency Map.** Estimate where the eye lands first on a render, and compare it with where the designer wants attention.
65. **Thumbnail Wall.** Render every page as a grid of thumbnails, so agent and human judge the whole publication at a glance.
66. **Overset Radar.** Detect overset text from story data and from the render, and report each case with a proposed fix.
67. **Colour Proof.** Simulate CMYK and grayscale on renders, and flag images or text that lose contrast in print.
68. **Accessibility Lens.** Check contrast, minimum sizes and reading order for accessible PDF export, and propose fixes.
69. **Reference Matcher.** Compare a render with a mood-board image and list concrete changes that move the page toward it.
70. **Visual Regression Tests.** Keep page renders as goldens, and fail CI when a template change moves pixels beyond tolerance.

## Quality and safety

71. **Preflight Agent.** Check fonts, image resolution, bleed, overprint and colour spaces before export, and write a readable report.
72. **Style Audit.** List local overrides that bypass styles, and offer to fold them back into the style sheet.
73. **Orphaned Object Sweep.** Find empty frames, hidden objects and unused swatches, and remove them after confirmation.
74. **Consistency Linter.** Enforce MAQUETTE.md rules such as "captions 8/10 italic", and report each breach with its location.
75. **Proofreader.** Check every story for spelling, house style and repeated words, fixing them through story.replaceRange.
76. **Link Health.** Verify image and data paths still resolve inside the project root, and relink missing files by name.
77. **Export Profiles.** Wrap export settings as named profiles for print, screen and proof, which the agent picks per request.
78. **Version Snapshots.** Save a copy at each milestone and commit it to git with a render, so any state can be revisited.
79. **Change Budget.** Cap how many objects one agent turn may touch in ask mode, and require approval for wider edits.
80. **Trace Replay.** Replay a traced session step by step, to see why the agent made each layout choice.

## Human and AI working together

81. **Plan Preview.** In plan mode, render a ghost overlay of the proposed layout before any command touches the document.
82. **Point and Say.** The human selects an object in the window, Maquette reads the selection, and "make this bigger" just works.
83. **Taste Memory.** Remember which proposals the human accepted or rejected, and lean future proposals toward their taste.
84. **Three Options Rule.** For subjective choices, propose three distinct rendered variants rather than one answer.
85. **Explain My Choice.** Attach a one-line design rationale to each layout decision, which the human can question or overturn.
86. **Lock Zones.** Let the human lock objects or pages, so the agent treats them as fixed context and never edits them.
87. **Co-Pilot Nudges.** While the human works in the window, the agent suggests fixes for misalignments or widows but never acts alone.
88. **Critique Mode.** The agent acts as art director: it reviews a spread and writes notes, changing nothing until asked.
89. **Undo by Sentence.** "Undo the last caption change" reverts just that step, by matching the sentence to the logged tool calls.
90. **Survey to Brief.** Use the survey tool to interview the client in a few questions, then turn the answers into a layout brief.
91. **Multi-Agent Studio.** Several sessions share one engine over HTTP: a typesetter, an image editor and a proofreader on one file.
92. **Role Permissions.** Give each connected session a role that limits its command namespaces, so the proofreader edits only text.

## Production pipelines

93. **Markdown to Magazine.** Turn a folder of Markdown articles and images into a styled multi-page publication in one command.
94. **Annual Report Autopilot.** Pull figures from spreadsheets, refresh every chart and table, and flag text quoting changed numbers.
95. **Catalogue Sync.** Rebuild product pages nightly from a database or CMS feed, rendering the differences for a human to approve.
96. **Headless CI Publishing.** Run maquette ask in CI to build, preflight and export PDFs on every content commit.
97. **Watch Folder.** Watch a folder for new copy or images, and place each into the next free labelled slot.
98. **Docs and Design Bridge.** Import text from shared documents and frames from design tools as DesignCraft stories and objects.
99. **Genre Skill Packs.** Ship SKILL.md bundles for books, newspapers, packaging and posters, each with its own rules and recipes.
100. **Document Knowledge Graph.** Model the document as a graph of stories, frames, styles and relations, so the agent reasons on structure.
