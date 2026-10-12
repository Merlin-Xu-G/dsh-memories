# AGENTS.md

## What this repo is

`dsh-memories` is a DSH (DeepSeek Harness) Host plugin bundle
(`@local/dsh-memories`) providing a personal memory mechanism with three
scopes: **global long-term** (file library + injected `INDEX.md` under
`$DSH_HOME/memories/global-long-term/`), **global short-term** (rolling note
`$DSH_HOME/memories/global-short-term.md`, appended by `/memory save`), and
**workspace** (same long-term mechanism under `<projectRoot>/.dsh/memories/`,
injected only for sessions in that workspace). Injection happens as one
durable user-role baseline message spliced at the first eligible
`agent/pre-step` — the same seam the shipped `@deepseek-ai/dsh-agent-instructions`
uses for AGENTS.md loading — bounded by per-scope char budgets with honest
truncation markers. The `/memory` human command (save | long | workspace |
show) is the only writer.

## Layout

```
package.json        manifest (@local/dsh-memories, dsh.bundle.patch → ./cordis.patch.yml)
cordis.patch.yml    loader patch: insert row id `memories`
index.js            Host plugin (Config schema, baseline injector, /memory command)
locale/en.json      Plugin Manager display metadata (English)
locale/zh.json      Plugin Manager display metadata (Chinese)
README.md           full design + usage documentation
.factory.yml        software-factory pipeline config (plan + implement only)
```

## Conventions for agents working here

- **Verification bar** (quote real outputs when reporting): `node --check` on
  every changed `.js` file, `JSON.parse` on every changed `.json` file, a real
  directory listing of the deliverables, a machine-path scan (the user name,
  the workspace root, and the profile root must not appear as path literals in
  tracked files), and — for injection-affecting changes — a dry-run smoke of
  the exported `composeBaselineText` with a temporary DSH home.
- **Never `git commit`** in this repo; the user/Lead reviews and commits.
- **Install via the Lead**: the `plugin_manager` tool with
  `action: install_bundle` and this repository's absolute path as `target`.
  Replacing an installed package requires a DSH restart to load a fresh module
  generation.
- **No machine-specific absolute paths** in any file. DSH home is resolved at
  runtime: configured `dshHome` → non-blank `$DSH_HOME` env → `~/.dsh` (blank
  env counts as unset). Never write into `$DSH_HOME` from build/verification
  steps — tests use a temporary home under a scratch directory.
- **Dependencies**: none. `index.js` imports `node:*` builtins only; keep it
  that way (local bundles must not rely on packages installed beside them).
- **Pipeline discipline**: changes are built through the software-factory
  pipeline configured by `.factory.yml` (plan + implement enabled; the other
  phases are replaced by the manual verification bar above).
