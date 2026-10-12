# dsh-memories

A DSH (DeepSeek Harness) Host plugin bundle that gives DSH a **personal memory**
with three scopes, injected into every new session, plus the **`/memory`** human
command to write and preview memories from any session.

```
/memory save finished the migration notes, pickup: verify indexes tomorrow
/memory long Terraform conventions | Use -target only in emergencies; modules live under infra/modules.
/memory workspace Release process | pnpm build && pnpm test, then tag vx.y.z — CHANGELOG.md is mandatory.
/memory show
```

## The three scopes

| # | Scope | Storage | Injected |
|---|-------|---------|----------|
| 1 | **Global long-term** | markdown files under `$DSH_HOME/memories/global-long-term/` (DSH home = `$DSH_HOME` env, default `~/.dsh`) | the directory's `INDEX.md`, into **every** new session, regardless of workspace |
| 2 | **Global short-term** | one rolling note `$DSH_HOME/memories/global-short-term.md` | the note (newest entries within budget) into **every** new session |
| 3 | **Workspace** | markdown files under `<projectRoot>/.dsh/memories/` **inside the workspace itself** | that directory's `INDEX.md`, only into sessions whose workspace root matches |

### Long-term stores and INDEX.md

Each long-term store (global and workspace) is a directory of `*.md` files plus
an `INDEX.md`. **`INDEX.md` is what gets injected** — never the individual
files — so a large memory library costs the session only its index.

- If `INDEX.md` exists, it is injected as-is (hand-editable: write whatever
  index you want, including extra guidance).
- If it is absent, the plugin **synthesizes** the index at read time from the
  files: one line per file — title (first `# ` heading, else file name), file
  name, and the first non-heading line as a summary. Synthesis never writes to
  disk; injection stays read-only.
- `/memory long` and `/memory workspace` **regenerate** `INDEX.md`
  deterministically (sorted by file name, with a comment marking it as
  generated). Hand edits survive until the next regeneration.

### Global short-term memory

"What DSH is working on right now": `/memory save <text>` appends
`- [<ISO-8601 UTC timestamp>] <text>` to `$DSH_HOME/memories/global-short-term.md`.
The file is bounded (default 16384 chars): when `/memory save` would exceed the
bound, the **oldest** entries are dropped first (the newest entry is always
kept). The injection is capped to the short-term budget with an honest
truncation marker, so a bloated file still fits.

## How injection works (and why)

The plugin follows the shipped `@deepseek-ai/dsh-agent-instructions` pattern —
the mechanism behind DSH's AGENTS.md loading — verified against the installed
Harness (`agent/pre-step` waterfall event) and its extracted built source:

1. At the **first eligible `agent/pre-step`** of a session, the plugin composes
   one baseline text from the three scopes (each bounded by its own budget).
2. The text is wrapped in a plugin-owned `<system-reminder>` frame (literal
   `</system-reminder>` inside memory content is escaped, so memory text can
   never close the frame) and becomes one durable **user-role message** with a
   `dsh-memories` source, spliced into the entering messages right after the
   last claimed message. The waterfall decision is spread
   (`{ ...decision, messages }`), never rejected.
3. A visible baseline whose **identity** (budgets + root markers) matches is
   never re-injected: resume, replay, and fork reuse the message already in the
   session log, which stays the only source of truth. Edits to memory files
   apply to **new** sessions (see limitations).

Rationale for this seam over the alternatives:

- **Durable session content** (not a system-prompt section): replays, resumes,
  and forks reconstruct it from the log; it participates in compaction like
  ordinary history, and no new event *type* is ever appended.
- **KV-cache friendly**: one append-only baseline at the first request.
- **No `system-prompt/assemble` / `llm/stream` rewriting**: much weaker
  mechanism needed than those; the plugin does not own the step decision and
  always returns `next()`'s decision modulo the spliced message.

### Workspace memory storage choice

Workspace memory lives **inside the workspace** at `<projectRoot>/.dsh/memories/`
— not under `$DSH_HOME` — because it should **travel with the repository**
(like `AGENTS.md`): clone the repo elsewhere, and its memory comes along,
reviewable and versionable in git if the user chooses to commit it. `.dsh/` is
the established repo-local DSH namespace (DSH itself scans `<repo>/.dsh/skills`
for sessions opened inside a repo); no native memory seam exists in the Harness,
so a plugin-owned directory under `.dsh/` is the closest-to-native choice.
`projectRoot` is discovered exactly like the shipped AGENTS.md loader: climb
from the session working directory while the project-root marker (default
`.git`) is absent; with no marker anywhere, the session directory itself is the
root. Injection includes the workspace section only when the discovered root
actually has a `.dsh/memories/` directory with content.

### Budgets and truncation

All budgets are in characters and configurable (see below). Defaults:

| Config | Default | Meaning |
|---|---|---|
| `longTermMaxChars` | `8192` | cap for the injected global long-term index |
| `shortTermMaxChars` | `8192` | cap for the injected global short-term note (≈ 2k tokens) |
| `workspaceMaxChars` | `8192` | cap for the injected workspace index |
| `shortTermFileMaxChars` | `16384` | retention bound for the short-term *file* (oldest entries drop first) |

When a section exceeds its budget it is truncated (never splitting a surrogate
pair) and ends with an honest marker:

```
[memory truncated: showing 8192 of 14503 characters to fit the configured budget]
```

The whole baseline is one message, so the total injection is bounded by the
three budgets plus the small framing.

## The `/memory` command

