/**
 * @local/dsh-memories — Client half.
 *
 * The Memories tab of the right sidebar: one page-type tab registered with
 * `ctx.sidebarRightTabs` (kind `memories`, plus a guide entry so the tab is
 * discoverable from the guide page) whose body renders under the keyed
 * `sidebar.right.pane.tab` slot, keyed by the type id. The tab body receives
 * the Session id through the registration's business-share
 * `inject: (sessionId) => ({ sessionId })`.
 *
 * Two views, both scrolling vertically only and as wide as the sidebar pane:
 * - LIST: one compact row per memory — the short-term note as ONE whole-file
 *   item, plus global long-term files and the session's workspace files
 *   (title + description). No full content is shown inline.
 * - DETAIL: the selected item's full content — the whole short-term note
 *   (already in the snapshot), or a long-term/workspace file fetched from
 *   the Host half's `/memories/file.json` route (validated scope + safe
 *   *.md name, scoped to the requesting session's workspace).
 *
 * Contracts coded against (see README "Design notes" for the inspection
 * record; ui-sidebar-documentpreview is the live proof for every one of
 * these):
 * - `window.__ModuleLoader__.load({ id, factory(require) })` — the client
 *   module format; `require('react')` resolves from the platform module
 *   table (no bundled React).
 * - `{ inject: ['slots', 'sidebarRightTabs'], apply(ctx) }` — browser plugin
 *   form; `sidebarRightTabs` is the right-sidebar tab-type registry service.
 * - `ctx.sidebarRightTabs.register({ id, kind, title, guide? })` — one page
 *   tab type (no `patterns`: opened by kind); omitted `priority` lands in the
 *   default `extension` band. Guide entries carry numeric `order` and
 *   FUNCTION `title`/`description` — strings crash the guide page.
 * - `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
 *   { name, key: definition.id, inject: (sessionId, actions) => props },
 *   Body))` — the tab body seat; the business-share callback's return value
 *   becomes the component's props.
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

    /** Tab-type id: also the slot key of the body (the registry's rule). */
    const TAB_TYPE_ID = '@local/dsh-memories/memories';
    const TAB_KIND = 'memories';
    const SNAPSHOT_URL = '/memories/snapshot.json';
    const FILE_URL = '/memories/file.json';

    const TAB_CSS = `
.dshm-scroll{width:100%;height:100%;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;}
.dshm-tab{width:100%;box-sizing:border-box;min-width:0;display:flex;flex-direction:column;gap:12px;padding:14px 14px 28px;color:var(--dsw-alias-label-primary);font:inherit;}
.dstm-tab-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;min-width:0;max-width:100%;}
.dshm-toggle{appearance:none;background:none;border:none;padding:0;min-width:0;max-width:100%;width:100%;display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:600;cursor:pointer;text-align:left;}
.dshm-toggle:hover .dshm-toggle-title{color:var(--dsw-alias-brand-primary);}
.dshm-toggle-title{font-size:12px;}
.dshm-chev{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-secondary);font-weight:400;}
.dshm-title{font-size:14px;font-weight:600;margin:0;}
.dshm-meta{color:var(--dsw-alias-label-secondary);font-size:11px;}
.dshm-actions{margin-left:auto;display:flex;gap:6px;}
.dshm-button{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:3px 10px;font-size:11px;cursor:pointer;}
.dshm-button:hover{border-color:var(--dsw-alias-brand-primary);}
.dshm-button[disabled]{opacity:.5;cursor:default;}
.dshm-card{min-width:0;max-width:100%;box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:10px 11px;display:flex;flex-direction:column;gap:7px;}
.dshm-card h2{font-size:12px;font-weight:600;margin:0;display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;min-width:0;}
.dshm-card .dshm-sub{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:400;word-break:break-all;min-width:0;}
.dshm-rows{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;}
.dshm-row{appearance:none;text-align:left;min-width:0;max-width:100%;width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:7px;padding:6px 9px;display:flex;flex-direction:column;gap:2px;cursor:pointer;font:inherit;}
.dshm-row:hover{border-color:var(--dsw-alias-brand-primary);}
.dshm-row-title{font-size:11px;font-weight:600;min-width:0;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dshm-row-text{font-size:11px;color:var(--dsw-alias-label-secondary);min-width:0;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dshm-row-meta{font-size:10px;color:var(--dsw-alias-label-secondary);word-break:break-all;}
.dshm-empty{color:var(--dsw-alias-label-secondary);font-size:12px;margin:0;}
.dshm-error{border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);border-radius:7px;padding:8px 10px;font-size:12px;margin:0;}
.dshm-hint{color:var(--dsw-alias-label-secondary);font-size:10px;margin:0;word-break:break-all;min-width:0;max-width:100%;}
.dshm-detail-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}
.dshm-back{font-size:11px;}
.dshm-detail-title{font-size:13px;font-weight:600;margin:0;word-break:break-word;}
.dshm-pre{margin:0;min-width:0;max-width:100%;width:100%;box-sizing:border-box;display:block;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.5;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:8px 10px;color:var(--dsw-alias-label-primary);}
`.trim();

    /**
     * The short-term note's entry count, for the list row's meta line.
     * @param {string} content the note's full content.
     * @returns {number}
     */
    function shortTermEntryCount(content) {
      return content.split(/\r?\n/).filter((line) => line.trim() !== '').length;
    }

    /**
     * One section card of the list view: a heading plus clickable rows.
     * @param {{ title: string, sub: string, rows: { key: string, title: string, text: string, meta: string }[], onSelect: (key: string) => void, empty: string }} props
     */
    function ListSection({ title, sub, rows, onSelect, empty }) {
      return h('section', { className: 'dshm-card' },
        h('h2', null, title, ' ', h('span', { className: 'dshm-sub' }, sub)),
        rows.length === 0
          ? h('p', { className: 'dshm-empty' }, empty)
          : h('ol', { className: 'dshm-rows' },
            rows.map((row) => h('li', { key: row.key },
              h('button', {
                className: 'dshm-row',
                type: 'button',
                onClick: () => onSelect(row.key),
                title: 'Show this memory',
              },
              h('span', { className: 'dshm-row-title' }, row.title),
              row.text ? h('span', { className: 'dshm-row-text' }, row.text) : null,
              h('span', { className: 'dshm-row-meta' }, row.meta))))));
    }

    /**
     * The short-term memory card: ONE expandable block (no detail page, no
     * content title). The header toggles; the expanded body is the whole
     * rolling note, as wide as the card.
     * @param {{ store: object, open: boolean, onToggle: () => void }} props
     */
    function ShortTermBlock({ store, open, onToggle }) {
      if (store === undefined) {
        return h('section', { className: 'dshm-card' },
          h('h2', null, 'Short-term memory'),
          h('p', { className: 'dshm-empty' }, 'No short-term notes yet.'));
      }
      return h('section', { className: 'dshm-card' },
        h('button', {
          className: 'dshm-toggle',
          type: 'button',
          onClick: onToggle,
          'aria-expanded': open ? 'true' : 'false',
          title: open ? 'Collapse the short-term note' : 'Expand the short-term note',
        },
        h('span', { className: 'dshm-toggle-title' }, 'Short-term memory'),
        h('span', { className: 'dshm-sub' },
          `${shortTermEntryCount(store.content)} entries · ${store.chars} chars`),
        h('span', { className: 'dshm-chev', 'aria-hidden': true }, open ? '▾' : '▸')),
        open
          ? [
            h('p', { key: 'path', className: 'dshm-hint' }, store.path),
            h('pre', { key: 'body', className: 'dshm-pre' },
              store.content.replace(/\n$/, '')),
          ]
          : null);
    }

    /**
     * The detail page for one long-term/workspace file: fetches the full
     * content from the Host half on mount.
     * @param {{ scope: 'long' | 'workspace', name: string, sessionId?: string, onBack: () => void }} props
     */
    function FileDetail({ scope, name, sessionId, onBack }) {
      const [detail, setDetail] = useState(undefined);
      const [error, setError] = useState(undefined);
      useEffect(() => {
        let cancelled = false;
        const params = new URLSearchParams({ scope, name });
        if (typeof sessionId === 'string' && sessionId !== '') params.set('session', sessionId);
        fetch(`${FILE_URL}?${params.toString()}`, { cache: 'no-store' })
          .then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
          })
          .then(
            (data) => { if (!cancelled) { setDetail(data); setError(undefined); } },
            (fetchError) => { if (!cancelled) setError(String(fetchError && fetchError.message ? fetchError.message : fetchError)); },
          );
        return () => { cancelled = true; };
      }, [scope, name, sessionId]);

      return h('div', { className: 'dshm-scroll' },
        h('style', null, TAB_CSS),
        h('div', { className: 'dshm-tab' },
          h('div', { className: 'dshm-detail-head' },
            h('button', { className: 'dshm-button dshm-back', type: 'button', onClick: onBack }, '‹ Memories'),
            h('h1', { className: 'dshm-detail-title' }, detail?.title ?? name)),
          error ? h('p', { className: 'dshm-error' }, `Could not load this memory: ${error}`) : null,
          !error && !detail ? h('p', { className: 'dshm-empty' }, 'Loading…') : null,
          detail ? [
            h('p', { key: 'meta', className: 'dshm-hint' },
              `${detail.name} · ${detail.chars} chars · ${scope === 'workspace' ? 'this workspace' : 'global long-term'}`),
            h('pre', { key: 'body', className: 'dshm-pre' }, detail.text.replace(/\n$/, '')),
          ] : null));
    }

    /**
     * The Memories tab body. `sessionId` arrives through the registration's
     * business share; the workspace parts of the snapshot and file reads are
     * scoped to that session's workspace by the Host half.
     * @param {{ sessionId?: string }} props
     */
    function MemoriesTabBody({ sessionId }) {
      const [snapshot, setSnapshot] = useState(undefined);
      const [error, setError] = useState(undefined);
      const [loading, setLoading] = useState(false);
      const [reload, setReload] = useState(0);
      /** null = list view; otherwise the selected detail item. */
      const [detail, setDetail] = useState(null);

      useEffect(() => {
        let cancelled = false;
        setLoading(true);
        const url = typeof sessionId === 'string' && sessionId !== ''
          ? `${SNAPSHOT_URL}?session=${encodeURIComponent(sessionId)}`
          : SNAPSHOT_URL;
        fetch(url, { cache: 'no-store' })
          .then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
            return await response.json();
          })
          .then(
            (data) => { if (!cancelled) { setSnapshot(data); setError(undefined); } },
            (fetchError) => { if (!cancelled) setError(String(fetchError && fetchError.message ? fetchError.message : fetchError)); },
          )
          .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
      }, [sessionId, reload]);

      const [shortOpen, setShortOpen] = useState(false);

      const shortStore = snapshot && snapshot.shortTerm && snapshot.shortTerm.present
        ? snapshot.shortTerm
        : undefined;
      const longRows = snapshot && snapshot.longTerm && snapshot.longTerm.present
        ? snapshot.longTerm.files
        : [];
      const wsStore = snapshot && snapshot.workspace ? snapshot.workspace : undefined;
      const wsRows = wsStore && wsStore.present ? wsStore.files : [];

      return h('div', { className: 'dshm-scroll' },
        h('style', null, TAB_CSS),
        h('div', { className: 'dshm-tab' },
          detail !== null && detail.kind === 'file'
            ? h(FileDetail, {
              scope: detail.scope,
              name: detail.name,
              sessionId,
              onBack: () => setDetail(null),
            })
            : [
              h('div', { key: 'head', className: 'dstm-tab-head' },
                h('h1', { className: 'dshm-title' }, 'Memories'),
                snapshot ? h('span', { className: 'dshm-meta' }, `snapshot ${snapshot.generatedAt || ''}`) : null,
                h('div', { className: 'dshm-actions' },
                  h('button', {
                    className: 'dshm-button',
                    type: 'button',
                    disabled: loading,
                    onClick: () => setReload(reload + 1),
                  }, loading ? 'Loading…' : 'Refresh'))),
              error ? h('p', { key: 'error', className: 'dshm-error' }, `Could not load the memory snapshot: ${error}`) : null,
              !error && !snapshot ? h('p', { key: 'wait', className: 'dshm-empty' }, loading ? 'Loading…' : 'No snapshot loaded yet.') : null,
              snapshot ? [
                h(ShortTermBlock, {
                  key: 'short',
                  store: shortStore,
                  open: shortOpen,
                  onToggle: () => setShortOpen(!shortOpen),
                }),
                h(ListSection, {
                  key: 'long',
                  title: 'Global long-term memory',
                  sub: `${longRows.length} file${longRows.length === 1 ? '' : 's'}`,
                  rows: longRows.map((file) => ({
                    key: file.name,
                    title: file.title,
                    text: file.description,
                    meta: `${file.name} · ${file.chars} chars`,
                  })),
                  onSelect: (name) => setDetail({ kind: 'file', scope: 'long', name }),
                  empty: 'No long-term memories yet.',
                }),
                h(ListSection, {
                  key: 'workspace',
                  title: 'This workspace',
                  sub: wsStore ? `${wsRows.length} file${wsRows.length === 1 ? '' : 's'} · ${wsStore.name ?? wsStore.root}` : 'the workspace of this session',
                  rows: wsRows.map((file) => ({
                    key: file.name,
                    title: file.title,
                    text: file.description,
                    meta: `${file.name} · ${file.chars} chars`,
                  })),
                  onSelect: (name) => setDetail({ kind: 'file', scope: 'workspace', name }),
                  empty: 'This workspace has no memories yet.',
                }),
              ] : null,
            ]));
    }

    return {
      inject: ['slots', 'sidebarRightTabs'],
      apply(ctx) {
        const disposers = [
          ctx.effect(() => ctx.sidebarRightTabs.register({
            id: TAB_TYPE_ID,
            kind: TAB_KIND,
            title: () => 'Memories',
            guide: [
              {
                id: 'memories',
                order: 50,
                title: () => 'Memories',
                description: () => 'Browse the personal memory store: pick a memory from the list to read it in full.',
              },
            ],
          }), 'dsh-memories: right-sidebar tab type'),
          ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: TAB_TYPE_ID,
            inject: (sessionId) => ({ sessionId }),
          }, MemoriesTabBody)), 'dsh-memories: right-sidebar tab body'),
        ];
        return () => {
          for (const dispose of disposers) dispose();
        };
      },
    };
  },
});
