import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectClaims,
  hasCompletionClaim,
  CLAIM_PATTERNS,
} from '../src/core/claimDetector.js';

/** Assert a message IS a completion claim. */
function claims(message: string): void {
  const result = detectClaims(message);
  assert.equal(
    result.claimed,
    true,
    `expected a claim in: ${JSON.stringify(message)} (matches: ${JSON.stringify(result.matches)})`,
  );
}

/** Assert a message is NOT a completion claim. */
function noClaim(message: string): void {
  const result = detectClaims(message);
  assert.equal(
    result.claimed,
    false,
    `expected NO claim in: ${JSON.stringify(message)} but matched ${JSON.stringify(result.matches)}`,
  );
}

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

test('detects test-status claims', () => {
  claims('Tests pass.');
  claims('All tests passing.');
  claims('All 42 tests are passing.');
  claims('The tests now pass.');
  claims('The test suite is green.');
  claims('Lint is clean and typecheck passes.');
  claims('No errors remaining.');
  claims('Everything is green.');
});

test('detects fix/resolution claims', () => {
  claims('Fixed.');
  claims("I've fixed the off-by-one in the parser.");
  claims('The bug is gone.');
  claims('That issue is now resolved.');
  claims('This has been addressed.');
});

test('detects works-now claims', () => {
  claims('It works now.');
  claims('This works correctly.');
  claims('Now it works.');
  claims('It should work now.');
  claims('The endpoint is working as expected.');
});

test('detects done/complete claims', () => {
  claims('Done.');
  claims("I'm done.");
  claims('All done!');
  claims('The refactor is complete.');
  claims('I have finished the migration.');
  claims('Implemented successfully.');
  claims('Successfully added the new endpoint.');
  claims('Ready to go.');
  claims("You're all set.");
  claims('Good to go.');
  claims('All good!');
  claims('The implementation is complete.');
  claims('Confirmed working.');
});

test('reports which phrase matched, for quoting back', () => {
  const result = detectClaims('Great news — all tests are passing now.');
  assert.equal(result.claimed, true);
  assert.ok(result.matches.length >= 1);
  const text = result.matches[0]?.text ?? '';
  assert.match(text, /tests are passing/i);
  assert.ok(result.matches[0]?.id, 'match should carry a pattern id');
});

test('finds claims inside longer, realistic messages', () => {
  claims(
    [
      'I refactored the auth middleware to use the new token helper,',
      'moved the session lookup into a single query, and updated the',
      'three call sites. Tests pass and lint is clean.',
    ].join(' '),
  );
});

// ---------------------------------------------------------------------------
// Negation — the cases that decide whether this tool is trustworthy
// ---------------------------------------------------------------------------

test('negated claims do NOT trigger', () => {
  noClaim("Tests don't pass yet.");
  noClaim('Tests do not pass.');
  noClaim("The tests aren't passing.");
  noClaim('The build is not clean.');
  noClaim('This is not fixed.');
  noClaim('That is still not resolved.');
  noClaim('It does not work yet.');
  noClaim("I can't get the tests passing.");
  noClaim('Not done.');
  noClaim('The suite is failing.');
});

test('the canonical negation cases from the spec', () => {
  noClaim("Tests don't pass yet.");
  noClaim('Are tests passing?');
  noClaim("I'm not done yet, still fixing the auth bug.");
});

test('hedges and future intent do NOT trigger', () => {
  noClaim('I still need to fix the parser.');
  noClaim('Next I will fix the failing test.');
  noClaim('I am going to implement the retry logic.');
  noClaim('Let me verify that the tests pass.');
  noClaim('I need to check whether lint is clean.');
  noClaim('Once the migration is complete I will run the suite.');
  noClaim('This might be resolved by the upstream patch.');
  noClaim('Trying to fix the race condition now.');
  noClaim('I plan to fix this next.');
});

