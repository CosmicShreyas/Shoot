/**
 * Adapter registry and platform autodetection.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { claudeCodeAdapter } from './claudeCode.js';
import { codexAdapter } from './codex.js';
import type { PlatformAdapter, PlatformId } from './types.js';

export const ADAPTERS: readonly PlatformAdapter[] = [claudeCodeAdapter, codexAdapter];

export function getAdapter(id: PlatformId): PlatformAdapter {
  const found = ADAPTERS.find((a) => a.id === id);
  // Fall back rather than throw: an unknown platform in a hand-edited config must
  // not break the hook. Claude Code is the better-tested path.
  return found ?? claudeCodeAdapter;
}

/**
 * Which platforms look present in this project, by config directory. Returns all
 * matches — a project can plausibly have both.
 */
export function detectPlatforms(cwd: string): PlatformAdapter[] {
  return ADAPTERS.filter((a) => existsSync(join(cwd, a.detectDirectory)));
}
