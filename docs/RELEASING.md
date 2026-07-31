# Releasing

Shoot publishes to npm using **Trusted Publishing** (OIDC). There is no
`NPM_TOKEN` secret in this repository, and none should ever be added.

## Why no token

A long-lived npm automation token stored as a GitHub secret is a standing
liability: anyone who can run a workflow, or who compromises an action the
workflow uses, can exfiltrate it and publish arbitrary code under this package
name. That has happened to real packages.

Trusted Publishing removes the credential entirely. npm verifies the OIDC identity
of *this specific workflow file in this specific repository* and mints a token that
lives for the duration of the publish. Nothing to steal, nothing to rotate.

It also generates **provenance attestations** automatically, so anyone installing
`shoot-cc` can verify the tarball was built from a specific commit in this repo
rather than uploaded from someone's laptop.

## The first publish must be manual

### What the documentation actually says

This was checked against npm's own documentation rather than a blog post, and the
result is worth recording precisely, because the docs do **not** state it outright.

[docs.npmjs.com/trusted-publishers](https://docs.npmjs.com/trusted-publishers)
describes the setup path as:

> "Navigate to your package settings on npmjs.com and find the 'Trusted Publisher'
> section. Under 'Select your publisher', choose your CI/CD provider…"

It documents the required fields (Organization or user, Repository, Workflow
filename, Environment name, Allowed actions) and the version floor (npm CLI
**11.5.1+**, Node **22.14.0+**). It does **not** explicitly address whether a
package must already exist before a trusted publisher can be configured.
[docs.npmjs.com/generating-provenance-statements](https://docs.npmjs.com/generating-provenance-statements)
does not address it either; its only related line is that a first-time publish
needs `--access public`.

### The conclusion, and how confident it is

**A trusted publisher is configured on a package's own settings page, and that page
does not exist for a package that has never been published.** `shoot-cc` currently
returns `Not found` from the registry, so it has no settings page to visit. The
first publish therefore has to be manual and human-authenticated.

This is an inference from the documented setup path rather than a sentence npm has
written down. It is stated here as an inference on purpose. If npm has since added
pre-registration for unpublished names, this section is the thing to correct — and
the release workflow's dry-run mode (below) is the safe way to find out, since it
exercises OIDC authentication without publishing.

### Step 1 — publish 0.1.0 manually, once

From a local machine:

```bash
npm login                 # human-authenticated; use 2FA
npm run typecheck && npm run build && npm test
npm publish --access public
```

`--access public` is required on a first publish. `prepublishOnly` re-runs
typecheck, build, and the full suite regardless, so a broken tree cannot be
published by accident.

> Publishing manually means this one version will **not** carry a provenance
> attestation — provenance requires the OIDC identity of a CI run, which a laptop
> does not have. Every subsequent release will have it. If provenance on 0.1.0
> matters to you, publish `0.1.0` as a throwaway, configure step 2, then release
> `0.1.1` through the workflow and deprecate `0.1.0`.

### Step 2 — register the trusted publisher (web UI only)

1. Go to **https://www.npmjs.com/package/shoot-cc/access**
   (only reachable once step 1 has created the package)

2. Find the **Trusted Publisher** section. Under **Select your publisher**, click
   **GitHub Actions**.

3. Enter exactly:

   | Field | Value |
   | --- | --- |
   | Organization or user | `CosmicShreyas` |
   | Repository | `Shoot` |
   | Workflow filename | `release.yml` |
   | Environment name | `npm-publish` |

   Note the repository is **`Shoot`** (capital S) while the package is
   **`shoot-cc`** — they deliberately differ, and this field wants the *repository*
   name.

   The workflow filename and environment must match
   [`.github/workflows/release.yml`](../.github/workflows/release.yml) exactly. If
   that file is renamed or its `environment:` changes, publishing breaks until this
   is updated — intended behaviour, not a bug.

4. **Remove any existing automation tokens** for this package from your npm
   account. Leaving one in place defeats the purpose entirely: an attacker would
   simply use the weaker path.

5. Optionally, in GitHub repo settings → **Environments** → `npm-publish`, add
   yourself as a required reviewer, so publishing pauses for explicit approval.

### Step 3 — confirm OIDC works before relying on it

**Actions → Release → Run workflow**, with `dry-run` left checked. It performs real
OIDC authentication and `npm publish --dry-run`, so a green run proves the trusted
publisher is configured correctly without publishing anything.

Do this before drafting your first Release, so the first real publish is not also
the first test of the credentials.

### After that: every release is a GitHub Release

See [Publishing a release](#publishing-a-release) below. In short: `npm version`,
push the tag, draft and publish a GitHub Release — the workflow does the rest.

## Publishing a release

Once the setup above is done, releases are triggered by **publishing a GitHub
Release**. That is the one deliberate human action; everything after it is automatic.

1. Bump the version and push the tag:
   ```bash
   npm version patch   # or minor / major — creates the commit AND the vX.Y.Z tag
   git push && git push --tags
   ```

2. On GitHub: **Releases → Draft a new release**. Choose the tag you just pushed
   (e.g. `v0.1.1`), write the notes, and click **Publish release**.

3. That's it. The workflow fires on `release: types: [published]` and will:
   - assert the release tag matches `package.json` version, failing loudly if not
   - run typecheck, build, and the full test suite
   - assert there are still zero runtime dependencies
   - print the exact file list via `npm pack --dry-run`
   - publish with `--provenance` using OIDC

### Why a GitHub Release, and not a push to main

Publishing to npm is effectively irreversible — a version can be deprecated but
never replaced. Triggering on `push: branches: [main]`, or on a green CI run, would
make that irreversible action a side effect of ordinary merging. Requiring a
published Release keeps exactly one intentional step, without making the rest manual.

### The version comes from package.json, checked against the tag

`npm publish` always publishes whatever version is in `package.json`; there is no
flag to override it. Rather than thread a version through the workflow, it asserts
that `github.event.release.tag_name` and `package.json` agree (ignoring a leading
`v`) and **refuses to publish on a mismatch**:

```
Version mismatch — refusing to publish.
  release tag  : v0.2.0  (-> 0.2.0)
  package.json : 0.1.1
Bump package.json and re-tag so the two agree.
```

Using `npm version` as in step 1 keeps them in sync automatically, since it writes
`package.json` and creates the matching tag in one command.

### Dry runs

`workflow_dispatch` is still available for rehearsals: **Actions → Release → Run
workflow**, leaving `dry-run` checked. It performs real OIDC authentication and
`npm publish --dry-run`, so a green run confirms the trusted publisher works without
publishing. A dispatch with `dry-run` unchecked publishes for real, same as a Release.

## What the workflow verifies before publishing

Not just a build — it re-runs the whole gate, because a release is the worst place
to discover a broken build:

- `npm run typecheck`
- `npm run build`
- `npm test` (the full suite)
- the zero-runtime-dependency assertion
- `npm pack --dry-run`, so the file list is visible in the log

## Node and npm version requirements

npm's documentation states Trusted Publishing needs **npm CLI 11.5.1 or later** and
**Node 22.14.0 or higher**. The npm floor is the binding one, and it matters more
than it looks:

| Node | Bundled npm | Sufficient? |
| --- | --- | --- |
| 18 | 10.8.2 | No — npm too old, Node too old |
| 20 | 10.8.2 | No — npm too old, Node too old |
| 22 | 10.9.8 | No — npm too old (Node itself is fine) |
| 24 | 11.16.0 | Yes |

The CI test matrix runs 18/20/22 because that is the range Shoot *supports*. The
release workflow pins **Node 24** and additionally runs `npm install -g npm@latest`
with an explicit version assertion, so a future change to bundled versions cannot
silently produce a token-less publish attempt on an npm that does not support it.

## If publishing fails

- **`ENEEDAUTH` or a 401/403** — the trusted publisher is not configured, or one of
  the four fields in step 3 does not match. The workflow filename and environment
  name are the ones people usually get wrong.
- **`id-token` errors** — check the job has `permissions: id-token: write`. It is
  set per-job, not just at the top of the file.
- **Provenance rejected** — the package must be public (`--access public`) and the
  repository URL in `package.json` must match where the workflow ran.

The workflow deliberately has no fallback path. If OIDC fails, it fails — it will
not quietly publish without provenance.