| Form | Effect |
|---|---|
| `/memory save <text>` | Append a timestamped entry to the global short-term note, then trim the file to the retention bound. |
| `/memory long <title> \| <text>` | Create/update `$DSH_HOME/memories/global-long-term/<slug>.md` (`# title` heading + body) and regenerate `INDEX.md`. |
| `/memory workspace <title> \| <text>` | Same, under `<projectRoot>/.dsh/memories/`. |
| `/memory show` | Read-only: return exactly what a **new** session in the current workspace would receive. |

Notes:

- `<title> | <text>` uses the first `|` as the separator; both parts must be
  non-empty. The slug is the kebab-cased title (max 64 chars; Windows-reserved
  names are prefixed); re-running with the same title rewrites that file.
- The command is registered via `ctx.commands.register` (the
  `@deepseek-ai/dsh-commands` contract) inside `ctx.inject(['commands'], …)`,
  so the plugin stays dormant in profiles without the command surface.
  Injection itself does not depend on the command service.
- Writes happen **only** through this human command; the injection path is
  read-only, and any failure there is logged and never breaks the step.

## Install

Reviewed and installed by the Lead with the `plugin_manager` tool:

```
action: install_bundle
target: <absolute path of this repository>
```

The bundle inserts one row (`id: memories`) and needs no dependencies, install
scripts, or build tools.

## Configuration

All keys are optional (row `memories` in the bundle patch):

```yaml
- id: memories
  name: '@local/dsh-memories'
  config:
    dshHome: '~/.dsh'          # explicit DSH home override (highest precedence)
    longTermMaxChars: 8192
    shortTermMaxChars: 8192
    workspaceMaxChars: 8192
    shortTermFileMaxChars: 16384
    projectRootMarkers: ['.git']
```

DSH home precedence (mirroring the shipped `dsh-home-paths` rule): configured
`dshHome` → non-blank `$DSH_HOME` env → `~/.dsh`. A blank `$DSH_HOME` counts
as unset. Unknown config keys fail at plugin activation.

## Per-project pipeline configuration (`.factory.yml`)

This repository is built with the
[`dsh-software-factory`](../dsh-software-factory) discipline. Its `.factory.yml`
enables **only** the `plan` and `implement` phases (guardrails, test, deploy,
regression, and evaluate are off — the repo has no lint/test infrastructure;
the builder's manual verification bar replaces them) and adds per-phase prompt
overrides pointing at the design doc and the verification steps. See the
factory README's "Per-project configuration (`.factory.yml`)" section for the
format.

## Design notes

- **Contracts coded against** (inspected live / read from extracted built
  sources): `agent/pre-step` waterfall (`{ agent, messages: UserMessage[], … }`,
  `next(): Promise<PreStepDecision>`); `agent.session.header.cwd` for the
  session working directory; `agent.session.surface.nodes` + `eventAt(seq)` to
  scan visible `user/message` events; the `createUserMessage` shape
  (`{ role, content, source, id }`, deep-frozen locally — zero runtime
  dependencies); `ctx.commands.register` handler contract (frozen
  `{ commandId, agent, rawInput, attachments, signal }`, async allowed, result
  `{ kind: 'success' | 'error', text }`); `ctx.inject(['commands'], …)` optional
  service pattern; `resolveDshHome` precedence.
- **node:fs, not `ctx.fs`**: memory files live under `$DSH_HOME` (outside any
  workspace sandbox) and inside the workspace; direct reads keep injection
  working in sandboxed sessions where provider access outside the workspace
  could be denied. The shipped injector itself falls back to direct node:fs
  reads for host-path files. Injection is fail-open: errors are logged via
  `ctx.logger.warn` and the step proceeds.
- **Config schema**: `export const Config` implements the Standard Schema
  `~standard.validate` protocol that cordis `resolveConfig` calls; being
  vendor-unknown, Settings surfaces will not render a live form for it.
  Configure via the patch row (above).
- **Locale**: `locale/en.json` + `locale/zh.json` carry the Plugin Manager
  title/description. No icon is shipped; the manager falls back to its default
  artwork.

## Limitations (v1)

- **Baseline-only refresh**: memories are read once per session (first
  eligible pre-step). Edits made mid-session (including via `/memory save`)
  appear in **new** sessions; the running session keeps its injected baseline.
  The shipped AGENTS.md injector additionally refreshes on filesystem touches;
  that machinery (touch tracking, version caches, inbox reconciliation) is
  deliberately out of scope for v1.
- **Subagent sessions also receive the baseline** (each subagent runs its own
  session through the same seam), costing each its injection budget. A scope
  filter can be added if this proves wasteful.
- **Identity ignores content**: a visible baseline is kept as long as budgets
  and root markers are unchanged, even if memory files changed — same rule as
  above, applied via resume.
- **Root-discovery failures are tolerated** (treated as "marker absent"),
  rather than surfaced like the shipped loader; memory discovery must never
  break a session.
- **Single-line command input**: `/memory long`/`workspace` bodies are one
  composer line (the first `|` separates title and body); no multi-line bodies
  in v1 — edit the generated `.md` file directly for long-form memory.

## Repository layout

```
package.json        manifest: @local/dsh-memories, dsh.bundle.patch
cordis.patch.yml    insert row `memories`
index.js            Host plugin: Config schema + baseline injector + /memory command
locale/en.json      display metadata (English)
locale/zh.json      display metadata (Chinese)
README.md           this file
AGENTS.md           agent instructions for working in this repo
.factory.yml        software-factory pipeline config (plan + implement only)
```
