# AGENTS.md

Rules for every AI agent working in this repository and in its Linear project. Two agents work here: **Claude** (Claude Code) and **Codex**. Both follow this file.

`CLAUDE.md` holds the commands, the architecture, the code conventions and the Linear workflow for every piece of work. Despite its name, it applies to Codex too: read it before changing code.

## Two agents, one Linear project

Linear project **Maquette CLI** (team `HOT`): https://linear.app/hotelindiajuliet/project/maquette-cli-be83f556f33d. Both agents act through the owner's Linear account, so Linear's "created by" field always shows the owner. These rules make the author visible instead.

- **Label what you create.** Every issue you create gets the label from the "Created by" group: `Claude` or `Codex`. Never put it on an issue a person created, and never use the other agent's label.
- **Mark what you rewrite.** When you substantially rewrite an issue you didn't create, say so in the first line of its description: "Rewritten on <date> by <agent>: <why>".
- **Sign your comments and notes.** Start a comment, or a note added to a shared document, with your name and the date, for example `**Claude, 7 Nov 2026:**`.
- **One agent per issue.** An issue In Progress belongs to the agent that moved it there; its latest comment says which. Don't start it in parallel. Pick new work from the top of Todo.
- **Branches.** Use the issue's `gitBranchName`. If the session forces another name, use your own prefix (`claude/…` or `codex/…`) and still put `HOT-<n>` in commit messages and PR titles.

## Shared documents

The Decision log, "Planning rules and roadmap", the bet specs and "Maquette tools: what exists today" are edited by both agents and by the owner.

- **Read right before you write.** Fetch the document immediately before editing; the other agent may have changed it minutes ago.
- **Patch, don't replace.** Change only the section you need. Don't rewrite a whole document unless the owner asks for it.
- **Decision numbers.** Take the next free number from the Decision log as it stands when you add yours. When a decision changes an earlier one, say "Amends D<n>" or "Supersedes D<n>" in its text.
- **Language.** Issues and documents are written in English, in plain, short sentences, like the existing ones, unless the owner asks otherwise.

## Labels

| Group | Labels | Use |
| -- | -- | -- |
| Created by | `Claude`, `Codex` | Which agent created the issue. People's issues carry none. |
| Bet 1 phase | `Prototype`, `Complete`, `Refined` | Every Bet 1 issue carries one. Work the phases in order: Prototype first. |
| Layer | `Backend`, `Frontend` | Which half of the code the issue touches. |
| Type | `Feature`, `Improvement`, `Bug`, `DevOps` | What kind of work it is. |

## Board rules, in short

The full rules are in the Linear document "Planning rules and roadmap". The ones agents most often need:

- Every issue serves a bet or a track and sits in a milestone. **No milestone means Parked**: no priority, and a "Parked" note at the top of the description.
- **Urgent** is only for work on the current bet's gate.
- **Owner tasks** say so in their first line. Coding agents skip them.
- Decisions are written in the Decision log; don't plan work that contradicts a "Decided" entry.