test('partial-progress qualifiers do NOT trigger', () => {
  noClaim('Almost done.');
  noClaim('Nearly finished, one more file.');
  noClaim('Mostly working, still one edge case.');
  noClaim('Partially fixed.');
});

test('doubt and soft belief do NOT trigger', () => {
  noClaim('I doubt this is fixed.');
  noClaim("I'm not sure it works now.");
  noClaim('I think this is resolved, but I have not run it.');
  noClaim('I hope that is fixed.');
  noClaim('I assume the tests pass.');
});

test('"none"/"no" quantifier negation does NOT trigger', () => {
  noClaim('None of the tests pass.');
  noClaim('No tests are passing.');
  noClaim('None of this works yet.');
});

test('trailing "yet" negates even without an explicit negator', () => {
  noClaim('Done yet? No.');
  noClaim('It works yet again differently'); // "yet" immediately after
});

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

test('questions do NOT trigger', () => {
  noClaim('Are tests passing?');
  noClaim('Is it fixed?');
  noClaim('Did the build pass?');
  noClaim('Should this work now?');
  noClaim('Do you want me to confirm the tests pass?');
  noClaim('How do I know the lint is clean?');
  noClaim('Is everything green?');
});

test('interrogatives without a question mark still do NOT trigger', () => {
  noClaim('Are the tests passing');
  noClaim('Can you confirm it works now');
});

// ---------------------------------------------------------------------------
// Clause independence
// ---------------------------------------------------------------------------

test('a real claim survives a negation in a DIFFERENT clause', () => {
  // "fixed" is a genuine claim here; the failure belongs to another clause.
  claims('I fixed the parser, but the unrelated snapshot test is still failing.');
  claims('Lint is clean. The build, however, is not something I ran.');
});

test('a negation does not leak backwards across clause boundaries', () => {
  claims('Tests pass. I have not touched the docs.');
});

// ---------------------------------------------------------------------------
// Neutral / mid-task messages must stay silent
// ---------------------------------------------------------------------------

test('ordinary mid-task narration does NOT trigger', () => {
  noClaim('Reading the config loader to understand how defaults are merged.');
  noClaim('I found three call sites that construct the client directly.');
  noClaim('Here is the diff for review.');
  noClaim('Which database should the integration test point at?');
  noClaim('This function parses the transcript and returns the last message.');
});

test('empty and malformed input is handled', () => {
  noClaim('');
  noClaim('   \n  ');
  assert.equal(hasCompletionClaim(''), false);
  // Defensive: the hook reads untrusted JSON, so non-strings can reach us.
  assert.equal(hasCompletionClaim(undefined as unknown as string), false);
  assert.equal(hasCompletionClaim(null as unknown as string), false);
  assert.equal(hasCompletionClaim(42 as unknown as string), false);
});

// ---------------------------------------------------------------------------
// Invariants over the pattern table
// ---------------------------------------------------------------------------

test('every pattern is global and case-insensitive with a unique id', () => {
  const ids = new Set<string>();
  for (const { id, pattern } of CLAIM_PATTERNS) {
    assert.ok(pattern.flags.includes('g'), `${id} must be global`);
    assert.ok(pattern.flags.includes('i'), `${id} must be case-insensitive`);
    assert.ok(!ids.has(id), `duplicate pattern id: ${id}`);
    ids.add(id);
  }
});

test('detection is case-insensitive', () => {
  claims('TESTS PASS');
  claims('Done');
  claims('all TESTS are PASSING');
});

test('repeated calls are stable (no regex lastIndex leakage)', () => {
  const msg = 'Tests pass and lint is clean.';
  const first = detectClaims(msg);
  const second = detectClaims(msg);
  const third = detectClaims(msg);
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
});

test('matches are deduplicated by pattern id', () => {
  const result = detectClaims('Fixed it. Fixed the other one too. Fixed again.');
  const ids = result.matches.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'ids should be unique');
});
