import { runBdJson, runGtJson } from './bd.js';
import { debug } from './logging.js';

const log = debug('list-adapters');

/**
 * Build concrete `bd` CLI args for a subscription type + params.
 * Always includes `--json` for parseable output.
 *
 * @param {{ type: string, params?: Record<string, string | number | boolean> }} spec
 * @returns {string[]}
 */
export function mapSubscriptionToBdArgs(spec) {
  const t = String(spec.type);
  switch (t) {
    case 'all-issues': {
      return ['list', '--json'];
    }
    case 'epics': {
      return ['epic', 'status', '--json'];
    }
    case 'blocked-issues': {
      return ['blocked', '--json'];
    }
    case 'ready-issues': {
      return ['ready', '--limit', '1000', '--json'];
    }
    case 'in-progress-issues': {
      return ['list', '--json', '--status', 'in_progress'];
    }
    case 'closed-issues': {
      return ['list', '--json', '--status', 'closed'];
    }
    case 'issue-detail': {
      const p = spec.params || {};
      const id = String(p.id || '').trim();
      if (id.length === 0) {
        throw badRequest('Missing param: params.id');
      }
      return ['show', id, '--json'];
    }
    case 'mail-inbox': {
      // Use gt mail inbox --json for mail list
      return ['mail', 'inbox', '--json'];
    }
    default: {
      throw badRequest(`Unknown subscription type: ${t}`);
    }
  }
}

/**
 * Normalize mail list output for the registry.
 * - Ensures `id` is a string.
 * - Coerces timestamp to number for created_at and updated_at.
 * - Sets closed_at to null (mail items aren't "closed").
 *
 * @param {unknown} value
 * @returns {Array<{ id: string, created_at: number, updated_at: number, closed_at: number | null } & Record<string, unknown>>}
 */
export function normalizeMailList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  /** @type {Array<{ id: string, created_at: number, updated_at: number, closed_at: number | null } & Record<string, unknown>>} */
  const out = [];
  for (const it of value) {
    const id = String(it.id ?? '');
    if (id.length === 0) {
      continue;
    }
    const timestamp_val = parseTimestamp(it.timestamp);
    out.push({
      ...it,
      id,
      created_at: timestamp_val,
      updated_at: timestamp_val,
      closed_at: null
    });
  }
  return out;
}

/**
 * Normalize bd list output to minimal Issue shape used by the registry.
 * - Ensures `id` is a string.
 * - Coerces timestamps to numbers.
 * - `closed_at` defaults to null when missing or invalid.
 *
 * @param {unknown} value
 * @returns {Array<{ id: string, created_at: number, updated_at: number, closed_at: number | null } & Record<string, unknown>>}
 */
export function normalizeIssueList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  /** @type {Array<{ id: string, created_at: number, updated_at: number, closed_at: number | null } & Record<string, unknown>>} */
  const out = [];
  for (const it of value) {
    const id = String(it.id ?? '');
    if (id.length === 0) {
      continue;
    }
    const created_at = parseTimestamp(/** @type {any} */ (it).created_at);
    const updated_at = parseTimestamp(it.updated_at);
    const closed_raw = it.closed_at;
    /** @type {number | null} */
    let closed_at = null;
    if (closed_raw !== undefined && closed_raw !== null) {
      const n = parseTimestamp(closed_raw);
      closed_at = Number.isFinite(n) ? n : null;
    }
    out.push({
      ...it,
      id,
      created_at: Number.isFinite(created_at) ? created_at : 0,
      updated_at: Number.isFinite(updated_at) ? updated_at : 0,
      closed_at
    });
  }
  return out;
}

/**
 * @typedef {Object} FetchListResultSuccess
 * @property {true} ok
 * @property {Array<{ id: string, updated_at: number, closed_at: number | null } & Record<string, unknown>>} items
 */

/**
 * @typedef {Object} FetchListResultFailure
 * @property {false} ok
 * @property {{ code: string, message: string, details?: Record<string, unknown> }} error
 */

/**
 * Execute the mapped `bd` command for a subscription spec and return normalized items.
 * Errors do not throw; they are surfaced as a structured object.
 *
 * @param {{ type: string, params?: Record<string, string | number | boolean> }} spec
 * @param {{ cwd?: string }} [options] - Optional working directory for bd command
 * @returns {Promise<FetchListResultSuccess | FetchListResultFailure>}
 */
