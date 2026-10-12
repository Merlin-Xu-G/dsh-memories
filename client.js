/**
 * @local/dsh-memories — Client half.
 *
 * The Memories panel: a sidebar icon (`sidebar.panellist`, id `memories`) and
 * a keyed `main` panel page (key `memories`) that renders the read-only
 * memory snapshot served by this package's Host half at
 * `/memories/snapshot.json` (an exact webServer route).
 *
 * Display contract (per the plugin's design): the global short-term note is
 * shown in FULL; the global long-term store and each workspace store show
 * only their file index (INDEX.md text) and their file locations — never file
 * bodies.
 *
 * Contracts coded against (see index.js "Design notes" in README for the
 * inspection record):
 * - `window.__ModuleLoader__.load({ id, factory(require) })` — the client
 *   module format every browser bundle registers through; `require('react')`
 *   resolves from the platform module table (no bundled React).
 * - The returned plugin `{ inject: ['slots'], apply(ctx) }`: `ctx.slots.inject(
 *   key, () => ctx.slots.register({ ... }, Component))` registers lazily and
 *   is disposed when the declaration collapses; list-slot options carry
 *   `{ name, id, order, label }` and keyed slots `{ name, key }`.
 * - Styles: component-local (`<style>` rendered as a React element) so
 *   unmounting removes them; only `--dsw-alias-*` theme tokens are
 *   referenced, so light and dark themes both render correctly.
 * - No Harness client package is imported; every control is drawn here.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-memories',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect } = React;

    const PANEL_ID = 'memories';
    const SNAPSHOT_URL = '/memories/snapshot.json';

    const PAGE_CSS = [
      '.dshm-page{display:flex;flex-direction:column;gap:16px;max-width:820px;margin:0 auto;padding:24px 20px 48px;color:var(--dsw-alias-label-primary);font:inherit;}',
      '.dshm-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;}',
      '.dshm-title{font-size:20px;font-weight:600;margin:0;}',
      '.dstm-meta{color:var(--dsw-alias-label-secondary);font-size:12px;}',
      '.dshm-actions{margin-left:auto;display:flex;gap:8px;}',
      '.dshm-button{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;}',
      '.dshm-button:hover{border-color:var(--dsw-alias-brand-primary);}',
      '.dshm-button[disabled]{opacity:.5;cursor:default;}',
      '.dshm-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;}',
      '.dshm-card h2{font-size:14px;font-weight:600;margin:0;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}',
      '.dshm-card .dshm-sub{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:400;}',
      '.dshm-pre{margin:0;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.55;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;color:var(--dsw-alias-label-primary);}',
      '.dshm-files{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;}',
      '.dshm-file{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:2px;background:var(--dsw-alias-bg-layer-2);}',
      '.dshm-file-name{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:var(--dsw-alias-brand-primary);word-break:break-all;}',
      '.dshm-file-desc{font-size:12px;color:var(--dsw-alias-label-primary);}',
      '.dshm-file-meta{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;}',
      '.dshm-empty{color:var(--dsw-alias-label-secondary);font-size:13px;margin:0;}',
      '.dshm-error{border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);border-radius:8px;padding:10px 12px;font-size:13px;margin:0;}',
      '.dshm-hint{color:var(--dsw-alias-label-secondary);font-size:11px;margin:0;}',
    ].join('\n');

    /** Sidebar icon: a note card with three lines, in currentColor. */
    function MemoriesPanelIcon() {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 20,
        height: 20,
        'aria-hidden': true,
        style: { display: 'block' },
      },
      h('path', {
        d: 'M5 3.5h14a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5Z',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.6,
      }),
      h('path', {
        d: 'M7 8h10M7 12h10M7 16h6',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.6,
        'stroke-linecap': 'round',
      }));
    }

    /**
     * One long-term store section: index text + file rows (locations only).
     * @param {{ title: string, sub: string, store: object }} props
     */
    function LongTermSection({ title, sub, store }) {
      if (!store.present) {
        return h('section', { className: 'dshm-card' },
          h('h2', null, title, ' ', h('span', { className: 'dshm-sub' }, sub)),
          h('p', { className: 'dshm-empty' }, 'No memories yet.'));
      }
      return h('section', { className: 'dshm-card' },
        h('h2', null, title, ' ', h('span', { className: 'dshm-sub' }, sub)),
        h('p', { className: 'dshm-hint' },
          `Location: ${store.dir}${store.indexGenerated ? ' (index synthesized from files — no INDEX.md yet)' : ' (from INDEX.md)'}`),
        store.indexText
          ? h('pre', { className: 'dshm-pre' }, store.indexText)
          : h('p', { className: 'dshm-empty' }, 'Index is empty.'),
        h('ol', { className: 'dshm-files' },
          store.files.map((file) => h('li', { key: file.name, className: 'dshm-file' },
            h('span', { className: 'dshm-file-name' }, file.name),
            file.summary ? h('span', { className: 'dshm-file-desc' }, `${file.title} — ${file.summary}`) : h('span', { className: 'dshm-file-desc' }, file.title),
            h('span', { className: 'dshm-file-meta' }, `${file.chars} chars · ${store.dir}`),
          ))),
        h('p', { className: 'dshm-hint' }, 'File contents are not loaded here — the index and locations are shown by design; open the files to read them.'));
    }

    /** The Memories page: fetches the snapshot and renders all three scopes. */
    function MemoriesPage() {
      const [snapshot, setSnapshot] = useState(undefined);
      const [error, setError] = useState(undefined);
      const [loading, setLoading] = useState(false);
      const [reload, setReload] = useState(0);

      useEffect(() => {
        let cancelled = false;
        setLoading(true);
        fetch(SNAPSHOT_URL, { cache: 'no-store' })
          .then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status} from ${SNAPSHOT_URL}`);
            return await response.json();
          })
          .then(
            (data) => { if (!cancelled) { setSnapshot(data); setError(undefined); } },
            (fetchError) => { if (!cancelled) setError(String(fetchError && fetchError.message ? fetchError.message : fetchError)); },
          )
          .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
      }, [reload]);

      return h('div', { className: 'dshm-page' },
        h('style', null, PAGE_CSS),
        h('div', { className: 'dshm-head' },
          h('h1', { className: 'dshm-title' }, 'Memories'),
          snapshot ? h('span', { className: 'dshm-meta' }, `snapshot ${snapshot.generatedAt || ''}`) : null,
          h('div', { className: 'dshm-actions' },
            h('button', {
              className: 'dshm-button',
              type: 'button',
              disabled: loading,
              onClick: () => setReload(reload + 1),
            }, loading ? 'Loading…' : 'Refresh'))),
        error ? h('p', { className: 'dshm-error' }, `Could not load the memory snapshot: ${error}`) : null,
        !error && !snapshot ? h('p', { className: 'dshm-empty' }, loading ? 'Loading…' : 'No snapshot loaded yet.') : null,
        snapshot ? [
          h('section', { key: 'short', className: 'dshm-card' },
            h('h2', null, 'Global short-term memory ',
              h('span', { className: 'dshm-sub' }, 'what DSH is working on right now — shown in full')),
            snapshot.shortTerm && snapshot.shortTerm.present
              ? [
                h('p', { key: 'meta', className: 'dshm-hint' },
                  `${snapshot.shortTerm.path} · ${snapshot.shortTerm.chars} chars (sessions inject the newest ${snapshot.shortTermMaxChars})`),
                h('pre', { key: 'body', className: 'dshm-pre' }, snapshot.shortTerm.content.replace(/\n$/, '')),
              ]
              : h('p', { key: 'empty', className: 'dshm-empty' }, 'No short-term notes yet.')),
          h(LongTermSection, {
            key: 'long',
            title: 'Global long-term memory',
            sub: 'file index and locations',
            store: snapshot.longTerm || { present: false, dir: '', files: [], indexText: '' },
          }),
          h(LongTermSection, {
            key: 'workspaces',
            title: 'Workspace memories',
            sub: 'per workspace — file index and locations',
            store: snapshot.workspaces && snapshot.workspaces.length > 0
              ? snapshot.workspaces[0]
              : { present: false, dir: '', files: [], indexText: '' },
          }),
          snapshot.workspaces && snapshot.workspaces.length > 1
            ? snapshot.workspaces.slice(1).map((store, index) => h(LongTermSection, {
              key: `ws-${index}`,
              title: 'Workspace memory',
              sub: store.title || store.root,
              store,
            }))
            : null,
        ] : null);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const disposers = [
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 10,
            label: 'Memories',
          }, MemoriesPanelIcon)),
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
          }, MemoriesPage)),
        ];
        return () => {
          for (const dispose of disposers) dispose();
        };
      },
    };
  },
});
