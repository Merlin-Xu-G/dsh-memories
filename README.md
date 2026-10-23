# dsh-memories

A DSH (DeepSeek Harness) plugin bundle that gives DSH a **personal memory**
with three scopes, injected into every new session together with a
**how-to-use-your-memories guide** that makes capture **automatic**: the user
never curates memories — the agent consults memories before asking the user
for information it lacks, and writes memories itself, unprompted, through the
**`memory` agent tool**, the moment the user corrects it, a topic comes back,
or the work reveals durable facts. Humans keep the **`/memory`** command, and
the **Memories tab** in the right sidebar shows what is stored.

```
/memory save finished the migration notes, pickup: verify indexes tomorrow
/memory long Terraform conventions | When to use -target; where modules live. | Use -target only in emergencies; modules live under infra/modules.
/memory workspace Release process | Build, test, tag; CHANGELOG is mandatory. | pnpm build && pnpm test, then tag vx.y.z — CHANGELOG.md is mandatory.
/memory show
```

## Compatibility

- Minimum DSH: `>=0.2.0-rc.2` — declared in `package.json` → `engines.dsh`. DSH enforces this floor at install/activation and matches prerelease versions, so it never blocks a newer DSH.
- Latest tested DSH: `0.2.1-rc.2` — recorded in `package.json` → `dsh.latestTestedDshVersion`. Descriptive only; DSH does not enforce it.
- **0.8.1 prompt change**: the injected guidance now drives **automatic long-term/workspace capture** — the user never curates memories, so the agent writes durable memories itself, unprompted (user corrections and preferences immediately, repeated discussions/decisions, wrap-up durable facts), routed project-specific → `workspace` and cross-project → `long`, de-duplicated against the injected index, with `save` rebalanced to transient pickup notes. Prompt-only: no config keys and no mechanics changed.
- **0.8.0 config change**: the long-term and workspace **injection caps are removed** — `longTermMaxChars` and `workspaceMaxChars` are gone (indexes are injected whole); configs that still set either fail at activation as unknown keys, the same honest-break pattern as every removed key before it.
- **0.7.0 config change**: `shortTermMemoriesCap` (default 10000) is the write-time cap for the short-term note; `shortTermMaxChars` (the 0.6.x name) is a deprecated alias (setting both is an error).

## The three scopes

| # | Scope | Storage | Injected |
|---|-------|---------|----------|
| 1 | **Global long-term** | markdown files under `$DSH_HOME/memories/global-long-term/` (DSH home = `$DSH_HOME` env, default `~/.dsh`) | the directory's name+description index, **whole**, into **every** new session, regardless of workspace |
| 2 | **Global short-term** | one rolling note `$DSH_HOME/memories/global-short-term.md` | the **whole note** (injected in full — the cap lives in the write path, not here) into **every** new session |
| 3 | **Workspace** | markdown files under `$DSH_HOME/memories/workspace/<workspacename>/` (one directory per workspace) | that directory's name+description index, **whole**, only into sessions whose workspace root matches |

### Long-term stores, the Description convention, and INDEX.md

Each long-term store (global and workspace) is a directory of `*.md` files
plus an `INDEX.md`. **The index is what gets injected** — never the
individual files — so a large memory library costs the session only its
index. Since 0.8.0 there are **no injection caps**: the index is injected
whole, however large it grows.

- Every memory file carries an explicit **`Description: <one line>`** line
  right after its `# Title` heading (blank line in between is fine). The
  write surfaces create it from the description you give; you can also add
  it by hand to existing files.
- The index lists exactly the files that have one, one line each:

  ```
  - Title (file-name.md) — description
  ```

- **Files without a `Description:` line right after the heading are not
  listed** — no first-line fallback, no placeholder. They still exist on
  disk and in the Memories tab; they just never appear in an index.
- A description is **one line of at most 1000 characters**. The write
  surfaces (`/memory` and the `memory` tool) **reject** longer or
  multi-line descriptions outright; the generation script and the
  read-only synthesis instead **truncate** an over-long description in the
  index to 1000 characters with an honest `…` ellipsis — the file itself is
  never touched.
- **The plugin NEVER writes `INDEX.md`.** The only writer is the repo
  script `scripts/generate-index.mjs` (see below), and it regenerates
  **only the index of the workspace you run it in** — the global long-term
  store has no generated file by design. When `INDEX.md` exists, the
  plugin injects it **as-is** (hand-editable, though the script overwrites
  hand edits on the next run). When it is absent, the plugin
  **synthesizes** the exact same document read-only in memory at injection
  time — nothing is written to disk, and freshly written memories are
  visible to new sessions either way: **the automatic memory is the core
  feature and needs no `INDEX.md` at all**.
