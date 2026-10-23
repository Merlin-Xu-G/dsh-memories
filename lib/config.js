/**
 * @local/dsh-memories — plugin config: validation and the Standard Schema.
 *
 * Unknown keys fail at activation so typos never silently disable a budget.
 * `Config` implements the `~standard.validate` protocol cordis
 * `resolveConfig` calls — dependency-free on purpose (a local bundle must
 * not need zod or Schemastery installed beside it).
 */

import { RESERVED_PATH_SEGMENTS } from './paths.js';

const TOP_LEVEL_KEYS = new Set([
  'dshHome',
  'longTermMaxChars',
  'shortTermMemoriesCap',
  // 'shortTermMaxChars' is accepted as a deprecated alias of
  // shortTermMemoriesCap (0.6.x name); setting both is an error.
  'shortTermMaxChars',
  'workspaceMaxChars',
  'projectRootMarkers',
]);

const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'];

/**
 * Read a positive-integer option.
 * @param {Record<string, unknown>} raw owner object of the field.
 * @param {string} name field name for diagnostics.
 * @param {number} fallback value used when the field is absent.
 * @returns {number}
 */
function readPositiveInt(raw, name, fallback) {
  const value = raw[name] === undefined ? fallback : raw[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`dsh-memories config "${name}" must be a positive integer`);
  }
  return value;
}

/**
 * Validate and normalize the plugin config.
 *
 * @param {unknown} input raw row config; `{}`/`undefined` selects defaults.
 * @returns {Readonly<{dshHome: string | undefined, longTermMaxChars: number,
 *   shortTermMemoriesCap: number, workspaceMaxChars: number,
 *   projectRootMarkers: readonly string[]}>}
 */
export function resolveConfig(input) {
  const raw = input === undefined || input === null ? {} : input;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('dsh-memories config must be an object');
  }
  const unknown = Object.keys(raw).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `dsh-memories config has unknown key(s) ${unknown.join(', ')} — allowed keys: ${[...TOP_LEVEL_KEYS].join(', ')}`,
    );
  }
  let dshHome = raw.dshHome;
  if (dshHome !== undefined) {
    if (typeof dshHome !== 'string' || dshHome.trim() === '') {
      throw new TypeError('dsh-memories config "dshHome" must be a non-empty string when present');
    }
    dshHome = dshHome.trim();
  }
  const markersRaw = raw.projectRootMarkers === undefined
    ? [...DEFAULT_PROJECT_ROOT_MARKERS]
    : raw.projectRootMarkers;
  if (!Array.isArray(markersRaw) || markersRaw.some((m) => typeof m !== 'string' || m.trim() === '')) {
    throw new TypeError('dsh-memories config "projectRootMarkers" must be an array of non-empty strings');
  }
  if (raw.shortTermMemoriesCap !== undefined && raw.shortTermMaxChars !== undefined) {
    throw new Error(
      'dsh-memories config sets both "shortTermMemoriesCap" and its deprecated alias "shortTermMaxChars" — keep only "shortTermMemoriesCap"',
    );
  }
  const capSource = raw.shortTermMemoriesCap !== undefined
    ? 'shortTermMemoriesCap'
    : raw.shortTermMaxChars !== undefined
      ? 'shortTermMaxChars'
      : 'shortTermMemoriesCap';
  const projectRootMarkers = Object.freeze(
    markersRaw.filter((m) => !RESERVED_PATH_SEGMENTS.has(m) && !/[\\/]/.test(m)),
  );
  return Object.freeze({
    dshHome,
    longTermMaxChars: readPositiveInt(raw, 'longTermMaxChars', 8192),
    shortTermMemoriesCap: readPositiveInt(raw, capSource, 10000),
    workspaceMaxChars: readPositiveInt(raw, 'workspaceMaxChars', 8192),
    projectRootMarkers,
  });
}

/**
 * The plugin's Config schema (`Config['~standard'].validate`). Settings
 * surfaces will not render a live form for a vendor-unknown schema; the row
 * config in `cordis.patch.yml` remains the declarative way to configure.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: '@local/dsh-memories',
    validate(raw) {
      try {
        return { value: resolveConfig(raw) };
      } catch (error) {
        return {
          issues: [
            {
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    },
  },
};
