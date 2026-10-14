# dsh-memories

A DSH (DeepSeek Harness) plugin bundle that gives DSH a **personal memory**
with three scopes, injected into every new session together with a
**how-to-use-your-memories guide**, so memory works **automatically**: the
agent consults memories before asking the user for information it lacks, and
writes new memories itself through the **`memory` agent tool**. Humans keep
the **`/memory`** command, and the **Memories tab** in the right sidebar
shows what is stored.

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
| 3 | **Workspace** | markdown files under `$DSH_HOME/memories/workspace/<workspacename>/` (one directory per workspace) | that directory's `INDEX.md`, only into sessions whose workspace root matches |

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
- `/memory long` and `/memory workspace` — and the agent tool's `long` /
  `workspace` actions — **regenerate** `INDEX.md` deterministically (sorted by
  file name, with a comment marking it as generated). Hand edits survive until
  the next regeneration.

### Global short-term memory

"What DSH is working on right now": `/memory save <text>` and the tool's
`save` action append `- [<ISO-8601 UTC timestamp>] <text>` to
`$DSH_HOME/memories/global-short-term.md`. The file is bounded (default 16384
chars): when a write would exceed the bound, the **oldest** entries are
dropped first (the newest entry is always kept). The injection is capped to
the short-term budget with an honest truncation marker.

## Automatic memory use (the injected guide)

Every new session's baseline **always** begins with a guidance section — even
when no memories exist yet — that tells the model:

- what the three scopes are, what each is for, and exactly where the files
  live (resolved absolute paths for this session);
- **check memory before asking**: consult the injected indexes, read the named
  files with its file tools for details, and only ask the user when memory
  does not answer the question;
- **write memory when it learns something durable**, and which scope fits:
  cross-project facts about the user → `long`; "where work stands / pickup
  notes" → `save`; repo-local knowledge → `workspace`;
- keep entries concise and factual, never store secrets, and prefer `save`
  when unsure (it ages out).

The guide's write path mirrors what is actually registered: when the
`tools` service is available the guide points at the `memory` tool; otherwise
it falls back to asking the user to run `/memory`.

## How injection works (and why)

The plugin follows the shipped `@deepseek-ai/dsh-agent-instructions` pattern —
the mechanism behind DSH's AGENTS.md loading — verified against the installed
Harness (`agent/pre-step` waterfall event) and its extracted built source:

1. At the **first eligible `agent/pre-step`** of a session, the plugin composes
   one baseline text from the guidance plus the three scopes (each bounded by
   its own budget).
2. The text is wrapped in a plugin-owned `<system-reminder>` frame (literal
   `</system-reminder>` inside memory content is escaped, so memory text can
   never close the frame) and becomes one durable **user-role message** with a
   `dsh-memories` source, spliced into the entering messages right after the
   last claimed message. The waterfall decision is spread
   (`{ ...decision, messages }`), never rejected.
3. A visible baseline whose **identity** (budgets + root markers) matches is
   never re-injected: resume, replay, and fork reuse the message already in
   the session log, which stays the only source of truth. Edits to memory files
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

Workspace memory lives **under the DSH home**, one directory per workspace:

```
$DSH_HOME/memories/workspace/<workspacename>/
```

`<workspacename>` is the **registered workspace title** when the session's
project root resolves to a registered workspace (via the optional
`workspaceRegistry` service), else the root directory's name. The name is
slugified (Unicode letters/digits kept, lowercased, hyphen-joined, max 64,
Windows-reserved-safe; an empty slug falls back to a short stable hash of the
root path) — so `My Custom WS!` → `my-custom-ws`, and a CJK-titled workspace
keeps its characters. `projectRoot` is discovered exactly like the shipped
AGENTS.md loader: climb from the session working directory while the
project-root marker (default `.git`) is absent; with no marker anywhere, the
session directory itself is the root. Injection includes the workspace
section only when that workspace's memory directory actually has content.

Notes and trade-offs of the centralized layout (a deliberate v0.5.0 change,
replacing the original `<projectRoot>/.dsh/memories/` placement):

- All workspace memories live in one place next to the global scopes —
  uniform backup/cleanup, and nothing is written inside your repositories.
- The memory does **not** travel with a cloned repository anymore; renaming
  a workspace changes its directory name (the old directory stays where it
  was until you move it).
- **No automatic migration**: stores written by ≤0.4.x at
  `<projectRoot>/.dsh/memories/` remain there, ignored; move the `*.md`
  files into the new directory (or re-save them with `/memory workspace` /
  the `memory` tool) to carry them over.

### Budgets and truncation

All budgets are in characters and configurable (see below). Defaults:

| Config | Default | Meaning |
|---|---|---|
| `longTermMaxChars` | `8192` | cap for the injected global long-term index |
| `shortTermMaxChars` | `8192` | cap for the injected global short-term note (≈ 2k tokens) |
| `workspaceMaxChars` | `8192` | cap for the injected workspace index |
| `shortTermFileMaxChars` | `16384` | retention bound for the short-term *file* (oldest entries drop first) |

