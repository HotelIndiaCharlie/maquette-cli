# AGENTS.md

Rules for every AI agent working in this repository and in its Linear project. Two agents work here: **Claude** (Claude Code) and **Codex**. Both follow this file.

`CLAUDE.md` holds the commands, the architecture, the code conventions and the Linear workflow for every piece of work. Despite its name, it applies to Codex too: read it before changing code.

## Two agents, one Linear project

Linear project **Maquette CLI** (team `HOT`): https://linear.app/hotelindiajuliet/project/maquette-cli-be83f556f33d. Both agents act through the owner's Linear account, so Linear's "created by" field always shows the owner. These rules make the author visible instead.

- **Label what you create.** Every issue you create gets the label from the "Created by" group: `Claude` or `Codex`. Never put it on an issue a person created, and never use the other agent's label.
- **Mark what you rewrite.** When you substantially rewrite an issue you didn't create, say so in the first line of its description: "Rewritten on <date> by <agent>: <why>".
- **Sign your comments and notes.** Start a comment, or a note added to a shared document, with your name and the date, for example `**Claude, 7 Nov 2026:**`.
- **One agent per issue.** An issue In Progress belongs to the agent that moved it there; its latest comment says which. Don't start it in parallel. Pick new work from the top of Todo.
- **Branches.** Use the issue's `gitBranchName`. If the session forces another name, use your own prefix (`claude/…` or `codex/…`) and still put `HOT-<n>` in commit messages and PR titles. The git rules below say how to work on them.

## Git workflow

These rules keep each issue's work safe, separate and reviewable. They came from the CLI foundations work (HOT-107): five issues built in one checkout, on one branch, with the review fixes left uncommitted.

1. **One issue, one branch, one worktree.** Work in your own worktree, never in the owner's main checkout:

   ```bash
   git worktree add ../maquette-hot-<n> -b <gitBranchName> <base>
   ```

   `<base>` is `main`, or the branch this issue depends on (rule 2). The main checkout stays on a clean `main`. If your session already gives you a worktree, work there.
2. **Stack dependent issues.** When an issue needs another issue's unmerged work, start its branch from that issue's branch, and point its pull request at that branch, not at `main`. Merge from the bottom of the stack up. After a change lower in the stack, rebase the branches above it in one go with `git rebase --update-refs <lower-branch>` (git 2.38 or later). Never build two issues on one branch.
3. **Never end a turn with uncommitted changes.** Commit every delivery, intermediate ones included. Each commit message names its issue: `… (HOT-<n>)`. A commit that serves several issues names them all: `(HOT-54, HOT-55)`. Fixes from a review are `fixup!` commits on the issue's own branch (`git commit --fixup=<commit>`); squash them with `git rebase --autosquash` before the merge.
4. **Push and open a draft pull request.** Push the issue's branch and open a draft PR as soon as the first commit exists. Pushing is a backup and runs CI; it is not a release. Mark the PR ready for review when the work is done, and set the issue to In Review. Review comments go on the PR's diff. Only the owner merges, unless the owner asks you to.
5. **Don't commit `dist/`.** `dist/` is built only on `main`: after every merge, the "Build dist" GitHub Action (`.github/workflows/dist.yml`) runs `npm run build` and commits the result. On a branch, run `npm run build` to check that the build works, then leave `dist/` out of your commits. A pull request that changes `dist/` fails CI.
6. **Respect the machine checks.** A `commit-msg` hook (`.githooks/commit-msg`) rejects a commit whose first line names no issue. Merge, `fixup!`, `squash!` and revert commits pass. CI (`.github/workflows/pr-rules.yml`) checks that a PR's title names an issue, that a `hot-<n>` branch names the same issue as the title, and that the PR doesn't touch `dist/`. Fix the cause; don't bypass the checks with `--no-verify`.

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
