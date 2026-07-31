# Demo script — recording Shoot on Shoot

A copy-pasteable scenario for recording the demo. The story is **Shoot catching a real
bug from its own history**: the `stop_hook_active` infinite loop found during live
end-to-end testing (documented in [ORIGIN.md](./ORIGIN.md) §5 and the README).

That's the right story because it's true, it's already fixed, and it's the kind of bug
that unit tests structurally cannot catch — which is exactly the argument for the tool.

<!-- RECORDING_LINK: add the asciinema / video URL here once recorded, then
     update the DEMO_VIDEO_LINK placeholder in README.md to point at it. -->

**Recording:** not yet recorded.

---

## Before you start

```bash
cd /path/to/shoot          # this repo
npm ci --ignore-scripts
npm run build
node --version             # confirm >= 18 on camera
```

Terminal setup: 100×30 or wider, plain prompt, no personal paths visible if possible.
Total runtime is about 3 minutes at a comfortable pace.

Reset between takes:

```bash
git checkout -- src/core/decide.ts
rm -rf .shoot .shoot.config.json .claude/shoot-hook.js
```

---

## Scene 1 — Shoot verifies itself (20s)

Establish that this is a real tool on a real repo, not a toy.

```bash
npx shoot-cc init
```

Accept the suggested commands (Enter through). Expected — note it detects `.claude/`
and suggests from `package.json`:

```
🐼 Shoot: Let's set up your checks. Press Enter to accept anything in [brackets].

🐼 Shoot: Found .claude/ — setting up for Claude Code.

Found these in package.json — press Enter to accept the suggestion, or type your own.

Leave any check blank to skip it.

  Test command [npm test]:
  Lint command:
  Typecheck command [npm run typecheck]:
  Build command [npm run build]:

  Block the agent when checks fail? (no = warn only) [Y/n]:
  Verify subagent completions too? [Y/n]:
```

Then:

```bash
shoot doctor
```

Expected — all green, which sets up the contrast when we break it:

```
🐼 Shoot: Let's check your setup.

  ok    Node version         v22.x.x
  ok    Working directory    /path/to/shoot
  ok    Config file          .shoot.config.json
  ok    Platform             Claude Code
  ok    Checks configured    test, typecheck, build
  ok    test command         npm test → package.json scripts.test
  ok    typecheck command    npm run typecheck → package.json scripts.typecheck
  ok    build command        npm run build → package.json scripts.build
  ok    Hook: Stop           registered, script present
  ok    Hook: SubagentStop   registered, script present

🐼 Shoot: Everything looks healthy. Nothing to fix.
```

---

## Scene 2 — Reintroduce the historical bug (30s)

Put the `stop_hook_active` loop back. Open `src/core/decide.ts` and comment out the
guard at the top of `decide()`:

```ts
  // 0. Forced continuation. Silent, immediate, unconditional.
  // if (input.stopHookActive) {
  //   return { verdict: { kind: 'allowSilent' }, claim: { claimed: false, matches: [] } };
  // }
```

Say on camera what this is: *"This is the actual bug we shipped and caught in live
testing. Without this guard, a passing verification re-triggers itself."*

Now show that the test suite catches it — this is the honest framing, that tests and
Shoot do different jobs:

```bash
npm test 2>&1 | grep -E "^. (a loop cannot|stop_hook_active)" 
```

Expected — the regression tests written after that bug now fail:

```
✖ stop_hook_active: true short-circuits to a silent allow
✖ a loop cannot occur: only the first call in a turn verifies
```

---

## Scene 3 — The false claim, blocked (45s)

The core of the demo. Break something real and claim it works.

Edit `src/core/claimDetector.ts` and break one pattern — change the `tests-pass`
regex so it never matches:

```ts
{ id: 'tests-pass', pattern: /\bZZZ_NEVER_MATCHES\b/gi },
```

Now simulate the agent finishing with a false claim:

```bash
cat > /tmp/payload.json <<'EOF'
{
  "session_id": "demo-session",
  "cwd": "REPLACE_WITH_ABSOLUTE_REPO_PATH",
  "hook_event_name": "Stop",
  "last_assistant_message": "Fixed the detector — all tests pass now."
}
EOF

node .claude/shoot-hook.js < /tmp/payload.json
```