The guidance section is plugin-owned constant text and is not budget-capped.
When a memory section exceeds its budget it is truncated (never splitting a
surrogate pair) and ends with an honest marker:

```
[memory truncated: showing 8192 of 14503 characters to fit the configured budget]
```

## Writing memories: `/memory` command and `memory` tool

Two surfaces share one code path (same files, same INDEX.md regeneration):

| Action | `/memory` (human) | `memory` tool (agent) |
|---|---|---|
| short-term note | `/memory save <text>` | `{ action: 'save', text }` |
| global long-term file | `/memory long <title> \| <text>` | `{ action: 'long', title, text }` |
| workspace file | `/memory workspace <title> \| <text>` | `{ action: 'workspace', title, text }` |
| preview baseline | `/memory show` | — (read the injected baseline / memory files) |

- The command is registered via `ctx.commands.register` inside
  `ctx.inject(['commands'], …)` (human-only by the dsh-commands contract).
- The tool is registered via `ctx.tools.register` inside
  `ctx.inject(['tools'], …)` with a raw JSON-Schema definition (enforced
  subset: `type`/`properties`/`required`/`additionalProperties`/`items`/
  `enum`), `output: { schema, render }`, and an async `execute(args, exec)`
  that resolves the session cwd from `exec.agent.session.header.cwd`. A thrown
  error settles as a tool error result; invalid arguments are rejected inside
  `execute` with a usage message.
- Neither surface is required for injection to work; each injected fiber is
  fail-soft, and a missing service parks the plugin instead of throwing.

## The Memories tab (right sidebar)

The browser half (`client.js`, exported as `./client`, declared through
`dsh.client` in `package.json`) contributes one **page-type tab** to the
right sidebar, registered with `ctx.sidebarRightTabs` (kind `memories`, with
a guide entry so it is reachable from the guide page) whose body renders
under the keyed `sidebar.right.pane.tab` slot. Both of its views scroll
(`height:100%; overflow-y:auto; overflow-x:hidden`), exactly as wide as the
sidebar pane (`width:100%` + `min-width:0` on every container, so long paths
wrap instead of stretching), so long lists and long memories stay readable.

**List view (first page)** — one compact row per memory, no full content
inline:

- **Short-term memory** — ONE expandable block, not a detail page: the card
  header ("Short-term memory · N entries · size", with a ▸/▾ chevron)
  toggles the whole rolling note inline. No content title.
- **Global long-term memory** — one row per file (title, first-line summary,
  name/size).
- **This workspace** — the workspace store of **the session the tab belongs
  to — and only that workspace**. The tab body receives its Session id
  through the slot registration's business share
  (`inject: (sessionId) => ({ sessionId })`), passes it to the Host as
  `?session=<id>`, and the Host resolves that session's working directory →
  project root → that workspace's memory directory under
  `$DSH_HOME/memories/workspace/`. No other workspace ever appears; when the
  session's workspace has no memories (or the session cannot be resolved on
  the Host), the section says so honestly.

**Detail view** — selecting a long-term or workspace row opens the memory's
**complete markdown content** on a detail page with a back control (the
short-term note never navigates — it expands in place). Every block is hard
width-clamped to its parent card (`min-width:0; max-width:100%`), so the UI
tracks the sidebar pane's width exactly.

Data comes from two read-only JSON endpoints the Host half serves on exact
`webServer` routes:

- `GET /memories/snapshot.json[?session=<id>]` — the list data (v2 shape:
  the full short-term note content, long-term/workspace file rows,
  `sessionResolved` honesty flag).
- `GET /memories/file.json?scope=long|workspace&name=<file>[&session=<id>]`
  — one memory file's full content. The request is validated (scope enum;
  `name` must be a plain `*.md` base name — no separators, drives, or
  traversal) and bounded by the source-read cap; `workspace` reads the
  requesting session's workspace only. Unknown or unsafe requests get a 404
  JSON error.

The tab fetches with `cache: 'no-store'` and has a Refresh button on the
list view; styles are component-local and use only `--dsw-alias-*` theme
tokens, so light and dark themes both render correctly. No Harness client
package is imported. (This list→detail model replaces v1's "index and
locations only" display rule: detail pages now show full file content by
explicit user decision.)

## Install

Reviewed and installed by the Lead with the `plugin_manager` tool:

```
action: install_bundle
target: <absolute path of this repository>
```

