/**
 * Reads and edits `.codex/hooks.json` to register or remove Shoot's hooks.
 *
 * Same guiding rule as the Claude Code equivalent: this is the USER'S file. Merge
 * in place, remove only what Shoot added, never drop a key we didn't create.
 *
 * Structure per https://learn.chatgpt.com/docs/hooks — note the `hooks` wrapper,
 * with matcher groups holding handler arrays:
 *
 *   {
 *     "description": "...",
 *     "hooks": {
 *       "Stop": [ { "hooks": [ { "type": "command", "command": "node", ... } ] } ]
 *     }
 *   }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { SHOOT_MARKER } from './settings.js';

export const CODEX_DIR = '.codex';
export const CODEX_HOOKS_FILE = 'hooks.json';

export function codexHooksPath(cwd: string): string {
  return join(cwd, CODEX_DIR, CODEX_HOOKS_FILE);
}

export interface CodexHandler {
  type: string;
  command?: string;
  args?: string[];
  /** Codex-specific: overrides `command` on Windows. */
  commandWindows?: string;
  timeout?: number;
  [key: string]: unknown;
}

export interface CodexMatcherGroup {
  matcher?: string;
  hooks?: CodexHandler[];
  [key: string]: unknown;
}

export type CodexHooksFile = Record<string, unknown> & {
  hooks?: Record<string, CodexMatcherGroup[]>;
};

export function readCodexHooks(cwd: string): CodexHooksFile {
  const file = codexHooksPath(cwd);
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as CodexHooksFile;
  } catch {
    return {};
  }
}

export function codexHooksCorrupt(cwd: string): boolean {
  const file = codexHooksPath(cwd);
  if (!existsSync(file)) return false;
  try {
    JSON.parse(readFileSync(file, 'utf8'));
    return false;
  } catch {
    return true;
  }
}

export function writeCodexHooks(cwd: string, contents: CodexHooksFile): void {
  const file = codexHooksPath(cwd);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
}

/** Shoot's handler entry. Plain `node <path>`, same rationale as Claude Code. */
export function shootCodexHandler(scriptPath: string): CodexHandler {
  return { type: 'command', command: 'node', args: [scriptPath] };
}

export function isShootCodexHook(handler: CodexHandler): boolean {
  const args = Array.isArray(handler.args) ? handler.args : [];
  const inArgs = args.some((a) => typeof a === 'string' && a.includes(SHOOT_MARKER));
  const inCommand = typeof handler.command === 'string' && handler.command.includes(SHOOT_MARKER);
  return inArgs || inCommand;
}

/** Register Shoot for the given events, idempotently, preserving everything else. */
export function addCodexHooks(
  file: CodexHooksFile,
  events: readonly string[],
  scriptPath: string,
): CodexHooksFile {
  const next: CodexHooksFile = { ...file };
  const hooks: Record<string, CodexMatcherGroup[]> = { ...(next.hooks ?? {}) };

  for (const event of events) {
    const existing = Array.isArray(hooks[event]) ? [...(hooks[event] as CodexMatcherGroup[])] : [];

    const cleaned = existing
      .map((group) => {
        const inner = Array.isArray(group.hooks) ? group.hooks : [];
        return { ...group, hooks: inner.filter((h) => !isShootCodexHook(h)) };
      })
      .filter((group) => (group.hooks?.length ?? 0) > 0);

    cleaned.push({ hooks: [shootCodexHandler(scriptPath)] });
    hooks[event] = cleaned;
  }

  next.hooks = hooks;
  return next;
}

/** Remove only Shoot's entries. */
export function removeCodexHooks(file: CodexHooksFile): CodexHooksFile {
  const next: CodexHooksFile = { ...file };
  if (next.hooks === undefined) return next;

  const hooks: Record<string, CodexMatcherGroup[]> = {};

  for (const [event, groups] of Object.entries(next.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups as unknown as CodexMatcherGroup[];
      continue;
    }

    const cleaned = groups
      .map((group) => {
        const inner = Array.isArray(group.hooks) ? group.hooks : [];
        return { ...group, hooks: inner.filter((h) => !isShootCodexHook(h)) };
      })
      .filter((group) => (group.hooks?.length ?? 0) > 0);

    if (cleaned.length > 0) hooks[event] = cleaned;
  }

  if (Object.keys(hooks).length > 0) {
    next.hooks = hooks;
  } else {
    delete next.hooks;
  }
  return next;
}

export function findCodexRegistrations(
  file: CodexHooksFile,
  events: readonly string[] = ['Stop', 'SubagentStop'],
): { event: string; registered: boolean; paths: string[] }[] {
  return events.map((event) => {
    const groups = file.hooks?.[event];
    const paths: string[] = [];

    if (Array.isArray(groups)) {
      for (const group of groups) {
        for (const handler of Array.isArray(group.hooks) ? group.hooks : []) {
          if (!isShootCodexHook(handler)) continue;
          for (const a of Array.isArray(handler.args) ? handler.args : []) {
            if (typeof a === 'string') paths.push(a);
          }
        }
      }
    }

    return { event, registered: paths.length > 0, paths };
  });
}

export function countForeignCodexHooks(file: CodexHooksFile): number {
  let count = 0;
  for (const groups of Object.values(file.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const handler of Array.isArray(group.hooks) ? group.hooks : []) {
        if (!isShootCodexHook(handler)) count++;
      }
    }
  }
  return count;
}
