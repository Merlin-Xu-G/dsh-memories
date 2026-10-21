/**
 * @local/dsh-memories — the two write surfaces that share one code path:
 * the `/memory` human command (dsh-commands; human-only by contract) and
 * the agent `memory` tool (dsh-tools `ctx.tools.register`; the LLM-facing
 * surface). Both write through lib/store.js and resolve the session's
 * workspace store through lib/paths.js.
 */

import { basename } from 'node:path';
import {
  MEMORIES_DIR,
  GLOBAL_LONG_TERM_DIRNAME,
  GLOBAL_SHORT_TERM_FILENAME,
  WORKSPACE_MEMORIES_DIRNAME,
  globalLongTermDir,
  globalShortTermFile,
  resolveWorkspaceStore,
} from './paths.js';
import { appendShortTerm, rewriteShortTerm, writeLongTermMemory } from './store.js';
import { readTextIfPresent } from './fs.js';
import { composeBaselineText } from './baseline.js';

const MEMORY_USAGE = `Usage:
  /memory save <text>                 — append a date-stamped note to global short-term memory
  /memory long <title> | <text>       — create/update a global long-term memory file and refresh INDEX.md
  /memory workspace <title> | <text>  — create/update a workspace memory file ($DSH_HOME/memories/workspace/<workspacename>/) and refresh its INDEX.md
  /memory show                        — preview exactly what a new session would receive`;

/**
 * @param {string} rawInput
 * @returns {{ sub: string, args: string }}
 */
function parseInvocation(rawInput) {
  const trimmed = rawInput.trim();
  if (trimmed === '') return { sub: '', args: '' };
  const spaceAt = trimmed.indexOf(' ');
  if (spaceAt === -1) return { sub: trimmed, args: '' };
  return { sub: trimmed.slice(0, spaceAt), args: trimmed.slice(spaceAt + 1).trim() };
}

/**
 * The /memory command handler body (pure helper; the registered handler wraps
 * it and converts thrown errors into error results).
 * @param {{ dshHome: string, cwd: string, workspaceRegistry?: object }} paths
 *   resolved locations plus the optional workspaceRegistry service.
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} resolved validated config.
 * @param {string} rawInput
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ kind: 'success', text: string } | { kind: 'error', text: string }>}
 */
export async function runMemoryCommand({ dshHome, cwd, workspaceRegistry }, resolved, rawInput, signal) {
  const { sub, args } = parseInvocation(rawInput);
  switch (sub) {
    case 'save': {
      if (args === '') return { kind: 'error', text: MEMORY_USAGE };
      const { chars } = await appendShortTerm(dshHome, args, resolved.shortTermFileMaxChars);
      if (chars > resolved.shortTermMaxChars) {
        return {
          kind: 'success',
          text: `Saved to global short-term memory ($DSH_HOME/${MEMORIES_DIR}/${GLOBAL_SHORT_TERM_FILENAME}, now ${chars} chars — OVER the ${resolved.shortTermMaxChars}-char injection cap). Ask the agent to compact it with the memory tool (action "compact": newest entries verbatim, older ones folded into one dated summary entry), or prune the file by hand.`,
        };
      }
      return {
        kind: 'success',
        text: `Saved to global short-term memory ($DSH_HOME/${MEMORIES_DIR}/${GLOBAL_SHORT_TERM_FILENAME}, now ${chars} chars; new sessions inject its newest ${resolved.shortTermMaxChars} chars).`,
      };
    }
    case 'long':
    case 'workspace': {
      const separator = args.indexOf('|');
      if (separator === -1) {
        return { kind: 'error', text: `${MEMORY_USAGE}\n\n"${sub}" needs a "|" separating title and text.` };
      }
      const title = args.slice(0, separator).trim();
      const body = args.slice(separator + 1).trim();
      if (title === '' || body === '') {
        return { kind: 'error', text: `"${sub}" needs a non-empty title and text, separated by "|".` };
      }
      if (sub === 'workspace') {
        signal?.throwIfAborted();
        const store = await resolveWorkspaceStore({ dshHome, cwd }, resolved, workspaceRegistry, signal);
        const written = await writeLongTermMemory(store.dir, title, body);
        return {
          kind: 'success',
          text: `Workspace memory saved: $DSH_HOME/${MEMORIES_DIR}/${WORKSPACE_MEMORIES_DIRNAME}/${basename(store.dir)}/${written.file} ("${title}") for workspace "${store.name}"; ${written.index} regenerated (new sessions in this workspace see it).`,
        };
      }
      const written = await writeLongTermMemory(globalLongTermDir(dshHome), title, body);
      return {
        kind: 'success',
        text: `Global long-term memory saved: $DSH_HOME/${MEMORIES_DIR}/${GLOBAL_LONG_TERM_DIRNAME}/${written.file} ("${title}"); ${written.index} regenerated (new sessions see it).`,
      };
    }
    case 'show': {
      const text = await composeBaselineText(
        { dshHome, cwd, memoryToolAvailable: true, workspaceRegistry },
        resolved,
        signal,
      );
      return {
        kind: 'success',
        text: `What a NEW session in this workspace would receive:\n\n${text}`,
      };
    }
    default:
      return { kind: 'error', text: MEMORY_USAGE };
  }
}

