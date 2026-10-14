/**
 * @local/dsh-memories — the web data plane: the two read-only exact
 * `webServer` routes that serve the Memories tab its JSON payloads (the
 * snapshot and the file detail, both from lib/snapshot.js). Everything here
 * is fail-soft (`ctx.logger.warn`), `no-store`, and scoped to the requesting
 * session's workspace when a `?session=<id>` parameter is present.
 */

import { buildMemoriesSnapshot, readMemoryFile } from './snapshot.js';

/**
 * Register both read-only routes on the `webServer` service. Returns the
 * route disposer.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context (logger).
 * @param {import('@deepseek-ai/cordis').Context} webCtx the webServer-injected child context.
 * @param {{ dshHome: string, resolved: ReturnType<typeof import('./config.js').resolveConfig> }} env
 * @returns {() => void} disposer removing both routes.
 */
export function registerMemoriesRoutes(ctx, webCtx, { dshHome, resolved }) {
  /** One shared JSON-response helper for both read-only routes. */
  const sendJson = (res, status, value, head = false) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(head ? undefined : JSON.stringify(value));
  };
  /** The requesting tab's session cwd, or undefined when it is not live. */
  const sessionCwdOf = (sessionId) => {
    try {
      const agents = webCtx.get('agents');
      const cwd = agents?.get?.(sessionId)?.session?.header?.cwd;
      return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
    } catch (error) {
      ctx.logger.warn('dsh-memories session lookup failed: %o', error);
      return undefined;
    }
  };
  const readQuery = (req) => new URL(req.url ?? '/', 'http://memories.local').searchParams;
  const methodGuard = (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') return false;
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET, HEAD' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  };

  const disposeSnapshot = webCtx.webServer.register({
    kind: 'exact',
    path: '/memories/snapshot.json',
    handler: async (req, res) => {
      try {
        if (methodGuard(req, res)) return;
        // The Memories tab passes its session id; the workspace section is
        // scoped to THAT session's workspace only. Without the parameter
        // the snapshot stays global-only.
        const sessionId = readQuery(req).get('session') ?? '';
        let workspaceRequest;
        let sessionResolved;
        if (sessionId !== '') {
          const cwd = sessionCwdOf(sessionId);
          sessionResolved = cwd !== undefined;
          if (sessionResolved) {
            workspaceRequest = { cwd, workspaceRegistry: webCtx.get('workspaceRegistry') };
          }
        }
        const snapshot = {
          ...(await buildMemoriesSnapshot({ dshHome }, resolved, workspaceRequest)),
          ...(sessionResolved !== undefined ? { sessionResolved } : {}),
        };
        sendJson(res, 200, snapshot, req.method === 'HEAD');
      } catch (error) {
        ctx.logger.warn('dsh-memories snapshot failed: %o', error);
        if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        else res.end();
      }
    },
  });

  const disposeFile = webCtx.webServer.register({
    kind: 'exact',
    path: '/memories/file.json',
    handler: async (req, res) => {
      try {
        if (methodGuard(req, res)) return;
        // The Memories detail page: one memory file's full content. The
        // request is validated (scope enum + safe *.md base name) and
        // scoped exactly like the snapshot — the workspace scope reads the
        // requesting session's workspace only.
        const query = readQuery(req);
        const scope = query.get('scope') ?? '';
        const name = query.get('name') ?? '';
        const sessionId = query.get('session') ?? '';
        const cwd = sessionCwdOf(sessionId) ?? process.cwd();
        const detail = await readMemoryFile(
          { dshHome, cwd, workspaceRegistry: webCtx.get('workspaceRegistry') },
          resolved,
          { scope, name },
        );
        if (detail === undefined) {
          sendJson(res, 404, { error: 'memory file not found or request invalid' });
          return;
        }
        sendJson(res, 200, { kind: 'dsh-memories-file', version: 1, ...detail }, req.method === 'HEAD');
      } catch (error) {
        ctx.logger.warn('dsh-memories file read failed: %o', error);
        if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        else res.end();
      }
    },
  });

  return () => {
    disposeSnapshot();
    disposeFile();
  };
}
