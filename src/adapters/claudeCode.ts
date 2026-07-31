/**
 * Claude Code adapter.
 *
 * Contract (docs: code.claude.com/docs/en/hooks):
 *   - Input: JSON on stdin. `session_id`, `transcript_path`, `cwd`,
 *     `hook_event_name`, and for Stop/SubagentStop also `last_assistant_message`
 *     and `stop_hook_active`.
 *   - Allow: exit 0 with no output, or JSON with no `decision` field.
 *   - Block: exit 0 with `{"decision":"block","reason":"..."}`.
 *   - `systemMessage` shows the user a message WITHOUT continuing the turn.
 *
 * Critical: `hookSpecificOutput.additionalContext` continues the conversation on
 * Stop/SubagentStop. Using it on an allow path caused a real infinite loop, so it
 * is never emitted here — every notice goes out as `systemMessage`.
 *
 * Behavior here is unchanged from the pre-adapter implementation; this file only
 * formalizes it behind the PlatformAdapter interface.
 */

import { existsSync } from 'node:fs';

import {
  addShootHooks,
  countForeignHooks,
  findRegistrations,
  readSettings,
  removeShootHooks,
  resolveHookPath,
  settingsPath,
  writeSettings,
  type HookEvent,
} from '../core/settings.js';
import { writeHookShim, SHIM_REGISTERED_PATH, SHIM_RELATIVE_PATH } from '../core/shim.js';
import type {
  AdapterResponse,
  HookInput,
  InstallOptions,
  InstallResult,
  PlatformAdapter,
  Verdict,
} from './types.js';

/** Wire shape Claude Code expects on stdout. Note: no additionalContext, ever. */
interface ClaudeCodeOutput {
  decision?: 'block';
  reason?: string;
  systemMessage?: string;
}

export const claudeCodeAdapter: PlatformAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  detectDirectory: '.claude',

  parseInput(raw: string, fallbackCwd: string): HookInput | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    // Arrays are objects too, but are not valid hook payloads.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

    const p = parsed as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');

    return {
      sessionId: str(p['session_id']),
      lastAssistantMessage: str(p['last_assistant_message']),
      cwd: str(p['cwd']) || fallbackCwd,
      hookEventName: str(p['hook_event_name']),
      transcriptPath: str(p['transcript_path']),
      stopHookActive: p['stop_hook_active'] === true,
    };
  },

  formatResponse(verdict: Verdict): AdapterResponse {
    switch (verdict.kind) {
      case 'allowSilent':
        // No output at all is the contract's plainest "allow".
        return { stdout: '', stderr: '', exitCode: 0 };

      case 'allowWithNotice': {
        const out: ClaudeCodeOutput = { systemMessage: verdict.notice };
        return { stdout: `${JSON.stringify(out)}\n`, stderr: `${verdict.notice}\n`, exitCode: 0 };
      }

      case 'block': {
        const out: ClaudeCodeOutput = { decision: 'block', reason: verdict.reason };
        // The terminal echo is the reason's first line — the framing, not the
        // whole diagnostic dump.
        const firstLine = verdict.reason.split('\n')[0] ?? '';
        return {
          stdout: `${JSON.stringify(out)}\n`,
          stderr: `${firstLine}\n`,
          exitCode: 0,
        };
      }
    }
  },

  install(cwd: string, options: InstallOptions): InstallResult {
    writeHookShim(cwd, options.hookEntryPath);
    const events: HookEvent[] = options.verifySubagents ? ['Stop', 'SubagentStop'] : ['Stop'];
    writeSettings(cwd, addShootHooks(readSettings(cwd), events, SHIM_REGISTERED_PATH));
    return { paths: [SHIM_RELATIVE_PATH, settingsPath(cwd)], events };
  },

  uninstall(cwd: string): void {
    const settings = readSettings(cwd);
    const cleaned = removeShootHooks(settings);
    if (JSON.stringify(cleaned) !== JSON.stringify(settings)) writeSettings(cwd, cleaned);
  },

  registrations(cwd: string): { event: string; paths: string[] }[] {
    return findRegistrations(readSettings(cwd))
      .filter((r) => r.registered)
      .map((r) => ({ event: r.event, paths: r.paths }));
  },

  warnings(): string[] {
    return [];
  },
};

/** Re-exported for status/doctor, which need to resolve and check paths. */
export { resolveHookPath, countForeignHooks, existsSync };
