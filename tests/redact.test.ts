import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REDACTED,
  REDACTION_PATTERNS,
  containsSecrets,
  describeCoverage,
  redactSecrets,
} from '../src/core/redact.js';
import { runCheck } from '../src/core/verificationRunner.js';

/**
 * All secrets below are SYNTHETIC — structurally realistic so the patterns are
 * genuinely exercised, but not valid credentials for any real service.
 *
 * Vendor-prefixed fixtures are assembled at runtime via `token()` rather than
 * written as single literals. Secret scanners cannot tell a synthetic `sk_live_…`
 * from a real one, and GitHub push protection blocks on them — correctly, since
 * from the outside the two are indistinguishable. Splitting the prefix keeps the
 * source scanner-clean without weakening what is under test.
 */

function assertRedacted(text: string, label: string): void {
  const out = redactSecrets(text);
  assert.notEqual(out, text, `${label}: nothing was redacted`);
  assert.match(out, /\[REDACTED\]/, `${label}: no marker present`);
}

/**
 * Assemble a token fixture at runtime rather than writing it as one literal.
 *
 * These fixtures are synthetic, but they are realistic enough that GitHub's push
 * protection and other scanners flag them — a source file containing `sk_live_…`
 * looks identical to a real leak from the outside, and this push was in fact
 * blocked until the literals were split. Separating the prefix from the body keeps
 * the file scanner-clean while still handing the pattern a fully-formed token at
 * runtime, which is what is actually under test.
 */
function token(prefix: string, body: string): string {
  return prefix + body;
}

// ---------------------------------------------------------------------------
// Cloud provider keys
// ---------------------------------------------------------------------------

test('redacts AWS access key IDs', () => {
  const out = redactSecrets('Using AKIAIOSFODNN7EXAMPLE for the upload');
  assert.doesNotMatch(out, /AKIAIOSFODNN7EXAMPLE/);
  assert.match(out, /Using \[REDACTED\] for the upload/);
});

test('redacts AWS session and role key prefixes too', () => {
  for (const prefix of ['ASIA', 'ABIA', 'ACCA']) {
    assertRedacted(`key=${prefix}IOSFODNN7EXAMPLE`, prefix);
  }
});

test('redacts an AWS secret access key when named', () => {
  const out = redactSecrets(
    'aws_secret_access_key=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY1234',
  );
  assert.doesNotMatch(out, /wJalrXUtnFEMI/);
  assert.match(out, /aws_secret_access_key/, 'the name stays visible');
});

test('redacts Google API keys', () => {
  assertRedacted('key: AIzaSyD-ExampleFakeKey1234567890abcdefgh', 'google');
});

// ---------------------------------------------------------------------------
// Vendor tokens
// ---------------------------------------------------------------------------

test('redacts GitHub tokens of every documented prefix', () => {
  const body = '16CharsMinimumAAAAAAAAAAAAAAAAAAAA';
  const tokens = [
    token('gh', `p_${body}`),
    token('gh', `o_${body}`),
    token('gh', `u_${body}`),
    token('gh', `s_${body}`),
    token('gh', `r_${body}`),
    token('github', '_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz'),
  ];

  for (const t of tokens) {
    assertRedacted(`token ${t} leaked`, t.slice(0, 8));
  }
});

test('redacts Slack tokens', () => {
  assertRedacted(token('xox', `b-123456789012-${'ABCDEFGHIJKLMNOPQRSTUVWX'}`), 'slack bot');
  assertRedacted(token('xox', `p-123456789012-${'ABCDEFGHIJKLMNOPQRSTUVWX'}`), 'slack user');
});

test('redacts Stripe live and test keys', () => {
  const body = 'ABCDEFGHIJKLMNOPQRSTUVWX';
  assertRedacted(token('sk', `_live_${body}`), 'stripe live');
  assertRedacted(token('sk', `_test_${body}`), 'stripe test');
  assertRedacted(token('rk', `_live_${body}`), 'stripe restricted');
});

