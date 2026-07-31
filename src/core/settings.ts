/**
 * Reads and edits `.claude/settings.json` to register or remove Shoot's hooks.
 *
 * The guiding rule: this is the USER'S file. It may contain unrelated hooks,
 * permissions, env vars, and settings Shoot knows nothing about. Every edit here
 * is surgical — merge in place, remove only what Shoot itself added, and never
 * rewrite or drop a key we did not create.
 *
 * Shoot's own entries are identified by a marker embedded in the hook command
 * args (SHOOT_MARKER), so uninstall can find them without guessing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Hook events Shoot can register for. */
export type HookEvent = 'Stop' | 'SubagentStop';

/**
 * Substring identifying a hook entry as Shoot's. It appears in the script path we
 * register, so it survives round-tripping through the settings file.
 *
 * Deliberately specific: matching bare "shoot" would risk claiming an unrelated
 * user hook living under, say, `scripts/screenshoot.js`. Matching the compiled
 * entry filename we actually install is far harder to collide with.
 */
export const SHOOT_MARKER = 'shoot-hook.js';

export const SETTINGS_DIR = '.claude';
export const SETTINGS_FILE = 'settings.json';

export function settingsPath(cwd: string): string {
  return join(cwd, SETTINGS_DIR, SETTINGS_FILE);
}

/** Loose shapes — the real file has many keys we must preserve untouched. */
export interface HookCommand {
  type: string;
  command?: string;
  args?: string[];
  [key: string]: unknown;
}

export interface HookMatcher {
  matcher?: string;
  hooks?: HookCommand[];
  [key: string]: unknown;
}

export type SettingsShape = Record<string, unknown> & {
  hooks?: Record<string, HookMatcher[]>;
};

/** Read settings, or an empty object if absent/corrupt. */
export function readSettings(cwd: string): SettingsShape {
  const file = settingsPath(cwd);
  if (!existsSync(file)) return {};

  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as SettingsShape;
  } catch {
    return {};
  }
}

/** True when the settings file exists but could not be parsed. */
export function settingsCorrupt(cwd: string): boolean {
  const file = settingsPath(cwd);
  if (!existsSync(file)) return false;
  try {
    JSON.parse(readFileSync(file, 'utf8'));
    return false;
  } catch {
    return true;
  }
}

export function writeSettings(cwd: string, settings: SettingsShape): void {
  const file = settingsPath(cwd);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

/**
 * The hook entry Shoot registers.
 *
 * Exec form with an explicit `node` command and a script path, rather than the
 * `shoot` bin name: on Windows, npm installs bins as `.cmd` shims that do not
 * resolve the same way across shells. Invoking node directly against a real file
 * path sidesteps that entirely.
 *
 * `${CLAUDE_PROJECT_DIR}` is expanded by Claude Code, so the entry stays valid
 * regardless of the directory the session starts in.
 */
export function shootHookCommand(scriptPath: string): HookCommand {
  return { type: 'command', command: 'node', args: [scriptPath] };
}

/** Is this hook entry one of Shoot's? */
export function isShootHook(hook: HookCommand): boolean {
  const args = Array.isArray(hook.args) ? hook.args : [];
  const inArgs = args.some((a) => typeof a === 'string' && a.includes(SHOOT_MARKER));
  const inCommand = typeof hook.command === 'string' && hook.command.includes(SHOOT_MARKER);
  return inArgs || inCommand;
}

/**
 * Register Shoot's hook for the given events, preserving everything else.
 *
 * Idempotent: re-running replaces Shoot's own entry rather than appending a
 * duplicate, so `shoot init` twice does not double-verify.
 */
export function addShootHooks(
  settings: SettingsShape,
  events: readonly HookEvent[],
  scriptPath: string,
): SettingsShape {
  const next: SettingsShape = { ...settings };
  const hooks: Record<string, HookMatcher[]> = { ...(next.hooks ?? {}) };

  for (const event of events) {
    const existing = Array.isArray(hooks[event]) ? [...(hooks[event] as HookMatcher[])] : [];

    // Strip any previous Shoot entries, keeping the user's own intact.
    const cleaned = existing
      .map((matcher) => {
        const inner = Array.isArray(matcher.hooks) ? matcher.hooks : [];
        return { ...matcher, hooks: inner.filter((h) => !isShootHook(h)) };
      })
      // Drop matcher groups that existed only to hold Shoot's hook.
      .filter((matcher) => (matcher.hooks?.length ?? 0) > 0);

    cleaned.push({ hooks: [shootHookCommand(scriptPath)] });
    hooks[event] = cleaned;
  }

  next.hooks = hooks;
  return next;
}

/**
 * Remove only Shoot's entries. Unrelated hooks, and unrelated settings keys, are
 * left exactly as they were. Empty containers Shoot created are cleaned up, but
 * an empty `hooks` object the user had already is not removed.
 */
export function removeShootHooks(settings: SettingsShape): SettingsShape {
  const next: SettingsShape = { ...settings };
  if (next.hooks === undefined) return next;

  const hooks: Record<string, HookMatcher[]> = {};

  for (const [event, matchers] of Object.entries(next.hooks)) {
    if (!Array.isArray(matchers)) {
      hooks[event] = matchers as unknown as HookMatcher[];
      continue;
    }

    const cleaned = matchers
      .map((matcher) => {
        const inner = Array.isArray(matcher.hooks) ? matcher.hooks : [];
        const kept = inner.filter((h) => !isShootHook(h));
        return { ...matcher, hooks: kept };
      })
      .filter((matcher) => (matcher.hooks?.length ?? 0) > 0);

    // Only keep the event key if something of the user's survives.
    if (cleaned.length > 0) hooks[event] = cleaned;
  }

  if (Object.keys(hooks).length > 0) {
    next.hooks = hooks;
  } else {
    delete next.hooks;
  }
  return next;
}

export interface RegistrationInfo {
  event: HookEvent;
  registered: boolean;
  /** Script paths found for Shoot's entries under this event. */
  paths: string[];
}

/** Which events Shoot is currently registered for, and with what paths. */
export function findRegistrations(
  settings: SettingsShape,
  events: readonly HookEvent[] = ['Stop', 'SubagentStop'],
): RegistrationInfo[] {
  return events.map((event) => {
    const matchers = settings.hooks?.[event];
    const paths: string[] = [];

    if (Array.isArray(matchers)) {
      for (const matcher of matchers) {
        for (const hook of Array.isArray(matcher.hooks) ? matcher.hooks : []) {
          if (!isShootHook(hook)) continue;
          const args = Array.isArray(hook.args) ? hook.args : [];
          for (const a of args) if (typeof a === 'string') paths.push(a);
        }
      }
    }

    return { event, registered: paths.length > 0, paths };
  });
}

/** Count non-Shoot hook entries, so uninstall can report what it preserved. */
export function countForeignHooks(settings: SettingsShape): number {
  let count = 0;
  for (const matchers of Object.values(settings.hooks ?? {})) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      for (const hook of Array.isArray(matcher.hooks) ? matcher.hooks : []) {
        if (!isShootHook(hook)) count++;
      }
    }
  }
  return count;
}

/**
 * Resolve a registered path for existence checking, expanding
 * `${CLAUDE_PROJECT_DIR}` the way Claude Code would.
 */
export function resolveHookPath(registeredPath: string, cwd: string): string {
  return registeredPath.replace(/\$\{CLAUDE_PROJECT_DIR\}/g, cwd).replace(/^["']|["']$/g, '');
}
