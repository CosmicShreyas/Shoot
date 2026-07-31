/**
 * Best-effort secret redaction for captured command output.
 *
 * WHY THIS EXISTS
 *
 * Output from test/lint/build commands flows into three places that outlive the
 * command: the block `reason` fed back into the agent's context, the
 * `systemMessage` shown to the user, and `.shoot/history.jsonl` on disk. A
 * misconfigured test that echoes its environment, or a library that logs an auth
 * header on failure, would otherwise get persisted and fed to a model.
 *
 * CALIBRATION
 *
 * Deliberately biased toward over-redaction. A false positive costs a reader one
 * moment of confusion; a false negative writes a live credential to disk. Where a
 * pattern was a judgement call, it errs wide.
 *
 * WHAT THIS IS NOT
 *
 * A regex list is never exhaustive, and this makes no attempt to pretend
 * otherwise. It catches shapes that are common and distinctive. It will miss
 * bespoke token formats, secrets split across lines, base64-wrapped blobs, and
 * anything that looks like ordinary prose. Treated as one layer of defense, not a
 * guarantee — which is what the README and SECURITY.md say too.
 */

export const REDACTED = '[REDACTED]';

export interface RedactionPattern {
  /** Identifier, used in tests and for documenting coverage. */
  id: string;
  /** Must be global. Capture group 1, when present, is preserved as a prefix. */
  pattern: RegExp;
  /** Human-readable description, mirrored in the README. */
  describes: string;
}

/**
 * Ordered: more specific patterns run first, so a match like an AWS key is
 * labelled by its own rule rather than swallowed by the generic assignment rule.
 */
export const REDACTION_PATTERNS: readonly RedactionPattern[] = [
  // --- PEM private keys ----------------------------------------------------
  {
    id: 'pem-private-key',
    describes: 'PEM private key blocks (RSA, EC, OPENSSH, PGP, and generic)',
    // Redact the whole block, not just the header, or the key body survives.
    pattern:
      /-----BEGIN (?:[A-Z0-9 ]*)?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9 ]*)?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: 'pem-private-key-header-only',
    describes: 'An unterminated PEM private key header',
    // Truncated output can cut off the END line; the header alone is enough
    // signal that whatever follows should not be kept.
    pattern: /-----BEGIN (?:[A-Z0-9 ]*)?PRIVATE KEY(?: BLOCK)?-----[\s\S]*/g,
  },

  // --- Cloud provider keys -------------------------------------------------
  {
    id: 'aws-access-key-id',
    describes: 'AWS access key IDs (AKIA/ASIA/ABIA/ACCA + 16 chars)',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'aws-secret-access-key',
    describes: 'AWS secret access keys, when assigned to a recognizable name',
    pattern:
      /\b(aws_?secret_?access_?key|aws_?secret)\b(\s*[:=]\s*|["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}/gi,
  },
  {
    id: 'google-api-key',
    describes: 'Google API keys (AIza + 30 or more chars)',
    // Canonical keys are AIza + exactly 35, but pinning the length exactly means a
    // near-miss slips through entirely. Over-redaction is the safe direction here.
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  },

  // --- Vendor-prefixed tokens ---------------------------------------------
  {
    id: 'github-token',
    describes: 'GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_)',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  {
    id: 'slack-token',
    describes: 'Slack tokens (xox[abprs]-…)',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: 'stripe-key',
    describes: 'Stripe live/test keys (sk_live_, sk_test_, rk_live_, rk_test_)',
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  {
    id: 'openai-key',
    describes: 'OpenAI-style keys (sk-… and sk-proj-…)',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'anthropic-key',
    describes: 'Anthropic API keys (sk-ant-…)',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'npm-token',
    describes: 'npm tokens (npm_… and UUID-shaped legacy tokens after //registry)',
    pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g,
  },

  // --- JWTs ---------------------------------------------------------------
  {
    id: 'jwt',
    describes: 'JWT-shaped strings (three base64url segments, header starts eyJ)',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
  },

  // --- Generic assignments -------------------------------------------------
  {
    id: 'generic-secret-assignment',
    describes:
      'A long value assigned to a name containing key/token/secret/password/credential/passwd/auth',
    // Capture group 1 keeps the variable name and operator visible — knowing
    // WHICH setting leaked is useful; the value is what must go. Requires 16+
    // chars so ordinary short values ("password: short") are left alone.
    pattern:
      /\b([A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer[_-]?token|private[_-]?token|secret|password|passwd|credential|token)[A-Za-z0-9_.-]*)(\s*[:=]\s*|\s*=>\s*)["']?([A-Za-z0-9_./+=~-]{16,})["']?/gi,
  },
  {
    id: 'authorization-header',
    describes: 'Authorization headers (Bearer / Basic / Token schemes)',
    pattern: /\b(authorization\s*[:=]\s*)["']?(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}["']?/gi,
  },
  {
    id: 'bearer-token',
    describes: 'A bare "Bearer <token>" occurrence',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g,
  },
  {
    id: 'url-basic-auth',
    describes: 'Credentials embedded in a URL (scheme://user:pass@host)',
    // Keep the scheme and host; drop the userinfo.
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
  },
  {
    id: 'connection-string-password',
    describes: 'Password fields in database connection strings',
    pattern: /\b(password|pwd)=([^;\s]{4,})/gi,
  },
];

/**
 * Redact secrets from text.
 *
 * Patterns with a capture group preserve that group so the reader can still see
 * which setting was involved. Everything else is replaced wholesale.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string' || text === '') return text;

  let out = text;

  for (const { id, pattern } of REDACTION_PATTERNS) {
    // Module-level regexes are global; reset before each use.
    pattern.lastIndex = 0;

    switch (id) {
      case 'generic-secret-assignment':
        out = out.replace(pattern, (_m, name: string, op: string) => `${name}${op}${REDACTED}`);
        break;

      case 'authorization-header':
      case 'connection-string-password':
        out = out.replace(pattern, (_m, prefix: string) => `${prefix}${REDACTED}`);
        break;

      case 'aws-secret-access-key':
        out = out.replace(pattern, (_m, name: string, op: string) => `${name}${op}${REDACTED}`);
        break;

      case 'url-basic-auth':
        out = out.replace(pattern, (_m, scheme: string) => `${scheme}${REDACTED}@`);
        break;

      default:
        out = out.replace(pattern, REDACTED);
        break;
    }
  }

  return out;
}

/** True when redaction would change the text. Used by tests and diagnostics. */
export function containsSecrets(text: string): boolean {
  return redactSecrets(text) !== text;
}

/** Pattern descriptions, for the README's coverage list. */
export function describeCoverage(): string[] {
  return REDACTION_PATTERNS.map((p) => p.describes);
}