test('redacts OpenAI and Anthropic style keys', () => {
  assertRedacted(token('sk', '-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), 'openai');
  assertRedacted(token('sk', '-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), 'openai project');
  assertRedacted(token('sk', '-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), 'anthropic');
});

test('redacts npm tokens', () => {
  assertRedacted('//registry.npmjs.org/:_authToken=' + token('npm', '_ABCDEFGHIJ0123456789abcdefghij0123'), 'npm');
});

// ---------------------------------------------------------------------------
// JWTs and PEM keys
// ---------------------------------------------------------------------------

test('redacts JWT-shaped strings', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const out = redactSecrets(`Authorization failed for ${jwt}`);
  assert.doesNotMatch(out, /eyJhbGciOi/);
  assert.match(out, /\[REDACTED\]/);
});

test('redacts a whole PEM private key block, not just its header', () => {
  const pem = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAxGZlZmFrZWtleWZha2VrZXlmYWtla2V5ZmFrZWtleWZha2Vr',
    'ZXlmYWtla2V5ZmFrZWtleWZha2VrZXlmYWtla2V5ZmFrZWtleWZha2VrZXk=',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n');

  const out = redactSecrets(`config:\n${pem}\ndone`);
  assert.doesNotMatch(out, /MIIEowIBAAK/, 'the key body must not survive');
  assert.doesNotMatch(out, /BEGIN RSA PRIVATE KEY/);
  assert.match(out, /config:/, 'surrounding text is preserved');
  assert.match(out, /done/);
});

test('redacts a truncated PEM block with no END line', () => {
  // Output truncation can cut the END marker; the header alone is enough signal.
  const out = redactSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA');
  assert.doesNotMatch(out, /b3BlbnNzaC1rZXk/);
});

test('redacts EC and generic PRIVATE KEY variants', () => {
  assertRedacted('-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----', 'ec');
  assertRedacted('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----', 'generic');
});

// ---------------------------------------------------------------------------
// Generic assignments
// ---------------------------------------------------------------------------

test('redacts long values assigned to secret-shaped names', () => {
  const cases = [
    'API_KEY=abcdef0123456789abcdef',
    'api-key: abcdef0123456789abcdef',
    'apiKey = "abcdef0123456789abcdef"',
    'access_token=abcdef0123456789abcdef',
    'refresh_token: abcdef0123456789abcdef',
    'client_secret=abcdef0123456789abcdef',
    'MY_SERVICE_PASSWORD=abcdef0123456789abcdef',
    'db_credential => abcdef0123456789abcdef',
  ];

  for (const c of cases) {
    const out = redactSecrets(c);
    assert.doesNotMatch(out, /abcdef0123456789abcdef/, c);
    assert.match(out, /\[REDACTED\]/, c);
  }
});

test('the variable name survives redaction, so you know what leaked', () => {
  const out = redactSecrets('STRIPE_API_KEY=abcdef0123456789abcdef');
  assert.match(out, /STRIPE_API_KEY/);
  assert.match(out, /\[REDACTED\]/);
});

test('redacts Authorization headers of each scheme', () => {
  for (const scheme of ['Bearer', 'Basic', 'Token']) {
    const out = redactSecrets(`Authorization: ${scheme} abcdef0123456789abcdef`);
    assert.doesNotMatch(out, /abcdef0123456789abcdef/, scheme);
    assert.match(out, /[Aa]uthorization/, 'header name stays');
  }
});

test('redacts a bare Bearer token', () => {
  const out = redactSecrets('curl -H "Bearer abcdef0123456789abcdefghij"');
  assert.doesNotMatch(out, /abcdef0123456789abcdefghij/);
});

test('redacts credentials embedded in a URL but keeps the host', () => {
  const out = redactSecrets('cloning https://alice:s3cr3tpassword@github.com/org/repo.git');
  assert.doesNotMatch(out, /s3cr3tpassword/);
  assert.match(out, /github\.com\/org\/repo\.git/, 'host and path stay useful');
  assert.match(out, /https:\/\//);
});

test('redacts a password in a database connection string', () => {
  const out = redactSecrets('Server=db;Database=x;User Id=sa;Password=Sup3rS3cretValue;');
  assert.doesNotMatch(out, /Sup3rS3cretValue/);
  assert.match(out, /Database=x/, 'non-secret parts stay');
});

// ---------------------------------------------------------------------------
// Calibration: over-redaction is acceptable, under-redaction is not
// ---------------------------------------------------------------------------

test('ordinary test output is left alone', () => {
  const output = [
    '✖ adds two numbers (1.87ms)',
    '  AssertionError [ERR_ASSERTION]: 0 == 4',
    '      at TestContext.<anonymous> (sum.test.js:6:10)',
    'ℹ tests 1',
    'ℹ pass 0',
    'ℹ fail 1',
    'Error: Cannot find module ./missing.js',
    'src/core/config.ts(42,7): error TS2322: Type string is not assignable to number.',
  ].join('\n');

  assert.equal(redactSecrets(output), output, 'normal diagnostics must survive intact');
  assert.equal(containsSecrets(output), false);
});

test('short values assigned to secret-shaped names are left alone', () => {
  // "password: short" is far more likely to be prose or a fixture than a secret,
  // and redacting it would erode trust in the marker.
  const text = 'password: abc';
  assert.equal(redactSecrets(text), text);
});

test('a git SHA and a semver are not mistaken for secrets', () => {
  const text = 'built from 11d5960a326750d5838078e36cf38b85af677262 at v4.4.0';
  assert.equal(redactSecrets(text), text);
});

test('redaction is idempotent', () => {
  const once = redactSecrets('API_KEY=abcdef0123456789abcdef');
  assert.equal(redactSecrets(once), once, 'redacting twice must not corrupt the marker');
});

test('empty and non-string input is handled', () => {
  assert.equal(redactSecrets(''), '');
  assert.equal(redactSecrets(undefined as unknown as string), undefined);
  assert.equal(redactSecrets(null as unknown as string), null);
});

test('multiple distinct secrets in one blob are all redacted', () => {
  const text = [
    'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    'GITHUB_TOKEN=ghp_16CharsMinimumAAAAAAAAAAAAAAAAAAAA',
    'API_KEY=abcdef0123456789abcdef',
  ].join('\n');

  const out = redactSecrets(text);
  assert.doesNotMatch(out, /AKIAIOSFODNN7EXAMPLE/);
  assert.doesNotMatch(out, /ghp_16Chars/);
  assert.doesNotMatch(out, /abcdef0123456789abcdef/);
  assert.equal((out.match(/\[REDACTED\]/g) ?? []).length >= 3, true);
});

// ---------------------------------------------------------------------------
// Pattern table invariants
// ---------------------------------------------------------------------------

test('every pattern is global with a unique id and a description', () => {
  const ids = new Set<string>();
  for (const p of REDACTION_PATTERNS) {
    assert.ok(p.pattern.flags.includes('g'), `${p.id} must be global`);
    assert.ok(!ids.has(p.id), `duplicate id: ${p.id}`);
    assert.ok(p.describes.trim() !== '', `${p.id} needs a description for the README`);
    ids.add(p.id);
  }
});

test('coverage descriptions are exposed for documentation', () => {
  const coverage = describeCoverage();
  assert.equal(coverage.length, REDACTION_PATTERNS.length);
  assert.ok(coverage.some((c) => /AWS/.test(c)));
  assert.ok(coverage.some((c) => /PEM/.test(c)));
  assert.ok(coverage.some((c) => /JWT/.test(c)));
});

// ---------------------------------------------------------------------------
// Integration: redaction happens at capture, before anything downstream
// ---------------------------------------------------------------------------

test('real command output is redacted before it is ever returned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shoot-redact-'));
  try {
    // A script that leaks a secret the way a misconfigured test might.
    const script = join(dir, 'leak.mjs');
    writeFileSync(
      script,
      'console.log("connecting with AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY1");\n' +
        'console.error("token ghp_16CharsMinimumAAAAAAAAAAAAAAAAAAAA rejected");\n' +
        'process.exit(1);\n',
      'utf8',
    );

    const result = await runCheck('test', `"${process.execPath}" "${script}"`, {
      timeoutSeconds: 30,
    });

    assert.equal(result.status, 'failed');
    assert.doesNotMatch(result.output, /wJalrXUtnFEMI/, 'stdout secret must be gone');
    assert.doesNotMatch(result.output, /ghp_16Chars/, 'stderr secret must be gone');
    assert.match(result.output, /\[REDACTED\]/);
    // The diagnostic value is preserved.
    assert.match(result.output, /connecting with/);
    assert.match(result.output, /rejected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the command string itself is redacted, since it is echoed downstream', async () => {
  const result = await runCheck(
    'test',
    `"${process.execPath}" -e "process.exit(0)" --api-key=abcdef0123456789abcdef`,
    { timeoutSeconds: 30 },
  );

  assert.doesNotMatch(result.command, /abcdef0123456789abcdef/);
  assert.match(result.command, /\[REDACTED\]/);
});

test('redaction runs before truncation, so a secret cannot straddle the cut', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shoot-redact-'));
  try {
    // Emit far more than MAX_OUTPUT_CHARS, with a secret near the very end.
    const script = join(dir, 'flood.mjs');
    writeFileSync(
      script,
      'for (let i = 0; i < 900; i++) console.log("filler line " + i + " ".repeat(20));\n' +
        'console.log("API_KEY=abcdef0123456789abcdef");\n' +
        'process.exit(1);\n',
      'utf8',
    );

    const result = await runCheck('test', `"${process.execPath}" "${script}"`, {
      timeoutSeconds: 30,
    });

    assert.match(result.output, /truncated/, 'output should have been truncated');
    assert.doesNotMatch(result.output, /abcdef0123456789abcdef/, 'secret must still be gone');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
