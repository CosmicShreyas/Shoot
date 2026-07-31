/**
 * OpenAI Codex CLI adapter.
 *
 * Built against the contract documented at https://learn.chatgpt.com/docs/hooks
 * (developers.openai.com/codex/hooks 308-redirects there, so that page is
 * canonical). Verified against the primary source rather than inferred from
 * Claude Code's shape — the two differ in ways that matter.
 *
 * CONFIG
 *   `.codex/hooks.json` in the project (Codex also reads `~/.codex/hooks.json`
 *   and `config.toml` variants). Events live under a `"hooks"` wrapper:
 *     { "hooks": { "Stop": [ { "hooks": [ { "type": "command", ... } ] } ] } }
 *
 * INPUT (Stop, all snake_case)
 *   session_id, turn_id, cwd, hook_event_name, permission_mode,
 *   stop_hook_active, last_assistant_message, transcript_path, model
 *
 *   `turn_id` is a Codex-specific extension with no Claude Code equivalent.
 *   `permission_mode` is deliberately NOT read: Shoot has no business varying
 *   its verification based on the host's permission posture, and the field's
 *   values are host-controlled strings we'd rather not branch on.
 *
 * OUTPUT — this is where Codex genuinely differs
 *   `{"decision":"block","reason":"..."}` tells Codex to CONTINUE the turn, using
 *   `reason` as the next prompt. Claude Code's `block` PREVENTS stopping. The wire
 *   shape is identical; the underlying semantics are inverted. Both happen to
 *   produce the behavior Shoot wants on a failed check — the agent keeps working
 *   with the real errors in hand — so the same verdict maps cleanly onto both.
 *   `reason` must be non-empty or the hook fails.
 *
 *   `systemMessage` is documented as parsed but "supported only for other events",
 *   i.e. NOT usable on Stop. So the pass-path receipt cannot ride the stdout JSON
 *   the way it does on Claude Code. Instead we emit `{}` (a clean allow) and print
 *   the receipt to stderr for the human. Consequence, stated plainly: on Codex the
 *   receipt reaches the terminal but not the host UI.
 *
 * KNOWN HOST BUG
 *   openai/codex#23784 (open): on Windows, non-ASCII text in
 *   `last_assistant_message` can be serialized as invalid JSON, so stdin is
 *   unparseable before Shoot runs. Our parser already fails open on malformed
 *   input, so the outcome is a skipped verification rather than a crash — but it
 *   IS a silent miss, which is why `warnings()` says so at install time.
 */

import {
  addCodexHooks,
  codexHooksPath,
  readCodexHooks,
  removeCodexHooks,
  findCodexRegistrations,
  writeCodexHooks,
} from '../core/codexConfig.js';
import { writeHookShim, CODEX_SHIM_RELATIVE_PATH } from '../core/shim.js';
import type {
  AdapterResponse,
  HookInput,
  InstallOptions,
  InstallResult,
  PlatformAdapter,
  Verdict,
} from './types.js';

/** Path registered in Codex's hooks.json. Codex has no ${CLAUDE_PROJECT_DIR}. */
export const CODEX_SHIM_REGISTERED_PATH = './.codex/shoot-hook.js';

/** Wire shape Codex expects on stdout for a Stop hook. */
interface CodexOutput {
  decision?: 'block';
  reason?: string;
}

export const codexAdapter: PlatformAdapter = {
  id: 'codex',
  displayName: 'OpenAI Codex CLI',
  detectDirectory: '.codex',

  parseInput(raw: string, fallbackCwd: string): HookInput | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // See openai/codex#23784 — malformed stdin is a real, known possibility
      // here, not just a theoretical one. Fail open.
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

    const p = parsed as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');

    return {
      // Codex supplies both session_id and turn_id. The circuit breaker wants the
      // longest-lived stable identifier, which is the session.
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
        return { stdout: '', stderr: '', exitCode: 0 };

      case 'allowWithNotice':
        // No systemMessage support on Stop, so the notice goes to the human via
        // stderr only. stdout stays a clean allow.
        return { stdout: '', stderr: `${verdict.notice}\n`, exitCode: 0 };

      case 'block': {
        // reason must be non-empty; guard rather than emit a failing hook.
        const reason =
          verdict.reason.trim() === ''
            ? 'Verification did not pass. Re-run the checks before reporting success.'
            : verdict.reason;
        const out: CodexOutput = { decision: 'block', reason };
        const firstLine = reason.split('\n')[0] ?? '';
        return { stdout: `${JSON.stringify(out)}\n`, stderr: `${firstLine}\n`, exitCode: 0 };
      }
    }
  },

  install(cwd: string, options: InstallOptions): InstallResult {
    writeHookShim(cwd, options.hookEntryPath, CODEX_SHIM_RELATIVE_PATH);
    const events = options.verifySubagents ? ['Stop', 'SubagentStop'] : ['Stop'];
    writeCodexHooks(
      cwd,
      addCodexHooks(readCodexHooks(cwd), events, CODEX_SHIM_REGISTERED_PATH),
    );
    return { paths: [CODEX_SHIM_RELATIVE_PATH, codexHooksPath(cwd)], events };
  },

  uninstall(cwd: string): void {
    const current = readCodexHooks(cwd);
    const cleaned = removeCodexHooks(current);
    if (JSON.stringify(cleaned) !== JSON.stringify(current)) writeCodexHooks(cwd, cleaned);
  },

  registrations(cwd: string): { event: string; paths: string[] }[] {
    return findCodexRegistrations(readCodexHooks(cwd))
      .filter((r) => r.registered)
      .map((r) => ({ event: r.event, paths: r.paths }));
  },

  warnings(): string[] {
    const out = [
      'Codex support is new. Shoot was built against the documented Stop-hook ' +
        'contract but has had far less real-session testing than the Claude Code path.',
      'Codex does not support systemMessage on Stop, so the pass receipt prints to ' +
        'your terminal but will not appear in the Codex UI. Blocking works normally.',
    ];

    if (process.platform === 'win32') {
      out.push(
        'On Windows, a known open Codex bug (openai/codex#23784) can send malformed ' +
          'JSON when the assistant message contains non-ASCII characters. Shoot fails ' +
          'open in that case, so verification is SKIPPED rather than crashing — but it ' +
          'is skipped silently by the host, not by Shoot.',
      );
    }

    return out;
  },
};