export async function fetchListForSubscription(spec, options = {}) {
  /** @type {string[]} */
  let args;
  try {
    args = mapSubscriptionToBdArgs(spec);
  } catch (err) {
    // Surface bad requests (e.g., missing params)
    log('mapSubscriptionToBdArgs failed for %o: %o', spec, err);
    const e = toErrorObject(err);
    return { ok: false, error: e };
  }

  try {
    // Use gt for mail-inbox, bd for everything else
    const isMailInbox = String(spec.type) === 'mail-inbox';
    const res = isMailInbox
      ? await runGtJson(args, { cwd: options.cwd })
      : await runBdJson(args, { cwd: options.cwd });
    const cmdName = isMailInbox ? 'gt' : 'bd';

    if (!res || res.code !== 0 || !('stdoutJson' in res)) {
      log(
        '%s failed for %o (args=%o) code=%s stderr=%s',
        cmdName,
        spec,
        args,
        res?.code,
        res?.stderr || ''
      );
      return {
        ok: false,
        error: {
          code: `${cmdName}_error`,
          message: String(res?.stderr || `${cmdName} failed`),
          details: { exit_code: res?.code ?? -1 }
        }
      };
    }
    // bd show may return a single object; normalize to an array first
    let raw = Array.isArray(res.stdoutJson)
      ? res.stdoutJson
      : res.stdoutJson && typeof res.stdoutJson === 'object'
        ? [res.stdoutJson]
        : [];

    // Special-case mapping for `epics`: current bd output nests the epic under
    // an `epic` key and exposes counters at the top level. Flatten so that
    // each entry has a top-level `id` and core fields expected by the registry.
    if (String(spec.type) === 'epics') {
      raw = raw.map((it) => {
        if (it && typeof it === 'object' && 'epic' in it) {
          const e = /** @type {any} */ (it).epic || {};
          /** @type {Record<string, unknown>} */
          const flat = {
            // Required minimal fields for registry + client rendering
            id: String(e.id ?? ''),
            title: e.title,
            status: e.status,
            issue_type: e.issue_type || 'epic',
            created_at: e.created_at,
            updated_at: e.updated_at,
            closed_at: e.closed_at ?? null,
            // Preserve useful counters from bd output
            total_children: /** @type {any} */ (it).total_children,
            closed_children: /** @type {any} */ (it).closed_children,
            eligible_for_close: /** @type {any} */ (it).eligible_for_close
          };
          return flat;
        }
        return it;
      });
    }

    // For mail-inbox, normalize differently since mail doesn't have issue fields
    const items = isMailInbox ? normalizeMailList(raw) : normalizeIssueList(raw);
    return { ok: true, items };
  } catch (err) {
    log('%s invocation failed for %o (args=%o): %o', cmdName, spec, args, err);
    return {
      ok: false,
      error: {
        code: `${cmdName}_error`,
        message:
          (err && /** @type {any} */ (err).message) || `${cmdName} invocation failed`
      }
    };
  }
}

/**
 * Create a `bad_request` error object.
 *
 * @param {string} message
 */
function badRequest(message) {
  const e = new Error(message);
  // @ts-expect-error add code
  e.code = 'bad_request';
  return e;
}

/**
 * Normalize arbitrary thrown values to a structured error object.
 *
 * @param {unknown} err
 * @returns {FetchListResultFailure['error']}
 */
function toErrorObject(err) {
  if (err && typeof err === 'object') {
    const any = /** @type {{ code?: unknown, message?: unknown }} */ (err);
    const code = typeof any.code === 'string' ? any.code : 'bad_request';
    const message =
      typeof any.message === 'string' ? any.message : 'Request error';
    return { code, message };
  }
  return { code: 'bad_request', message: 'Request error' };
}

/**
 * Parse a bd timestamp string to epoch ms using Date.parse.
 * Falls back to numeric coercion when parsing fails.
 *
 * @param {unknown} v
 * @returns {number}
 */
function parseTimestamp(v) {
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) {
      return ms;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : 0;
  }
  return 0;
}