> On Windows, set `cwd` to a native path (`C:\\Users\\...`), not a Git-Bash-style
> `/c/...` path — an unresolvable `cwd` makes Shoot report *skipped verification*,
> which is a different (and also interesting) message.

Expected — Shoot quotes the claim back and hands over the real failure:

```
{"decision":"block","reason":"🐼 Shoot: Not yet. You said \"Fixed\" — it isn't true yet. ..."}
🐼 Shoot: Not yet. You said "Fixed" — it isn't true yet. Here's what broke:
```

Pretty-print the reason so the diagnostics are readable on camera:

```bash
node .claude/shoot-hook.js < /tmp/payload.json 2>/dev/null \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).reason))"
```

Expected shape — framing line, then **verbatim** test output:

```
🐼 Shoot: Not yet. You said "Fixed" — it isn't true yet. Here's what broke:

--- test: failed with exit code 1
--- command: npm test

✖ detects test-status claims
✖ a loop cannot occur: only the first call in a turn verifies
  AssertionError [ERR_ASSERTION]: expected a claim in: "Tests pass."

Fix the underlying problem and re-run the checks. Do not report success until they pass.
```

Point out the split: the panda voice is one framing line, everything under it is the
real test runner's output, unstyled and greppable.

---

## Scene 4 — Fix it, get cleared (30s)

Restore both files:

```bash
git checkout -- src/core/claimDetector.ts src/core/decide.ts
npm run build
```

Same payload, same command:

```bash
node .claude/shoot-hook.js < /tmp/payload.json
```

Expected — the receipt, in Shoot's voice, via `systemMessage`:

```
{"systemMessage":"🐼 Shoot: Nice work — test passed, typecheck passed, build passed. Cleared to grow."}
🐼 Shoot: Nice work — test passed, typecheck passed, build passed. Cleared to grow.
```

---

## Scene 5 — The loop that can't happen (20s)

Show the fix holding. Same claim, but with `stop_hook_active: true` — the state that
caused the nine-iteration loop:

```bash
node -e "
const p=JSON.parse(require('fs').readFileSync('/tmp/payload.json','utf8'));
p.stop_hook_active=true;
process.stdout.write(JSON.stringify(p));
" > /tmp/payload-active.json

for i in 1 2 3 4 5; do
  printf 'event %s stdout: [' "$i"
  node .claude/shoot-hook.js < /tmp/payload-active.json
  printf ']\n'
done
```

Expected — total silence, five times. Nothing to re-trigger:

```
event 1 stdout: []
event 2 stdout: []
event 3 stdout: []
event 4 stdout: []
event 5 stdout: []
```

One line for the voiceover: *"Nine iterations before. Now zero, because the guard runs
before anything else."*

---

## Scene 6 — The receipt (20s)

```bash
shoot stats
```

Expected (numbers depend on the take):

```
🐼 Shoot: Your verification history

  verifications   3
  sessions        1
  first / last    2026-07-31 .. 2026-07-31

  passed          1
  blocked         2

  pass rate       33% of verified claims

🐼 Shoot: Caught 2 completion claims that weren't backed by passing checks.
```

Closing line: *"That's the number that matters — claims that didn't survive contact
with the actual test suite."*

---

## After recording

1. Upload; put the URL in the `RECORDING_LINK` comment at the top of this file.
2. Replace `<!-- DEMO_VIDEO_LINK: ... -->` in [README.md](./README.md) with the embed
   or link.
3. Reset the working tree:
   ```bash
   git status                       # confirm nothing unintended is staged
   git checkout -- src/
   rm -rf .shoot .shoot.config.json .claude/shoot-hook.js
   rm -f /tmp/payload.json /tmp/payload-active.json
   ```
4. Consider whether the terminal showed any absolute paths worth cropping.

## Notes on honesty

Two things to avoid, because they'd undercut the whole point:

- **Don't stage the failure as more dramatic than it is.** The bug was real and the fix
  is real; that's enough. No invented stakes.
- **Don't imply Shoot found the loop.** A human running a live session found it, and
  Shoot's own regression tests now hold it down. Claiming the tool caught its own bug
  would be exactly the kind of unverified success claim this project exists to stop.