- `/memory long`, `/memory workspace`, and the tool's `long`/`workspace`
  actions write **only the memory file**. They neither touch nor mention
  the index; regenerating `INDEX.md` is always an explicit `node
  scripts/generate-index.mjs` (run from inside the workspace) away.

### scripts/generate-index.mjs (the only INDEX.md writer)

```
node scripts/generate-index.mjs [--home <path>]
```

A dependency-free Node script (`node:*` builtins + the plugin's own `lib/`
modules only) and deliberately parameter-free: it processes **only the
memories of the workspace you run it in**. The workspace is derived from
the current directory exactly the way the plugin derives a session's
workspace: climb to the project root (default marker `.git`), take the
root directory's name, slugify it (registered workspace titles live in a
Host service the script cannot see — it uses the directory name, the
plugin's no-registry fallback), then regenerate that store's `INDEX.md`
when it has memory files, reporting what it did. There is no `--check`
mode and no scoping parameter; `--home` still overrides the DSH home
(`--home` ?? non-blank `$DSH_HOME` ?? `~/.dsh`, the plugin's rule). Run it
from wherever your project is — the absolute path to the script works from
any workspace. The **global long-term** store has no generator by design:
keep it file-free and let every session compose its index read-only (a
stale global `INDEX.md` would be injected stale forever — delete it if one
exists). Entries are sorted by file name and clamped to the 1000-char
description ceiling. A `generate-index` entry in `package.json` →
`scripts` aliases it (`npm run generate-index` runs in the checkout's own
workspace).

### Global short-term memory

"What DSH is working on right now": `/memory save <text>` and the tool's
`save` action append `- [<YYYY-MM-DD>] <text>` (local date only — the time
of day belongs in the entry text, and only when it matters) to
`$DSH_HOME/memories/global-short-term.md`. The note is injected **in full**
into every new session: no character calculation, no truncation marker, no
ceiling — not even for a pathologically large hand-edited file. It is the
home of **transient pickup notes** ("where work stands"); durable knowledge
belongs in a long/workspace memory file, and the injected guide says so.

The cap lives entirely in the write path: `shortTermMemoriesCap` (default
10000 chars). A save is a **pure append** — entries are never dropped or
rejected mechanically. When a save leaves the note over the cap, the write
result directs the agent to **compact** it: the tool's `compact` action
rewrites the note with an LLM-authored version — the agent decides entry by
entry which entries stay verbatim, which fold into dated summary entries,
and which finished threads drop, judging each entry's usefulness from its
text and dates — validated to be strictly shorter than what was there. There
is deliberately **no mechanical backstop**: if agents repeatedly ignore the
compaction prompt, the note (and therefore every new session's baseline)
grows without bound.

## Automatic memory use (the injected guide)

Every new session's baseline **always** begins with a guidance section — even
when no memories exist yet — and since 0.8.1 that guide makes capture the
agent's own job: **the user never curates memories and will not run the
memory command for the agent.** The guide tells the model:

- what the three scopes are, what each is for, and exactly where the files
  live (resolved absolute paths for this session);
- the index convention: entries are `Title (file-name.md) — description`,
  sourced from each file's `Description:` line right after its heading — so
  the model knows to **give every long/workspace memory a description**;
- **check memory before asking**: consult the injected indexes, read the named
  files with its file tools for details, and only ask the user when memory
  does not answer the question;
- **write memories itself, unprompted, without asking permission, as things
  arise during the session** — not only at the end — driven by three
  triggers:
  - **user corrections and preferences** (highest priority): the moment the
    user corrects the agent, states a style/rule/preference, or overrides a
    default, it is captured immediately as a memory file;
  - **repeated discussions and decisions**: a topic or design question coming
    up a second time, or a discussion settling a decision with rationale,
    writes or updates a topic file so the next session starts from it
    instead of re-deriving;
  - **wrap-up knowledge**: durable facts the work revealed (how this project
    builds/tests/works, environment facts, tool contracts) are written before
    the work is declared done;
- **which scope**, with corrections routed the same way: knowledge specific
  to this project (conventions, commands, layout, design decisions) →
  `workspace`; knowledge that crosses projects (the user's workflow
  preferences, machine/environment facts, general tool knowledge) → `long`;
  transient "where work stands / pickup notes" → `save`;
- **de-duplication**: before writing, the model checks the injected index —
  when a file already covers the topic it updates that file (keeping its
  title and file name) instead of creating a near-duplicate; one topic per
  file, focused and concise, always with a one-line description;
- `save` is for **transient pickup notes only** — durable knowledge goes into
  the durable file NOW, not into the rolling note to age out; only genuine
  uncertainty defaults to `save`;
- keep entries concise and factual, never store secrets, and mention durable
  writes briefly in the reply ("saved this preference to long-term memory").

The guide's write path mirrors what is actually registered: when the
`tools` service is available the guide points at the `memory` tool; otherwise
it falls back to asking the user to run `/memory`.

## How injection works (and why)

The plugin follows the shipped `@deepseek-ai/dsh-agent-instructions` pattern —
the mechanism behind DSH's AGENTS.md loading — verified against the installed
Harness (`agent/pre-step` waterfall event) and its extracted built source:

1. At the **first eligible `agent/pre-step`** of a session, the plugin composes
   one baseline text from the guidance plus the three scopes (the long-term
   and workspace indexes injected **whole** — no budgets, no truncation
   markers; the short-term note injected in full).
2. The text is wrapped in a plugin-owned `<system-reminder>` frame (literal
   `</system-reminder>` inside memory content is escaped, so memory text can
   never close the frame) and becomes one durable **user-role message** with a
   `dsh-memories` source, spliced into the entering messages right after the
   last claimed message. The waterfall decision is spread
   (`{ ...decision, messages }`), never rejected.
3. A visible baseline whose **identity** (root markers + short-term cap)
   matches is never re-injected: resume, replay, and fork reuse the message
   already in the session log, which stays the only source of truth. Edits to
   memory files apply to **new** sessions (see limitations).

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

### Caps

Only one cap remains, and it is a **write-path** cap:

| Config | Default | Meaning |
|---|---|---|
| `shortTermMemoriesCap` | `10000` | write-time cap for the short-term note: an over-cap save prompts LLM compaction (no injection cap — the note is injected whole) |

Plus the fixed (non-configurable) **1000-character ceiling for memory
descriptions**, enforced on every surface: write surfaces reject longer or
multi-line descriptions; the generation script and the read-only synthesis
truncate longer ones in the index with an honest `…` ellipsis and leave the
file untouched.

`shortTermMaxChars` (the 0.6.x name) is accepted as a **deprecated alias**
of `shortTermMemoriesCap`; setting both is an activation error. The 0.7.x
injection budgets `longTermMaxChars` and `workspaceMaxChars` are **removed**
— configs that still set them fail at activation as unknown keys (no silent
behavior change). Every injected section — long-term index, workspace index,
short-term note — is now injected **whole**.

## Writing memories: `/memory` command and `memory` tool

Two surfaces share one code path (same files, same validation):

| Action | `/memory` (human) | `memory` tool (agent) |
|---|---|---|
| short-term note | `/memory save <text>` | `{ action: 'save', text }` |
| compact the short-term note | — | `{ action: 'compact', text }` |
| global long-term file | `/memory long <title> \| <description> \| <text>` | `{ action: 'long', title, description, text }` |
| workspace file | `/memory workspace <title> \| <description> \| <text>` | `{ action: 'workspace', title, description, text }` |
| preview baseline | `/memory show` | — (read the injected baseline / memory files) |

- `description` is **optional**: one line, at most 1000 characters, no line
  breaks. It becomes the file's `Description:` line right after the heading
  and the index entry other sessions discover the memory by — always give
  one unless you deliberately want the file out of the index. On update,
  omitting it **keeps** the file's existing Description line (a write never
  silently de-indexes a memory).
- In the command, the **first two `|`** separate title and description; any
  further `|` belongs to the text. The description may be left empty
  (`/memory long Title | | text`).
- Both surfaces write **only the memory file** — never `INDEX.md`, and the
  result message deliberately says nothing about the index.
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
- **Global long-term memory** — one row per file (title, description,
  name/size). Files without a `Description:` line show an empty description
  but are still listed.
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

- `GET /memories/snapshot.json[?session=<id>]` — the list data (v3 shape:
  the full short-term note content, long-term/workspace file rows with
  title + description, the full index document, `sessionResolved` honesty
  flag).
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
    dshHome: '~/.dsh'            # explicit DSH home override (highest precedence)
    shortTermMemoriesCap: 10000  # write-time cap (over-cap saves prompt compaction)
    projectRootMarkers: ['.git']
```

DSH home precedence (mirroring the shipped `dsh-home-paths` rule): configured
`dshHome` → non-blank `$DSH_HOME` env → `~/.dsh`. A blank `$DSH_HOME` counts
as unset. Unknown config keys fail at plugin activation.

## Per-project pipeline configuration (`.factory.yml`)

This repository is built with the
[`dsh-software-factory`](../dsh-software-factory) discipline. Its `.factory.yml`
enables **only** the `plan` and `implement` phases (guardrails, test, deploy,
regression, and evaluate are off — the repo's own `node --test` suite plus the
builder's manual verification bar replace them) and adds per-phase prompt
overrides pointing at the verification steps. See the factory README's
"Per-project configuration (`.factory.yml`)" section for the format.

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
- **One index composer, two consumers**: `lib/store.js` exports
  `composeIndexDocument` — the single place the index document exists.
  `scripts/generate-index.mjs` writes it to `INDEX.md`; the injection
  fallback composes the identical document in memory. The script imports
  the plugin's own `lib/` modules, so the on-disk artifact and the
  synthesized text can never drift apart.
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

## Limitations (v3)

- **No mechanical bound on the short-term note**: the cap prompts LLM
  compaction only; nothing is ever dropped or rejected automatically. If
  agents repeatedly ignore the prompt, the note — and with it every new
  session's injected baseline — grows without bound. Since 0.8.0 the same
  holds for the long-term and workspace indexes: they are injected whole,
  so an ever-growing memory library grows the baseline without bound too —
  the guide's de-duplication rule (update the existing file, never
  near-duplicate) and one-line descriptions are what keep the library lean.
- **A stale INDEX.md is injected stale**: when `INDEX.md` exists, the plugin
  injects it as-is; writes never update it. The script refreshes only the
  workspace it is run in, so the global store should simply stay file-free —
  delete a stale global INDEX.md rather than keeping it (or delete any
  INDEX.md and let every session compose the index fresh from the files).
- **Baseline-only refresh**: memories are read once per session (first
  eligible pre-step). Edits made mid-session (including via `/memory save` or
  the tool) appear in **new** sessions; the running session keeps its injected
  baseline.
- **Subagent sessions also receive the baseline** (each subagent runs its own
  session through the same seam), costing each the full baseline. A scope
  filter can be added if this proves wasteful.
- **Identity ignores content**: a visible baseline is kept as long as the
  config identity (root markers + short-term cap) is unchanged, even if
  memory files or the registered write path changed — same rule as above,
  applied via resume.
- **Tab is read-only and English-only**; the snapshot route is unauthenticated
  exactly like the rest of the web GUI's loopback surface, and the tab does
  not auto-refresh (Refresh re-fetches with `no-store`). The workspace
  section resolves through the live `agents` service, so a session that is
  no longer live shows the honest "could not resolve this session" note
  instead of its workspace. Under an Electron `file://` shell the relative
  snapshot fetch may not resolve; the tab shows the fetch error rather than
  guessing.
- **Single-line command input**: `/memory long`/`workspace` bodies are one
  composer line (the first two `|` separate title and description; further
  `|` belong to the text); the agent tool has no such limit. For long-form
  human input, edit the generated `.md` directly.

## Repository layout

```
package.json        manifest: @local/dsh-memories, dsh.bundle.patch + dsh.client
cordis.patch.yml    insert row `memories`
index.js            Host plugin entry: composition root (wiring + public re-exports)
lib/                Host modules:
  lib/config.js       config validation + Standard-Schema `Config`
  lib/paths.js        DSH-home precedence, project-root climb, workspace store resolution
  lib/fs.js           tiny fail-open filesystem helpers
  lib/store.js        on-disk memory model (description parsing + index composition) + writers
  lib/baseline.js     guidance + baseline text + durable baseline message
  lib/surfaces.js     /memory command + agent memory tool
  lib/snapshot.js     read-only JSON payloads for the Memories tab
  lib/routes.js       the two read-only webServer routes
scripts/
  scripts/generate-index.mjs  the only INDEX.md writer (regenerates the current workspace's store)
client.js           Client plugin: Memories right-sidebar tab (session-scoped); one
                    module by loader constraint (the module system serves a single
                    bundle per package; package-local chunks are async-only)
locale/en.json      display metadata (English)
locale/zh.json      display metadata (Chinese)
README.md           this file
AGENTS.md           agent instructions for working in this repo
.factory.yml        software-factory pipeline config (plan + implement only)
```
