# AGENTS.md

## What this repo is

`dsh-memories` is a DSH (DeepSeek Harness) plugin bundle
(`@local/dsh-memories`) providing a personal memory mechanism with three
scopes: **global long-term** (file library + injected `INDEX.md` under
`$DSH_HOME/memories/global-long-term/`), **global short-term** (rolling note
`$DSH_HOME/memories/global-short-term.md`), and **workspace** (same long-term
mechanism under `<projectRoot>/.dsh/memories/`, injected only for sessions in
that workspace). Injection happens as one durable user-role baseline message
spliced at the first eligible `agent/pre-step` — the same seam the shipped
`@deepseek-ai/dsh-agent-instructions` uses for AGENTS.md loading — bounded by
per-scope char budgets with honest truncation markers. The baseline **always**
carries a "your memory system" guidance section (three scopes, when to write,
check-memory-before-asking-the-user), so memory works automatically even with
an empty store. Writing goes through three surfaces sharing one code path:
the `/memory` human command (save | long | workspace | show), the agent
`memory` tool (`ctx.tools.register`), and the read-only web UI snapshot. The
**Memories web panel** (browser half) shows the short-term note in full and
the long-term/workspace stores as index + file locations only.

## Layout

```
package.json        manifest (@local/dsh-memories, dsh.bundle.patch + dsh.client)
cordis.patch.yml    loader patch: insert row id `memories`
index.js            Host plugin (Config schema, baseline injector, /memory command, memory tool, snapshot route)
client.js           Client plugin (Memories sidebar panel; ./client export)
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
- **Client half rules**: register UI only through `ctx.slots.inject(...)`; a
  component-local `<style>` element (removed on unmount) may use only
  `--dsw-alias-*` theme tokens; components must not touch DOM outside their
  subtree; the panel reads data only from the Host half's
  `/memories/snapshot.json` route (read-only, `no-store`).
- **Pipeline discipline**: changes are built through the software-factory
  pipeline configured by `.factory.yml` (plan + implement enabled; the other
  phases are replaced by the manual verification bar above).
