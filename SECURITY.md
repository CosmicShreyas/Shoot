# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting:

**https://github.com/CosmicShreyas/Shoot/security/advisories/new**

That creates a private advisory only maintainers can see, so a fix can ship before
the details are public. It also lets us credit you properly.

If that form is unavailable, open a public issue containing only *"I would like to
report a security issue privately, please advise"* — no details — and we will
arrange a private channel.

### What to include

- What you can do with it, not just what is wrong
- Steps to reproduce, ideally a minimal repository or config
- Your Shoot version (`npx shoot-cc --version`), Node version, OS, and agent host
- Whether it needs local write access, or works from a pull request alone

The last point matters most for triage. A problem exploitable by a drive-by pull
request is far more serious than one requiring an attacker who already has write
access to your machine.

### What to expect

This is a small project maintained in spare time, so promises are kept modest and
honest: we will acknowledge a report as soon as we see it, tell you whether we
consider it in scope, and keep you updated. We are not staffed for a guaranteed
response SLA and will not pretend otherwise.

## Supported versions

Only the latest published version receives fixes. Shoot is pre-1.0; there are no
backports.

## Threat model

Worth being explicit, because Shoot's position in your workflow is unusual: it runs
automatically, on every agent stop event, with your full local permissions.

### What Shoot deliberately does

- **No runtime dependencies.** Node built-ins only. Enforced by CI, which fails the
  build if a `dependencies` key appears. There is no transitive tree to audit.
- **No install scripts.** No `postinstall`, `preinstall`, or `prepare`.
- **No network calls, ever.** Shoot never contacts a remote host. Everything runs
  against local commands. Verification history stays on your disk and is never
  transmitted.
- **Config-change re-approval.** See below.
- **Secret redaction on captured output.** See below.
- **CI actions pinned to commit SHAs**, not floating tags, so a compromised action
  maintainer cannot repoint a tag at new code that runs in this repository.
- **Trusted Publishing via OIDC** for releases, so no long-lived npm token exists
  to steal. Published artifacts carry provenance attestations.

### Defense in depth, not guarantees

Two mitigations are worth understanding precisely, because overestimating them is
its own risk.

#### Config tamper detection

`.shoot.config.json` is committed to your repository, and its `checks` commands run
automatically with no prompt. Without a mitigation, a pull request editing one line
of config would turn Shoot into an arbitrary-command runner on the machine of every
reviewer who has the hook installed — and the diff would not look like code.

Shoot records a hash of the approved commands in `.shoot/trust.json`, which is
gitignored and therefore cannot be modified by a pull request. If the commands
change, verification is **skipped with a loud warning** rather than executed, until
you run `shoot trust` and approve the change explicitly.

**What this does not do:**

- It does not sandbox anything. An approved command runs with your full permissions.
- It does not protect against an attacker who already has write access to your
  working tree — they can edit `.shoot/trust.json` directly.
- It only hashes the `checks` commands. Cosmetic fields (`mode`, `timeoutSeconds`)
  deliberately do not invalidate trust, so that users are not trained to click
  through the warning by reflex.

**Treat a `.shoot.config.json` change from a contributor you do not know exactly as
you would treat any other code change: read it.** The hash is a tripwire that makes
the change *visible*. It is not a judgement about whether the change is safe.

#### Secret redaction

Output captured from your test/lint/build commands flows into three places that
outlive the command: the block reason fed back into the agent's context, the
message shown to you, and `.shoot/history.jsonl` on disk. A test that echoes its
environment, or a library that logs an auth header on failure, would otherwise be
persisted and sent to a model.

Shoot redacts recognizable secret shapes before that output is captured anywhere.
The covered patterns are listed in the README's *Known limitations*.

**What this does not do:** a regex list is never exhaustive. It catches common,
distinctive shapes. It will miss bespoke token formats, secrets split across lines,
base64-wrapped blobs, and anything resembling ordinary prose. It is calibrated to
over-redact — a false positive costs you a moment of confusion, a false negative
writes a live credential to disk — but it is a net, not a wall.

**Do not rely on it as your only control.** Keep secrets out of test output in the
first place.

### Out of scope

- **Your own configured commands doing something harmful.** Shoot runs what you
  approve. That is the feature.
- **An agent writing malicious code that your tests then pass.** Shoot verifies that
  your checks pass; it does not review code quality or intent.
- **Vulnerabilities in the agent host** (Claude Code, Codex CLI). Report those to the
  respective vendor. If Shoot can *mitigate* a host issue, that is in scope and we
  would like to hear about it.
- **A check command that lies.** Shoot verifies exit codes, not test quality. `exit 0`
  proves nothing, and Shoot cannot tell.

## Verifying what you installed

Shoot is small enough to read end to end, and that is intentional. If you want to
confirm the published package matches this repository:

```bash
npm view shoot-cc dist.tarball
npm audit signatures          # verifies provenance attestations
```

Once Trusted Publishing is active (see [docs/RELEASING.md](./docs/RELEASING.md)),
published versions carry provenance linking the tarball to the exact commit and
workflow run that produced it.
