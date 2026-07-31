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

## One-time manual setup (cannot be automated)

This is the part no CLI can do — npm requires it to be configured in the web UI,
because it is the step that establishes trust in the first place.

**Do this once, before the first release:**

1. Publish version `0.1.0` manually, from a local machine:
   ```bash
   npm login
   npm run build
   npm publish --access public
   ```
   Trusted Publishing can only be configured on a package that already exists, so
   the first publish is necessarily manual. (Alternatively, create the package as
   a placeholder and immediately configure step 2 before the real release.)

2. Go to **https://www.npmjs.com/package/shoot-cc/access**

3. Under **Trusted Publisher**, choose **GitHub Actions** and enter exactly:

   | Field | Value |
   | --- | --- |
   | Organization or user | `CosmicShreyas` |
   | Repository | `Shoot` |
   | Workflow filename | `release.yml` |
   | Environment name | `npm-publish` |

   The workflow filename and environment must match
   [`.github/workflows/release.yml`](../.github/workflows/release.yml) exactly. If
   that file is renamed or its `environment:` changes, publishing breaks until this
   is updated — which is the intended behaviour, not a bug.

4. **Remove any existing automation tokens** for this package from your npm
   account. Leaving one in place defeats the purpose: an attacker would simply use
   the weaker path.

5. Optionally, in GitHub repo settings → **Environments** → `npm-publish`, add
   yourself as a required reviewer. Publishing then pauses for explicit approval.

## Publishing a release

Once the above is done:

1. Bump the version and commit it:
   ```bash
   npm version patch   # or minor / major
   git push && git push --tags
   ```

2. Go to **Actions → Release → Run workflow**.

3. **Leave `dry-run` checked for the first run.** It executes every step including
   `npm publish --dry-run`, so you can confirm the package contents and that OIDC
   authentication works, without publishing anything.

4. Re-run with `dry-run` unchecked to publish for real.

## What the workflow verifies before publishing

Not just a build — it re-runs the whole gate, because a release is the worst place
to discover a broken build:

- `npm run typecheck`
- `npm run build`
- `npm test` (the full suite)
- the zero-runtime-dependency assertion
- `npm pack --dry-run`, so the file list is visible in the log

## Node and npm version requirements

Trusted Publishing needs **npm >= 11.5.1**. This matters more than it looks:

| Node | Bundled npm | Sufficient? |
| --- | --- | --- |
| 18 | 10.8.2 | No |
| 20 | 10.8.2 | No |
| 22 | 10.9.8 | No |
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
