# Publishing FitDownloader

User downloads:

- [Latest runtime ZIP](https://github.com/AlexanderArmua/FitDownloader/releases/latest/download/FitDownloader.zip)
- [Latest release notes and checksum](https://github.com/AlexanderArmua/FitDownloader/releases/latest)

These stable links follow GitHub's [latest-release URL convention](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases).

## Automatic publishing

1. Change `manifest.json`, `package.json` and both root version fields in `package-lock.json` to the same new version. Version comparisons are numeric; a new release must be newer than the latest release.
2. Run `npm run check` and relevant Chromium tests. Commit the complete change on a focused branch, check CI, and advance the user's `main` through the normal review workflow.
3. When the **Tests** push workflow passes for that exact `main` commit, **Release** packages and publishes it as `v<manifest version>`. The job confirms the commit is still `main` and belongs to this repository. Pull-request CI and fork CI cannot authorize a release.
4. Download the ZIP from the release Assets section. The stable filename is always `FitDownloader.zip`; `SHA256SUMS.txt` contains its SHA-256 checksum. GitHub-generated release notes include installation instructions and the tested commit.

Publishing is intentionally automatic when a new version reaches tested `main`. A documentation-only commit or rerun with an already published version skips publishing and never replaces public release assets. The initial release uses the existing version 0.2.6 because this change adds release tooling without changing runtime behavior.

The [workflow_run trigger](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run) runs only for successful **Tests** pushes on `main` in AlexanderArmua/FitDownloader. It checks out the tested SHA, disables persisted Git credentials, and uses the built-in `GITHUB_TOKEN` with `actions: read` and `contents: write`. Other workflows keep read-only permissions. No personal access token or new secret is needed.

## Package locally

```text
npm run package
```

The builder reads the **committed HEAD snapshot** through Git, including its manifest/package/lock versions. Commit runtime/version changes before building a candidate intended for distribution. Uncommitted files are never silently added to a release.

Outputs in ignored `dist/`:

- `FitDownloader.zip`: 11 explicitly allowed runtime files, with `manifest.json` at the archive root and icons under `icons/`.
- `SHA256SUMS.txt`: checksum for that exact ZIP.

The builder validates referenced manifest/HTML assets, matching versions and regular-file modes. No Git metadata, development dependencies, tests, coverage, screenshots, AGENTS instructions or planning documents are included. Update the allowlist and tests intentionally when adding runtime files.

For example, verify a downloaded ZIP in PowerShell with `Get-FileHash .\FitDownloader.zip -Algorithm SHA256`, comparing the result to `SHA256SUMS.txt`.

## Retry and failure behavior

- Uploads happen to a **draft**. The release becomes public/latest only after both assets upload and pass size/digest checks, and `main` is checked again.
- If an upload fails, use **Actions → Release → Run workflow**, selecting `main`, or rerun the failed job while that same commit is still `main`. Matching draft assets are reused; incomplete draft assets are replaced. CI for that exact commit must already have passed.
- A published release is never overwritten, even on rerun. Existing tags pointing to a different commit and unrelated drafts are refused.
- If `main` advances while a draft is being uploaded, publishing stops. Inspect the failed draft and publish a new version from the next tested commit; do not move a published tag or replace public assets to hide the failure.

GitHub release ZIPs are for **Load unpacked** installation. They are not signed Chrome Web Store packages and do not provide browser-managed automatic updates. To update an existing installation, replace the files in the same folder and click **Reload** in `chrome://extensions/`.