The bundle inserts one row (`id: memories`) and needs no dependencies, install
scripts, or build tools. Replacing an installed package requires a DSH restart
to load a fresh module generation; client bundles additionally require the
page to reload.

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
  sources of the installed Harness): `agent/pre-step` waterfall (`{ agent,
  messages: UserMessage[], … }`, `next(): Promise<PreStepDecision>`); the
  spread-not-reject rule for non-owning listeners; `agent.session.header.cwd`;
  `agent.session.surface.nodes` + `eventAt(seq)` to scan visible
  `user/message` events; the `createUserMessage` shape (`{ role, content,
  source, id }`, deep-frozen locally — zero runtime dependencies);
  `ctx.commands.register` handler contract (frozen `{ commandId, agent,
  rawInput, attachments, signal }`, result `{ kind: 'success' | 'error',
  text }`); `ctx.inject([...], …)` optional-service pattern; dsh-commands is
  human-only (no LLM dispatch mode — the agent tool is the model-facing
  surface); `ctx.tools.register` ToolDefinition (`name` never `run_code`,
  raw-subset `parameters`, `output: { schema, render(args, value) }` with
  render validated, async `execute(args, exec)` returning lossless JSON,
  `exec.agent` + `exec.signal`); `ctx.webServer.register({ kind, path,
  handler(req, res) })` exact/prefix route tables (dsh-host-webserver);
  `ctx.agents.get(sessionId)` → live Agent with
  `agent.session.header.cwd` (the snapshot route resolves the requesting
  tab's session to its workspace); `resolveDshHome` precedence. Client
  half: `window.__ModuleLoader__.load({ id, factory(require) })` with
  `require('react')` from the platform module table; plugin form
  `{ inject: ['slots', 'sidebarRightTabs'], apply(ctx) }`;
  `ctx.sidebarRightTabs.register({ id, kind, title, guide? })` page-tab
  types (omitted `priority` = the default `extension` band);
  `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
  { name, key: type id, inject: (sessionId, actions) => props }, Body))`
  tab bodies whose business share receives the Session id
  (ui-sidebar-documentpreview is the live proof for all three);
  component-local styles with `--dsw-alias-*` tokens only; no imports of
  Harness client packages.
- **node:fs, not `ctx.fs`**: memory files live under `$DSH_HOME` (outside any
  workspace sandbox) and inside the workspace; direct reads keep injection
  working in sandboxed sessions where provider access outside the workspace
  could be denied. Injection is fail-open: errors are logged via
  `ctx.logger.warn` and the step proceeds.
- **Config schema**: `export const Config` implements the Standard Schema
  `~standard.validate` protocol that cordis `resolveConfig` calls; being
  vendor-unknown, Settings surfaces will not render a live form for it.
  Configure via the patch row (above).
- **Locale**: `locale/en.json` + `locale/zh.json` carry the Plugin Manager
  title/description. Panel strings are English-only in v1 (see limitations).

## Limitations (v2)

- **Baseline-only refresh**: memories are read once per session (first
  eligible pre-step). Edits made mid-session (including via `/memory save` or
  the tool) appear in **new** sessions; the running session keeps its injected
  baseline.
- **Subagent sessions also receive the baseline** (each subagent runs its own
  session through the same seam), costing each its injection budget. A scope
  filter can be added if this proves wasteful.
- **Identity ignores content**: a visible baseline is kept as long as budgets
  and root markers are unchanged, even if memory files or the registered
  write path changed — same rule as above, applied via resume.
- **Tab is read-only and English-only**; the snapshot route is unauthenticated
  exactly like the rest of the web GUI's loopback surface, and the tab does
  not auto-refresh (Refresh re-fetches with `no-store`). The workspace
  section resolves through the live `agents` service, so a session that is
  no longer live shows the honest "could not resolve this session" note
  instead of its workspace. Under an Electron `file://` shell the relative
  snapshot fetch may not resolve; the tab shows the fetch error rather than
  guessing.
- **Single-line command input**: `/memory long`/`workspace` bodies are one
  composer line (the first `|` separates title and body); the agent tool has
  no such limit. For long-form human input, edit the generated `.md` directly.

## Repository layout

```
package.json        manifest: @local/dsh-memories, dsh.bundle.patch + dsh.client
cordis.patch.yml    insert row `memories`
index.js            Host plugin entry: composition root (wiring + public re-exports)
lib/                Host modules:
  lib/config.js       config validation + Standard-Schema `Config`
  lib/paths.js        DSH-home precedence, project-root climb, workspace store resolution
  lib/fs.js           tiny fail-open filesystem helpers
  lib/store.js        on-disk memory model (index/files) + writers
  lib/baseline.js     guidance + baseline text + durable baseline message
  lib/surfaces.js     /memory command + agent memory tool
  lib/snapshot.js     read-only JSON payloads for the Memories tab
  lib/routes.js       the two read-only webServer routes
client.js           Client plugin: Memories right-sidebar tab (session-scoped); one
                    module by loader constraint (the module system serves a single
                    bundle per package; package-local chunks are async-only)
locale/en.json      display metadata (English)
locale/zh.json      display metadata (Chinese)
README.md           this file
AGENTS.md           agent instructions for working in this repo
.factory.yml        software-factory pipeline config (plan + implement only)
```
