# AGENTS.md

## What this repo is

`dsh-memories` is a DSH (DeepSeek Harness) plugin bundle
(`@local/dsh-memories`) providing a personal memory mechanism with three
scopes: **global long-term** (file library + injected `INDEX.md` under
`$DSH_HOME/memories/global-long-term/`), **global short-term** (rolling note
`$DSH_HOME/memories/global-short-term.md`), and **workspace** (the same
long-term mechanism scoped to the current workspace, stored centrally at
`$DSH_HOME/memories/workspace/<workspacename>/` — the registered workspace
title when resolvable, else the root directory's name — injected only for
sessions in that workspace). Injection happens as one durable user-role
baseline message
spliced at the first eligible `agent/pre-step` — the same seam the shipped
`@deepseek-ai/dsh-agent-instructions` uses for AGENTS.md loading — bounded by
per-scope char budgets with honest truncation markers. The baseline **always**
carries a "your memory system" guidance section (three scopes, when to write,
check-memory-before-asking-the-user), so memory works automatically even with
an empty store. Writing goes through three surfaces sharing one code path:
the `/memory` human command (save | long | workspace | show), the agent
`memory` tool (`ctx.tools.register`), and the read-only web UI endpoints. The
**Memories tab** (browser half, right sidebar) shows a compact list of all
memories first and each item's full content on a detail page; its workspace
section covers only the workspace of the session the tab belongs to.

## Layout

```
package.json        manifest (@local/dsh-memories, dsh.bundle.patch + dsh.client)
cordis.patch.yml    loader patch: insert row id `memories`
index.js            Host plugin (Config schema, baseline injector, /memory command, memory tool, snapshot + file-detail routes)
client.js           Client plugin (Memories right-sidebar tab, session-scoped; ./client export)
locale/en.json      Plugin Manager display metadata (English)
locale/zh.json      Plugin Manager display metadata (Chinese)
README.md           full design + usage documentation
.factory.yml        software-factory pipeline config (plan + implement only)
```

## Conventions for agents working here

- **Verification bar** (quote real outputs when reporting): `node --check`
  (or an import check) on every changed `.js` file, `JSON.parse` on every
  changed `.json` file, a real directory listing of the deliverables, a
  machine-path scan (the user name, the workspace root, and the profile root
  must not appear as path literals in tracked files), and — for
  injection-affecting changes — a dry-run smoke of the exported
  `composeBaselineText`/`buildMemoriesSnapshot` with a temporary DSH home.
- **Never `git commit`** in this repo; the user/Lead reviews and commits.
- **Install via the Lead**: the `plugin_manager` tool with
  `action: install_bundle` and this repository's absolute path as `target`.
  Replacing an installed package requires a DSH restart to load a fresh
  module generation; the browser half additionally needs a page reload.
- **No machine-specific absolute paths** in any file. DSH home is resolved at
  runtime: configured `dshHome` → non-blank `$DSH_HOME` env → `~/.dsh` (blank
  env counts as unset). Never write into `$DSH_HOME` from build/verification
  steps — tests use a temporary home under a scratch directory.
- **Dependencies**: none. `index.js` imports `node:*` builtins only; `client.js`
  uses `window.__ModuleLoader__.load` + `require('react')` from the platform
  module table and imports no Harness client package. Keep both that way
  (local bundles must not rely on packages installed beside them).
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
