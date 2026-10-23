/**
 * @local/dsh-memories — the two write surfaces that share one code path:
 * the `/memory` human command (dsh-commands; human-only by contract) and
 * the agent `memory` tool (dsh-tools `ctx.tools.register`; the LLM-facing
 * surface). Both write through lib/store.js and resolve the session's
 * workspace store through lib/paths.js. Long/workspace writes accept a
 * one-line description (at most 1000 characters — over-long or multi-line
 * values are REJECTED here, never truncated) and save the memory file only:
 * INDEX.md is owned by scripts/generate-index.mjs and is never touched or
 * mentioned by a write.
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
import {
  appendShortTerm,
  descriptionWriteError,
  rewriteShortTerm,
  writeLongTermMemory,
} from './store.js';
import { readTextIfPresent } from './fs.js';
import { composeBaselineText } from './baseline.js';

const MEMORY_USAGE = `Usage:
  /memory save <text>                                — append a date-stamped note to global short-term memory (transient pickup notes; durable knowledge belongs in a long/workspace memory file)
  /memory long <title> | <description> | <text>      — create/update a global long-term memory file, the durable cross-project library the agent is expected to write proactively ($DSH_HOME/memories/global-long-term/)
  /memory workspace <title> | <description> | <text> — create/update a workspace memory file, this project's durable knowledge ($DSH_HOME/memories/workspace/<workspacename>/)
  /memory show                                       — preview exactly what a new session would receive`;

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
      const { chars } = await appendShortTerm(dshHome, args);
      if (chars > resolved.shortTermMemoriesCap) {
        return {
          kind: 'success',
          text: `Saved to global short-term memory ($DSH_HOME/${MEMORIES_DIR}/${GLOBAL_SHORT_TERM_FILENAME}, now ${chars} chars — OVER the ${resolved.shortTermMemoriesCap}-char cap). Ask the agent to compact it with the memory tool (action "compact": the agent decides entry by entry what stays verbatim, folds into dated summaries, or drops), or prune the file by hand.`,
        };
      }
      return {
        kind: 'success',
        text: `Saved to global short-term memory ($DSH_HOME/${MEMORIES_DIR}/${GLOBAL_SHORT_TERM_FILENAME}, now ${chars} chars; new sessions inject the whole note).`,
      };
    }
    case 'long':
    case 'workspace': {
      // The FIRST two "|" separate title and description; any further "|"
      // belongs to the text (single-line composer input).
      const parts = args.split('|');
      if (parts.length < 3) {
        return { kind: 'error', text: `${MEMORY_USAGE}\n\n"${sub}" needs two "|" separators: <title> | <description> | <text> (the description may be left empty).` };
      }
      const title = parts[0].trim();
      const rawDescription = parts[1].trim();
      const body = parts.slice(2).join('|').trim();
      if (title === '' || body === '') {
        return { kind: 'error', text: `"${sub}" needs a non-empty title and text (only the description may be empty).` };
      }
      const descriptionError = descriptionWriteError(rawDescription);
      if (descriptionError !== undefined) {
        return { kind: 'error', text: `"${sub}" description rejected: ${descriptionError}.` };
      }
      const description = rawDescription === '' ? undefined : rawDescription;
      if (sub === 'workspace') {
        signal?.throwIfAborted();
        const store = await resolveWorkspaceStore({ dshHome, cwd }, resolved, workspaceRegistry, signal);
        const written = await writeLongTermMemory(store.dir, title, body, description);
        return {
          kind: 'success',
          text: `Workspace memory saved: $DSH_HOME/${MEMORIES_DIR}/${WORKSPACE_MEMORIES_DIRNAME}/${basename(store.dir)}/${written.file} ("${title}") for workspace "${store.name}".`,
        };
      }
      const written = await writeLongTermMemory(globalLongTermDir(dshHome), title, body, description);
      return {
        kind: 'success',
        text: `Global long-term memory saved: $DSH_HOME/${MEMORIES_DIR}/${GLOBAL_LONG_TERM_DIRNAME}/${written.file} ("${title}").`,
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
 * @param {{ action: 'save' | 'compact' | 'long' | 'workspace', title?: string,
 *   description?: string, text: string }} args
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function runMemoryTool({ dshHome, cwd, workspaceRegistry }, resolved, { action, title, description, text }, signal) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('memory tool: "text" must be a non-empty string.');
  }
  signal?.throwIfAborted();
  if (action === 'save') {
    const { chars } = await appendShortTerm(dshHome, text.trim());
    if (chars > resolved.shortTermMemoriesCap) {
      return {
        ok: true,
        message: `Saved to global short-term memory — the note is now ${chars} chars, over the ${resolved.shortTermMemoriesCap}-char cap. Compact it NOW: call the memory tool with action "compact" and text = the rewritten note (decide entry by entry: keep useful ones verbatim, fold related ones into dated summary entries, drop finished threads — judge each entry's usefulness from its text and dates; get under ${resolved.shortTermMemoriesCap} chars).`,
      };
    }
    return {
      ok: true,
      message: `Saved to global short-term memory (now ${chars} chars; new sessions inject the whole note).`,
    };
  }
  if (action === 'compact') {
    const existing = await readTextIfPresent(globalShortTermFile(dshHome));
    const currentChars = (existing ?? '').replace(/\s+$/, '').length;
    const trimmed = text.trim();
    if (currentChars > 0 && trimmed.length >= currentChars) {
      throw new Error(`memory tool: "compact" must shorten the note (proposed ${trimmed.length} chars, current ${currentChars}).`);
    }
    const { chars } = await rewriteShortTerm(dshHome, trimmed);
    return {
      ok: true,
      message: chars > resolved.shortTermMemoriesCap
        ? `Compacted global short-term memory (now ${chars} chars — still over the ${resolved.shortTermMemoriesCap}-char cap; compact further on the next pass).`
        : `Compacted global short-term memory (now ${chars} chars; new sessions inject the whole note).`,
    };
  }
  if (action === 'long' || action === 'workspace') {
    const trimmedTitle = typeof title === 'string' ? title.trim() : '';
    if (trimmedTitle === '') {
      throw new Error(`memory tool: action "${action}" needs a non-empty "title".`);
    }
    const descriptionError = descriptionWriteError(description);
    if (descriptionError !== undefined) {
      throw new Error(`memory tool: ${descriptionError}.`);
    }
    const useDescription = typeof description === 'string' && description.trim() !== '' ? description.trim() : undefined;
    const dir = action === 'workspace'
      ? (await resolveWorkspaceStore({ dshHome, cwd }, resolved, workspaceRegistry, signal)).dir
      : globalLongTermDir(dshHome);
    const written = await writeLongTermMemory(dir, trimmedTitle, text.trim(), useDescription);
    const where = action === 'workspace'
      ? `Workspace memory saved: ${written.file} ("${trimmedTitle}") under ${dir}.`
      : `Global long-term memory saved: ${written.file} ("${trimmedTitle}") under ${dir}.`;
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
- action "save" appends a date-stamped note to the global short-term rolling note (transient pickup notes — durable knowledge belongs in a long/workspace file); include the time of day in the text only when it matters.
- action "compact" rewrites the short-term note with your compacted version when a save reports it is over the cap: you decide entry by entry — keep useful ones verbatim, fold related ones into dated summary entries, drop finished threads.
- action "long" creates/updates a global long-term memory file — the durable library you are expected to write to proactively during sessions: user corrections and preferences, repeated topics, durable cross-project facts (exactly when to write is defined by the session's injected guidance).
- action "workspace" does the same in this workspace's memory directory under $DSH_HOME/memories/workspace/ (this project's durable knowledge).
Give every "long"/"workspace" memory a one-line "description": it becomes the file's "Description:" line and the index entry other sessions discover the memory by — files without one are not listed in the injected index.`,
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
        description: {
          type: 'string',
          description: 'One-line description of a "long"/"workspace" memory: at most 1000 characters, no line breaks. Written as the "Description:" line right after the title heading and shown in the injected index; on update, omitting it keeps the existing line. Ignored for "save" and "compact".',
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
