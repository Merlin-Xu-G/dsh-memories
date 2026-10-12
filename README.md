# dsh-memories

A DSH (DeepSeek Harness) plugin bundle that gives DSH a **personal memory**
with three scopes, injected into every new session together with a
**how-to-use-your-memories guide**, so memory works **automatically**: the
agent consults memories before asking the user for information it lacks, and
writes new memories itself through the **`memory` agent tool**. Humans keep
the **`/memory`** command, and the **Memories web panel** shows what is
stored.

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

## The Memories web panel

The browser half (`client.js`, exported as `./client`, declared through
`dsh.client` in `package.json`) adds a **Memories** icon to the sidebar panel
list and a keyed `main` panel page:

- **Global short-term memory** is rendered in **full** (path, size, newest
  entries last).
- **Global long-term** and **workspace** stores render **only the file index**
  (the INDEX.md text, or the synthesized index) **and file locations** (file
  name, title/summary, size, directory). File bodies are deliberately not
  shown.
- Workspace sections appear per registered workspace that actually has a
  `.dsh/memories/` directory with content.

Data comes from a read-only JSON snapshot the Host half serves at the exact
`webServer` route `GET /memories/snapshot.json` (registered inside
`ctx.inject(['webServer'], …)`; workspace roots come from the optional
`workspaceRegistry` service). The panel fetches with `cache: 'no-store'` and
has a Refresh button; styles are component-local and use only
`--dsw-alias-*` theme tokens, so light and dark themes both render correctly.
No Harness client package is imported.

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
  `ctx.workspaceRegistry.list()` → `Workspace[]` with `.path`/`.title`;
  `resolveDshHome` precedence. Client half: `window.__ModuleLoader__.load({
  id, factory(require) })` with `require('react')` from the platform module
  table; plugin form `{ inject: ['slots'], apply(ctx) }`;
  `ctx.slots.inject(key, () => ctx.slots.register(opts, Component))` with
  list-slot `{ name, id, order, label }` and keyed-slot `{ name, key }`
  options; component-local styles with `--dsw-alias-*` tokens only; no
  imports of Harness client packages.
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
- **Panel is read-only and English-only**; the snapshot route is unauthenticated
  exactly like the rest of the web GUI's loopback surface, and the panel does
  not auto-refresh (Refresh re-fetches with `no-store`). Under an Electron
  `file://` shell the relative snapshot fetch may not resolve; the panel shows
  the fetch error rather than guessing.
- **Single-line command input**: `/memory long`/`workspace` bodies are one
  composer line (the first `|` separates title and body); the agent tool has
  no such limit. For long-form human input, edit the generated `.md` directly.

## Repository layout

```
package.json        manifest: @local/dsh-memories, dsh.bundle.patch + dsh.client
cordis.patch.yml    insert row `memories`
index.js            Host plugin: Config schema + baseline injector + /memory command + memory tool + snapshot route
client.js           Client plugin: Memories sidebar panel page
locale/en.json      display metadata (English)
locale/zh.json      display metadata (Chinese)
README.md           this file
AGENTS.md           agent instructions for working in this repo
.factory.yml        software-factory pipeline config (plan + implement only)
```
