# Handoff: publishing pipeline

Two separate things happened to `.github/workflows/publish.yml`. One is finished; the other blocks every release and needs a decision.

---

## 1. Publishing now authenticates with Entra ID — done

Marketplace PATs retire on **1 December 2026**, so `secrets.AZURE_PAT` is no longer read. `azure/login@v3` exchanges the runner's GitHub OIDC token for an Azure CLI session, and `vsce publish --azure-credential` picks it up through its credential chain, requesting a token for the Azure DevOps resource `499b84ac-1321-427f-aa17-267ca6975798`.

| Piece | Value |
|---|---|
| Managed identity | `cai-connector-publisher`, resource group `vscode-publish-rg` |
| Federated credential | `github-livy-sessions-main` → `repo:Flux2112/livy-sessions:ref:refs/heads/main` |
| Repo secrets | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` |
| Marketplace | already covered — the identity is a Contributor on `DefySoftwareSolutions` |

The identity is shared with the `cai-connector` extension. Both publish under the same publisher, so one Marketplace membership serves both and each repo only needs its own federated credential. The name is a leftover from the extension it was created for; it is not specific to it.

Full detail lives in the **CI / CD** section of `AGENTS.md`.

**Unverified here.** The federation itself was proven end to end from the `cai-connector` repo — a workflow authenticated as this identity and obtained an Azure DevOps token. What has never run in *this* repo is the publish step, because of the problem below.

`AZURE_PAT` still exists on the repo and is now read by nothing. Delete it once a release publishes green.

---

## 2. `package-lock.json` points at an internal registry — BLOCKING

**No release has succeeded since April 2026.** Every run of `publish.yml` fails at `Install deps`, long before anything to do with authentication:

```
npm error code ENOTFOUND
npm error network request to
  https://pnexus.w.oenb.co.at:8410/repository/npm-public/yoctocolors-cjs/-/yoctocolors-cjs-2.1.3.tgz
  failed, reason: getaddrinfo ENOTFOUND pnexus.w.oenb.co.at
```

290 `resolved` entries in `package-lock.json` point at the OeNB internal Nexus mirror, against 783 on the public registry. The lockfile was committed from a machine inside the corporate network; GitHub runners cannot resolve that host, so `npm ci` dies.

Run history, all failures:

```
2026-05-18  2026-05-18  2026-05-18  2026-04-20  …
```

### The fix

Regenerate the lockfile against the public registry, from a machine **not** on the OeNB network:

```bash
npm install --package-lock-only --registry=https://registry.npmjs.org
```

Then confirm the mirror is gone before committing:

```bash
grep -c 'pnexus.w.oenb.co.at' package-lock.json   # expect 0
```

This can shift resolved patch versions, so read the diff rather than committing it blind, and re-run `npm run typecheck && npm run lint && npm test` locally first.

### Preventing a recurrence

- Check for a stray `.npmrc` in whatever clone produced the lockfile. The global npm registry on the maintainer's machine is already `https://registry.npmjs.org/`, so this looks like a one-off install from inside the corporate network rather than a persistent misconfiguration.
- This repository is **public**, and an internal hostname is currently committed to it. Minor, but presumably unintended.

---

## Verifying the whole thing

Once the lockfile is fixed, the next push to `main` is the real test, and it fails safe. The order of steps is:

```
typecheck → lint → test → Azure login → Verify Marketplace credential
  → bump → tag → build → package → publish
```

`Verify Marketplace credential` makes byte-for-byte the same call vsce's `AzureCliCredential` makes, and it sits **before** the version bump. A broken federation therefore costs a red run rather than a bumped version and a pushed tag with no release behind them.

If the credential step fails, check the **subject** first: trust is per branch, it must match `repo:Flux2112/livy-sessions:ref:refs/heads/main` exactly, and Microsoft's documentation warns that a mismatch fails the token exchange *silently* — no useful error, just a refusal.

Pre-existing and untouched: bump, commit and tag still run before packaging, so a failure *after* the credential check still leaves a pushed tag with no release. Worth reordering some day.
