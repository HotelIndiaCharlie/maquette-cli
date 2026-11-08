---
name: chart
description: Create or update a data-bound chart in a labelled DesignCraft frame, validate its drawing and refuse updates that would discard hand fixes without explicit confirmation (keeping them is HOT-66).
---

For the detailed contract, load `skill(name: "chart", path: "references/working-with-charts.md")`.

Inspect the current document and call chart_list before changing charts. Read the tool schema with help/available catalogue rather than guessing fields. Use chart_create with the labelled frame and a JSON spec; packaged examples/specs/01-revenue.json through 05 provide current examples (maquette example copies them into the project). A spec declares data, mark, encoding and role-based styles; read an example and the live schema first.

For new data use chart_update on the existing chart after reviewing the reported hand changes. The current tool keeps a move of the whole chart and refuses updates when internal hand changes are detected. Keeping those changes is HOT-66. Show the reported changes and obtain explicit confirmation before using discard_hand_changes: true; never override the guard silently. Inspect returned validation and conflicts; never erase fixes silently. Render the relevant page and check overset text, clipping, labels and source notes. Save the document only when requested or approved, naming the working .designcraft file. Report real validation and remaining uncertainty. Skill guidance does not grant tool permissions.