/**
 * The agent `memory` tool body: the same store and code path as the /memory
 * command, structured arguments instead of a command line, and a plain
 * `{ ok, message }` result (thrown Errors settle as tool error results).
 * Exported for testing.
 *
 * @param {{ dshHome: string, cwd: string, workspaceRegistry?: object }} paths
 *   resolved locations plus the optional workspaceRegistry service.
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} resolved validated config.
 * @param {{ action: 'save' | 'compact' | 'long' | 'workspace', title?: string, text: string }} args
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function runMemoryTool({ dshHome, cwd, workspaceRegistry }, resolved, { action, title, text }, signal) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('memory tool: "text" must be a non-empty string.');
  }
  signal?.throwIfAborted();
  if (action === 'save') {
    const { chars } = await appendShortTerm(dshHome, text.trim(), resolved.shortTermFileMaxChars);
    if (chars > resolved.shortTermMaxChars) {
      return {
        ok: true,
        message: `Saved to global short-term memory — the note is now ${chars} chars, over the ${resolved.shortTermMaxChars}-char injection cap. Compact it NOW: call the memory tool with action "compact" and text = the rewritten note (keep the newest entries verbatim, fold older ones into one dated summary entry, drop finished threads; stay under ${resolved.shortTermMaxChars} chars).`,
      };
    }
    return {
      ok: true,
      message: `Saved to global short-term memory (now ${chars} chars; new sessions see its newest ${resolved.shortTermMaxChars} chars).`,
    };
  }
  if (action === 'compact') {
    const existing = await readTextIfPresent(globalShortTermFile(dshHome));
    const currentChars = (existing ?? '').replace(/\s+$/, '').length;
    const trimmed = text.trim();
    if (currentChars > 0 && trimmed.length >= currentChars) {
      throw new Error(`memory tool: "compact" must shorten the note (proposed ${trimmed.length} chars, current ${currentChars}).`);
    }
    if (trimmed.length > resolved.shortTermFileMaxChars) {
      throw new Error(`memory tool: compacted note is ${trimmed.length} chars, over the shortTermFileMaxChars bound of ${resolved.shortTermFileMaxChars}.`);
    }
    const { chars } = await rewriteShortTerm(dshHome, trimmed);
    return {
      ok: true,
      message: chars > resolved.shortTermMaxChars
        ? `Compacted global short-term memory (now ${chars} chars — still over the ${resolved.shortTermMaxChars}-char cap; compact further on the next pass).`
        : `Compacted global short-term memory (now ${chars} chars; new sessions see its newest ${resolved.shortTermMaxChars} chars).`,
    };
  }
  if (action === 'long' || action === 'workspace') {
    const trimmedTitle = typeof title === 'string' ? title.trim() : '';
    if (trimmedTitle === '') {
      throw new Error(`memory tool: action "${action}" needs a non-empty "title".`);
    }
    const dir = action === 'workspace'
      ? (await resolveWorkspaceStore({ dshHome, cwd }, resolved, workspaceRegistry, signal)).dir
      : globalLongTermDir(dshHome);
    const written = await writeLongTermMemory(dir, trimmedTitle, text.trim());
    const where = action === 'workspace'
      ? `Workspace memory saved: ${written.file} ("${trimmedTitle}") under ${dir}; ${written.index} regenerated (new sessions in this workspace see it).`
      : `Global long-term memory saved: ${written.file} ("${trimmedTitle}") under ${dir}; ${written.index} regenerated (new sessions see it).`;
    return { ok: true, message: where };
  }
  throw new Error('memory tool: "action" must be one of "save", "compact", "long", "workspace".');
}

/**
 * The raw ToolDefinition handed to `ctx.tools.register` (dsh-tools
 * ToolRuntime.register contract; parameters/output stay inside the enforced
 * JSON Schema subset: type/properties/required/additionalProperties/items/enum).
 *
 * @param {{ dshHome: string, getWorkspaceRegistry: () => object | undefined }} paths
 *   resolved locations plus a lazy workspaceRegistry getter.
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} resolved validated config.
 * @returns {object} ToolDefinition.
 */
export function memoryToolDefinition({ dshHome, getWorkspaceRegistry }, resolved) {
  return {
    name: 'memory',
    description: `Write to the user's personal DSH memories.
- action "save" appends a date-stamped note to the global short-term rolling note (current work, pickup points); include the time of day in the text only when it matters.
- action "compact" rewrites the short-term note with your compacted version when a save reports it is over the cap: keep the newest entries verbatim, fold older ones into one dated summary entry, drop finished threads.
- action "long" creates/updates a global long-term memory file (durable cross-project knowledge about the user).
- action "workspace" does the same in this workspace's memory directory under $DSH_HOME/memories/workspace/ (workspace-local knowledge).
Files and indexes are kept consistent automatically.`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'compact', 'long', 'workspace'],
          description: 'Which memory scope to write: "save" (short-term note), "compact" (rewrite the short-term note shorter), "long" (global long-term file), "workspace" (workspace-local file).',
        },
        title: {
          type: 'string',
          description: 'Memory title (required for "long" and "workspace"; becomes the file name and heading). Ignored for "save" and "compact".',
        },
        text: {
          type: 'string',
          description: 'The memory text to store. For "save" one concise line works best; for "compact" the full rewritten note.',
        },
      },
      required: ['action', 'text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
        },
        required: ['ok', 'message'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
      return await runMemoryTool({ dshHome, cwd, workspaceRegistry: getWorkspaceRegistry?.() }, resolved, args, exec?.signal);
    },
  };
}
