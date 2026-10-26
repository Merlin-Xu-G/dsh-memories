# AGENTS.md

## What this repo is

`dsh-memories` is a DSH (DeepSeek Harness) plugin bundle
(`@local/dsh-memories`) providing a personal memory mechanism with three
scopes: **global long-term** (file library + injected name+description index
under `$DSH_HOME/memories/global-long-term/`), **global short-term** (rolling
note `$DSH_HOME/memories/global-short-term.md` — injected **in full** into
every new session; its `shortTermMemoriesCap` applies in the write path only,
where an over-cap save prompts LLM-driven compaction with no mechanical
backstop), and **workspace** (the same long-term mechanism scoped to the
current workspace, stored centrally at
`$DSH_HOME/memories/workspace/<workspacename>/` — the registered workspace
title when resolvable, else the root directory's name — injected only for
sessions in that workspace). Since 0.8.0 the long-term and workspace indexes
are injected **whole** — no per-scope caps (`longTermMaxChars` /
`workspaceMaxChars` are removed; stale configs fail at activation as unknown
keys). Every memory file carries an explicit one-line `Description:` right
after its `# Title` heading; index entries are
`- Title (file-name.md) — description`, and files without a Description line
are simply not listed. Every index is **composed fresh in memory** from the
files at session start — no index file is ever read or written (since 0.9.0
there is no `INDEX.md` mechanism at all, and a stray `INDEX.md` in a store
is treated like any other `.md`). Injection happens as one durable
user-role baseline message spliced at the first eligible `agent/pre-step` —
the same seam the shipped `@deepseek-ai/dsh-agent-instructions` uses for
AGENTS.md loading. The baseline **always** carries a "your memory system"
guidance section — three scopes, check-memory-before-asking-the-user, and
since 0.8.1 the automatic-capture rules: the user never curates memories, so
the agent itself writes durable memories unprompted, as things arise during
the session (user corrections and preferences immediately, repeated
discussions/decisions, wrap-up durable facts), routed project-specific →
workspace and cross-project → long, de-duplicated against the injected index
(update the existing file rather than near-duplicate), with `save` reserved
for transient pickup notes and a brief inline mention on durable writes — so
memory works automatically even with an empty store. Writing goes through three surfaces sharing one code path:
the `/memory` human command (save | long | workspace | show; long and
workspace take `<title> | <description> | <text>`), the agent `memory` tool
(`ctx.tools.register`, optional `description` argument), and the read-only
web UI endpoints; write surfaces reject descriptions over 1000 chars or with
line breaks, and their result messages say nothing about the index. The
**Memories tab** (browser half, right sidebar) shows a compact list of all
memories first and each item's full content on a detail page; its workspace
section covers only the workspace of the session the tab belongs to.

## Layout

```
package.json        manifest (@local/dsh-memories, dsh.bundle.patch + dsh.client)
cordis.patch.yml    loader patch: insert row id `memories`
index.js            Host plugin entry (composition root: wiring + public re-exports)
lib/                Host modules:
  lib/config.js       config validation + Standard-Schema `Config`
  lib/paths.js        DSH-home precedence, project-root climb, workspace store resolution
  lib/fs.js           tiny fail-open filesystem helpers
  lib/store.js        on-disk memory model (description parsing + index composition) + writers
  lib/baseline.js     guidance + baseline text + durable baseline message
  lib/surfaces.js     /memory command + agent memory tool
  lib/snapshot.js     read-only JSON payloads for the Memories tab
  lib/routes.js       the two read-only webServer routes
client.js           Client plugin (Memories right-sidebar tab, session-scoped; ./client export — one module by loader constraint)
locale/en.json      Plugin Manager display metadata (English)
locale/zh.json      Plugin Manager display metadata (Chinese)
README.md           full design + usage documentation
.factory.yml        software-factory pipeline config (plan + implement only)
```

## Conventions for agents working here

- **Verification bar** (quote real outputs when reporting): `node --check`
  (or an import check) on every changed `.js`/`.mjs` file, `JSON.parse` on
  every changed `.json` file, the `node --test test/*.test.mjs` suite green,
  a real directory listing of the deliverables, a machine-path scan (the
  user name, the workspace root, and the profile root must not appear as
  path literals in tracked files), and — for injection-affecting changes —
  a dry-run smoke of the exported `composeBaselineText`/
  `buildMemoriesSnapshot` against a temporary DSH home.
- **Commits**: by default the user/Lead reviews and commits. Exception: a
  queued factory run may create a **local feature branch** and commit on it
  when the user explicitly authorizes it (as in the 0.8.0 run) — the branch
  stays local for user review/push/PR; never commit to or push `main`
  directly.
- **Install via the Lead**: the `plugin_manager` tool with
  `action: install_bundle` and this repository's absolute path as `target`.
  Replacing an installed package requires a DSH restart to load a fresh
  module generation; the browser half additionally needs a page reload.
- **No machine-specific absolute paths** in any file. DSH home is resolved at
  runtime: configured `dshHome` → non-blank `$DSH_HOME` env → `~/.dsh` (blank
  env counts as unset). Never write into `$DSH_HOME` from build/verification
  steps — tests use a temporary home under a scratch directory (the one
  authorized exception is an explicit user-requested conversion of the live
  memory stores).
- **Indexes are composed, never stored**: `composeIndexLines` in
  `lib/store.js` is the single composer — nothing anywhere reads or writes
  an index file, and no file name is special-cased in listing or
  validation paths (a manually dropped `INDEX.md` is just another `.md`).
  Do not reintroduce on-disk index artifacts or fork the composition
  logic.
- **Dependencies**: none. `index.js` and `lib/*.js` import `node:*` builtins
  and `./lib/*` relative modules only; `client.js` is one module using
  `window.__ModuleLoader__.load` + `require('react')` from the platform
  module table (the loader serves a single bundle per package; package-local
  chunks are async-only, so the browser half stays one file) and imports no
  Harness client package. Keep all of them that way (local bundles must not
  rely on packages installed beside them).
- **Client half rules**: register UI only through `ctx.slots.inject(...)`
  and `ctx.sidebarRightTabs.register(...)` (right-sidebar tab types; guide
  entries need numeric `order` and FUNCTION `title`/`description` — strings
  crash the guide page); a component-local `<style>` element (removed on
  unmount) may use only `--dsw-alias-*` theme tokens; components must not
  touch DOM outside their subtree; the tab reads data only from the Host
  half's read-only routes `/memories/snapshot.json` and
  `/memories/file.json` (`no-store`; `?session=<id>` scopes the workspace
  parts to the tab's own session; `file.json` additionally validates
  `scope` + a plain `*.md` base name).
- **Pipeline discipline**: changes are built through the software-factory
  pipeline configured by `.factory.yml` (plan + implement enabled; the other
  phases are replaced by the manual verification bar above).
