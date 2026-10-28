---
name: linear-handover
description: Keeps context moving between Linear tickets. Use whenever work is tracked in Linear - when starting a ticket (read the Handover comments on its parent and on the last Done sibling before planning) and when moving a ticket to Done, In Review or closing its PR (post a short Handover comment in the fixed shape). Triggers on starting, picking up, planning, finishing, closing or marking done a Linear issue, and on "handover", "what did the last ticket leave", "retrospective".
---

# Linear handover

A ticket's description says what was meant. The code says what is. Neither says what the next
person needs first: where the plan changed and why, where the seams are, what is still unverified,
and what hurt. That goes in one short **Handover** comment on the ticket when it closes, and is
read by whoever starts the next one.

## When you start a ticket

1. Read the ticket. Then list its comments (`list_comments`) and those of its parent and of the
   most recently Done sibling (same parent, or same project when there is no parent). Look for a
   comment headed `## Handover`.
2. Take from it what applies: plug-in points, deviations from the description, unverified items
   that your ticket touches, gotchas. Say in one line, to the person, what you took from it.
3. No Handover found: say so in one line and go on. Don't write one for someone else's ticket.

## When you finish a ticket

Post one comment headed `## Handover` in this shape when the ticket goes to Done, or to In
Review with a pull request open, whichever comes first. Update it in place if things change
before the merge. Then set the state.

```
## Handover

**Landed:** <branch or commit, PR link>. Full as-built: <link to the PR or the as-built comment>.

**Differs from the description:** <what was built differently, or left out, and why; or "nothing">

**Where the next tickets plug in:** <ticket id → file, function or setting, one line each; only for
tickets that exist>

**Still unverified:** <what the tests don't cover and nobody ran by hand; or "nothing">

**Gotchas learned:** <what cost time and will again; one line each; or "none">
```

Rules that keep it useful:

- **150 to 250 words.** Five headings, each a line or a short list. A heading with nothing says
  "nothing" or "none"; don't fill it.
- **Never repeat.** The description, the PR and any as-built comment hold the detail; link to
  them. The handover holds only what isn't written anywhere else.
- **Name files and tickets, not feelings.** "The loop is `src/agent/session.ts`, not `loop.ts`"
  helps; "the loop was tricky" doesn't.
- **One comment per ticket.** Edit it rather than adding a second.
- End the comment with the usual Claude Code attribution footer.

## Example

From HOT-52 in this repository, after Phase 2 merged:

```
## Handover

**Landed:** `main` at `5193bc9`, PR #2. The full as-built list is in the comment above.

**Differs from the description:** the loop is `src/agent/session.ts`, not `loop.ts`.
`open_document` counts as a change and asks, since it switches everyone's document. `/init`
exists as a stub (HOT-58). No `/config` verbosity; `ctrl+o` only.

**Where the next tickets plug in:**
- HOT-53: a tool module under `src/tools/`, listed in `src/tools/index.ts`; classify it in
  `src/agent/permissions.ts` or with MCP's `readOnlyHint`.
- HOT-54: the one tool list lives in `src/server.ts`; merge there.
- HOT-59: replace `initStub` in `session.ts`; `provider.vision` says whether the model can see.

**Still unverified:** the image round trip live with Claude; Ctrl-C mid-answer; Ollama text protocol.

**Gotchas learned:** Ink drops empty `Text` lines (draw a space). macOS Terminal rewraps rows on
resize, so the screen is cleared and the transcript redrawn. macOS temp paths need `realpathSync`
in tests.
```
