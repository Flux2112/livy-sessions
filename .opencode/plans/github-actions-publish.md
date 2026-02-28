# Plan: GitHub Actions CI/CD Publish Workflow

## File to create

`.github/workflows/publish.yml`

---

## Trigger

```yaml
on:
  push:
    branches: [main]
```

To prevent an infinite loop when the workflow commits the version bump back to
main, the commit will be authored with `[skip ci]` in the message. GitHub
Actions natively skips workflow runs for commits containing `[skip ci]`.

---

## Jobs

Single job: `publish`, running on `ubuntu-latest`.

### Steps in order

| # | Step | Detail |
|---|------|--------|
| 1 | **Checkout** | `actions/checkout@v4` with `fetch-depth: 0` and `token: ${{ secrets.AZURE_PAT }}` (so the bot can push back) |
| 2 | **Setup Node** | `actions/setup-node@v4`, Node 20 |
| 3 | **Install deps** | `npm ci` |
| 4 | **Typecheck** | `npm run typecheck` |
| 5 | **Lint** | `npm run lint` |
| 6 | **Test** | `npm test` — workflow aborts here if tests fail |
| 7 | **Bump version** | `npm version minor --no-git-tag-version` — edits `package.json` in-place, no tag yet |
| 8 | **Commit & push** | `git commit -am "chore: bump minor version [skip ci]"` + `git push` |
| 9 | **Git tag** | Create and push a `vX.Y.0` tag matching the new version |
| 10 | **Build** | `npm run build` (production esbuild bundle) |
| 11 | **Package** | `npm run package` → produces a `.vsix` file |
| 12 | **Publish** | `npx vsce publish --pat ${{ secrets.AZURE_PAT }}` |
| 13 | **Upload artifact** | Upload the `.vsix` as a GitHub Actions artifact for auditability |

---

## Key decisions

- **`[skip ci]`** in the bump commit message prevents re-triggering the
  workflow on the version commit.
- **`--no-git-tag-version`** on `npm version` keeps the git tag creation in a
  separate explicit step, giving full control over when/whether it is pushed.
- The checkout uses `AZURE_PAT` (not `GITHUB_TOKEN`) so the pushed commit and
  tag can trigger other workflows if needed — `GITHUB_TOKEN` pushes are blocked
  from triggering new workflow runs by default.
- Typecheck and lint run before tests — fail fast on obvious issues.
- The `.vsix` artifact is uploaded after packaging regardless of publish
  outcome, useful for debugging. Publish only runs after a successful package
  step.
- `npm ci` is used (not `npm install`) for reproducible, locked installs in CI.
- Node 20 is used to match the `node18` esbuild target (compatible superset).

---

## Secrets required

Add one secret to the GitHub repo settings:

| Secret name | Value |
|-------------|-------|
| `AZURE_PAT` | VS Code Marketplace Personal Access Token |

---

## What is not included (by design)

- No Windows/macOS matrix — the extension has no native binaries to test
  cross-platform (kerberos is optional and excluded from the VSIX).
- No changelog generation — can be added later.
- No GitHub Releases entry — can be added later.
