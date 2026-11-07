---
name: designcraft
description: Operate the pinned DesignCraft CLI through Maquette's shared document runtime, inspect current state and save working copies safely.
---

All tool callers share one active document in the runtime. Inspect it before relying on old conversation state. Use open_document with a project-relative file, inspect_document for current structure and labels, render_page with zero-based page for visual evidence, and the live catalogue for exact editing tool schemas. Do not invent tool arguments, item IDs or labels.

DesignCraft edits in memory. save_document explicitly persists the layout; a saved chat is not a layout backup. For InDesign/IDML input save a separate .designcraft working copy. A runtime restart can lose unsaved changes; inspect again and ask which working file to open. Changes made by other clients require checking current state. MCP clients authorize their own direct calls; skill loading and server descriptions do not change the terminal's permission policy.
