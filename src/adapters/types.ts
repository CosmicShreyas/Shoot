/**
 * The platform adapter contract.
 *
 * Shoot's verification pipeline (claimDetector -> verificationRunner ->
 * circuitBreaker) is platform-neutral. Everything platform-specific is confined
 * to an adapter, which does exactly two jobs:
 *
 *   1. parse that platform's stdin payload into a normalized `HookInput`
 *   2. format a normalized `Verdict` into that platform's expected stdout/exit
 *
 * Adapters hold no verification logic. If you find yourself wanting to change
 * *what* gets checked inside an adapter, it belongs in the core instead.
 */

import type { ClaimResult } from '../core/claimDetector.js';
import type { VerificationReport } from '../core/verificationRunner.js';

/** Platforms Shoot can install into. */
export type PlatformId = 'claude-code' | 'codex';

/**
 * Normalized hook input. Adapters map their platform's field names onto this.
 * Every field is treated as untrusted: a malformed payload must degrade to
 * "allow", never crash the host session.
 */
export interface HookInput {
  sessionId: string;
  lastAssistantMessage: string;
  cwd: string;
  hookEventName: string;
  transcriptPath: string;
  /**
   * True when this stop event is itself the product of a hook having already
   * continued the current turn. Re-running the pipeline here is what creates an
   * infinite loop, so every adapter must surface this faithfully.
   */
  stopHookActive: boolean;
}

/**
 * What the core decided, in platform-neutral terms. Adapters translate this
 * into whatever wire format their host expects.
 */
export type Verdict =
  /** Say nothing, allow the turn to end. */
  | { kind: 'allowSilent' }
  /** Allow the turn to end, but show the user a message. */
  | { kind: 'allowWithNotice'; notice: string }
  /** Do not let the turn end; hand this text back to the agent. */
  | { kind: 'block'; reason: string };

/** A fully-formed response, ready to write. */
export interface AdapterResponse {
  /** JSON (or empty string for "no output at all") to write to stdout. */
  stdout: string;
  /** Human-facing framing line for stderr. Never machine-read. */
  stderr: string;
  exitCode: number;
}

export interface PlatformAdapter {
  readonly id: PlatformId;
  /** Human-readable name, for CLI output. */
  readonly displayName: string;

  /** Parse this platform's stdin JSON. Returns null if unusable. */
  parseInput(raw: string, fallbackCwd: string): HookInput | null;

  /** Render a verdict into this platform's wire format. */
  formatResponse(verdict: Verdict, input: HookInput): AdapterResponse;

  /**
   * Directory whose presence suggests this platform is in use, relative to the
   * project root (e.g. `.claude`). Used by `shoot init` for autodetection.
   */
  readonly detectDirectory: string;

  /**
   * Register Shoot's hook for this platform, writing whatever config files it
   * needs. Returns paths touched, for reporting.
   */
  install(cwd: string, options: InstallOptions): InstallResult;

  /** Remove Shoot's own entries. Must leave unrelated config untouched. */
  uninstall(cwd: string): void;

  /** Which events Shoot is currently registered for, and with what script paths. */
  registrations(cwd: string): { event: string; paths: string[] }[];

  /**
   * Platform-specific caveats worth telling the user at install time. Empty when
   * there's nothing to warn about. Never silently degrade — say it out loud.
   */
  warnings(): string[];
}

export interface InstallOptions {
  /** Absolute path to the compiled hook entry point to forward to. */
  hookEntryPath: string;
  /** Whether to also register the subagent-stop equivalent. */
  verifySubagents: boolean;
}

export interface InstallResult {
  /** Files created or modified, project-relative where possible. */
  paths: string[];
  /** Events registered. */
  events: string[];
}

/** Everything the core produced, for adapters that want detail. */
export interface DecisionContext {
  claim: ClaimResult;
  report?: VerificationReport;
}
