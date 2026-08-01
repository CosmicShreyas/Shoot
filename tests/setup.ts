/**
 * Test bootstrap, loaded before any test module.
 *
 * WHY THIS EXISTS
 *
 * `messages.pal()` resolves its palette lazily from the ambient `process.stderr`
 * and `process.env` on first use. That is correct for the product — a real user's
 * terminal should get colour — but it made the suite's result depend on where it
 * was run:
 *
 *   - CI (Linux runners, stderr piped)  -> isTTY undefined -> plain -> pass
 *   - an interactive terminal           -> isTTY true      -> colour -> FAIL
 *
 * Six tests assert that `systemMessage` is the canonical mascot line, matching
 * `/^\u{1F43C} Shoot: /`. Those assertions are RIGHT: the real hook path calls
 * `setPalette(plain)` before building a decision (see `commands/hook.ts`), because
 * `systemMessage` is embedded in the JSON a host parses and an escape sequence
 * there would corrupt the payload. The tests call `evaluate()`/`decide()` directly
 * and so skipped that production step, then inherited whatever the developer's
 * terminal happened to be.
 *
 * Setting NO_COLOR here reproduces the guarantee `hook.ts` provides, for every test
 * file, before any module has a chance to memoise a palette. Tests that care about
 * colour still pin it explicitly with `setPalette()` / `paletteFor(TTY, {})`, which
 * takes precedence over this default and is unaffected.
 *
 * This is a harness fix, not a product change: no test expectation was relaxed to
 * accommodate broken behaviour.
 */

import { plain } from '../src/mascot/colors.js';
import { setPalette } from '../src/mascot/messages.js';

// Belt: make the environment say "no colour" before anything reads it.
process.env['NO_COLOR'] = '1';
// NO_COLOR already wins over FORCE_COLOR in `shouldColor`, so this is defensive
// rather than load-bearing; it keeps the intent clear if that precedence changes.
delete process.env['FORCE_COLOR'];

// Braces: pin the palette outright, so the default holds even if something later
// mutates the environment. This is the same call `commands/hook.ts` makes before
// building a decision, which is precisely the production guarantee these tests
// mean to assert.
setPalette(plain);
