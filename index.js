/**
 * @local/dsh-memories — Host plugin entry.
 *
 * A personal DSH memory mechanism with three scopes:
 *
 * 1. GLOBAL LONG-TERM — markdown files under `$DSH_HOME/memories/global-long-term/`;
 *    each file carries a `Description:` line right after its `# Title`
 *    heading, and the store's name+description index — composed fresh in
 *    memory at session start — is what gets injected, whole, with no cap.
 * 2. GLOBAL SHORT-TERM — one rolling note `$DSH_HOME/memories/global-short-term.md`
 *    ("what DSH is working on right now"), injected in full.
 * 3. WORKSPACE — the same long-term mechanism scoped to the current workspace,
 *    stored centrally under `$DSH_HOME/memories/workspace/<workspacename>/`.
 *
 * There is NO on-disk index: the plugin never reads or writes any index
 * file — every index is composed read-only from the memory files whenever a
 * baseline is built.
 *
 * This module is only the composition root: it validates config, registers
 * the `agent/pre-step` baseline injector, and starts the three optional
 * service surfaces (commands, tools, webServer) as fail-soft injected fibers.
 * The behavior lives in `lib/`:
 * - lib/config.js    — config validation + Standard-Schema `Config`
 * - lib/paths.js     — DSH-home precedence, project-root climb, per-workspace
 *                      store resolution
 * - lib/fs.js        — tiny fail-open filesystem helpers
 * - lib/store.js     — the on-disk memory model (description-bearing files +
 *                      read-only index composition) and writers
 * - lib/baseline.js  — guidance + baseline text + durable baseline message
 * - lib/surfaces.js  — the `/memory` command and the agent `memory` tool
 * - lib/snapshot.js  — read-only JSON payloads for the Memories tab
 * - lib/routes.js    — the two read-only webServer routes
 *
 * Contracts coded against (verified by live inspection of the installed
 * Harness and by reading the extracted built sources of the shipped plugins —
 * the full list with details lives in README "Design notes"):
 * - `ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => …)`
 *   — waterfall event; a listener that does not own the decision spreads it
 *   (`{ ...decision, messages }`).
 * - `agent.session.header.cwd`; `agent.session.surface.nodes` + `eventAt(seq)`.
 * - `ctx.commands.register` / `ctx.tools.register` / `ctx.webServer.register`
 *   service contracts (see the respective lib module headers).
 * - `ctx.inject([...], callback)` optional-service fibers.
 * - `export const Config` through the Standard Schema `~standard.validate`
 *   protocol (cordis `resolveConfig`).
 * - DSH home precedence (dsh-home-paths `resolveDshHome`).
 */
import { resolveConfig } from './lib/config.js';
import { resolveDshHome } from './lib/paths.js';
import {
  composeBaselineText,
  baselineIdentity,
  visibleBaselineIdentity,
  createBaselineMessage,
} from './lib/baseline.js';
import { runMemoryCommand, memoryToolDefinition } from './lib/surfaces.js';
import { registerMemoriesRoutes } from './lib/routes.js';

// Public API re-exports (the stable module boundary tests and tools import).
export { Config, resolveConfig } from './lib/config.js';
export { resolveDshHome, findProjectRoot, resolveWorkspaceStore } from './lib/paths.js';
export { buildBaselineText, composeBaselineText } from './lib/baseline.js';
export { buildMemoriesSnapshot, readMemoryFile } from './lib/snapshot.js';
export { runMemoryTool } from './lib/surfaces.js';

/**
 * Host plugin entry. Registers the `agent/pre-step` baseline injector on the
 * plugin context and starts the `/memory` command, the agent `memory` tool,
 * and the Memories-tab snapshot routes against their optional services;
 * returns disposal of all injected fibers as cleanup. Every optional surface
 * is fail-soft: a missing service or a memory error never breaks a step
 * (`ctx.logger.warn`, fail-open).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {unknown} config raw row config (already validated via `Config`).
 * @returns {() => void} cleanup.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const identity = baselineIdentity(resolved);
  const dshHome = resolveDshHome(resolved.dshHome);
  /** Flipped while the agent memory tool is registered; the guidance mirrors it. */
  const memoryToolAvailable = { current: false };
  /** The optional workspaceRegistry, read lazily so a late service still works. */
  const workspaceRegistry = () => {
    try {
      return ctx.get('workspaceRegistry');
    } catch {
      return undefined;
    }
  };

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    try {
      const visible = visibleBaselineIdentity(agent, decision.messages);
      if (visible === identity) return decision;
      signal.throwIfAborted();
      const cwd = agent?.session?.header?.cwd ?? process.cwd();
      const text = await composeBaselineText(
        {
          dshHome,
          cwd,
          memoryToolAvailable: memoryToolAvailable.current,
          workspaceRegistry: workspaceRegistry(),
        },
        resolved,
        signal,
      );
      const desired = createBaselineMessage(text, identity);
      const lastClaimedIndex = decision.messages.findLastIndex((message) => messages.includes(message));
      const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired);
      return { ...decision, messages: entered };
    } catch (error) {
      if (error?.name === 'AbortError') return decision;
      ctx.logger.warn('dsh-memories baseline injection failed: %o', error);
      return decision;
    }
  });

  const commandsFiber = ctx.inject(['commands'], (commandCtx) => {
    return commandCtx.commands.register({
      name: 'memory',
      description: 'Save or preview personal DSH memories (short-term, long-term, workspace)',
      input: {
        hint: '<save|long|workspace|show> [args]',
      },
      // Writes are summarized in the command result; echoing the raw input
      // too would duplicate the memory text in the session log.
      recordInput: false,
      handler: async ({ agent, rawInput = '', signal }) => {
        try {
          const cwd = agent?.session?.header?.cwd ?? process.cwd();
          return await runMemoryCommand({ dshHome, cwd, workspaceRegistry: workspaceRegistry() }, resolved, rawInput, signal);
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          return {
            kind: 'error',
            text: `/memory failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    });
  });

  const toolsFiber = ctx.inject(['tools'], (toolCtx) => {
    const dispose = toolCtx.tools.register(memoryToolDefinition({ dshHome, getWorkspaceRegistry: workspaceRegistry }, resolved));
    memoryToolAvailable.current = true;
    return () => {
      memoryToolAvailable.current = false;
      dispose();
    };
  });

  const webFiber = ctx.inject(['webServer'], (webCtx) => {
    return registerMemoriesRoutes(ctx, webCtx, { dshHome, resolved });
  });

  return () => {
    commandsFiber.dispose();
    toolsFiber.dispose();
    webFiber.dispose();
  };
}
