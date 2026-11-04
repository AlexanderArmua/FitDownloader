<p align="center">
<img width="128" height="128" alt="icon-128" src="https://github.com/user-attachments/assets/2321f3ab-7e7f-41d0-a200-64cd81906c05" />
</p>

## FitDownloader

FitDownloader is a simple Chrome extension that scans supported FitGirl repack pages for `fuckingfast.co` links, lets you choose which files to keep, and starts the downloads in the background with a configurable concurrency limit.

**[Download latest version](https://github.com/AlexanderArmua/FitDownloader/releases/latest/download/FitDownloader.zip)** · [Release notes and checksums](https://github.com/AlexanderArmua/FitDownloader/releases/latest)

## Preview

![fitdownloader-preview](https://github.com/user-attachments/assets/61baefa5-c3d5-4110-a09e-3efab66661b9)

## Installation

1. [Download FitDownloader.zip](https://github.com/AlexanderArmua/FitDownloader/releases/latest/download/FitDownloader.zip) and extract it into a permanent folder.
2. Open `chrome://extensions/` in Chrome.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted folder containing `manifest.json`.

To update, download the latest ZIP, replace the files in the existing extension folder, then click **Reload** on `chrome://extensions/`. GitHub releases do not automatically update unpacked Chrome extensions. Developers can still clone the repository or download its source ZIP.

## Usage

1. Open a supported page on `fitgirl-repacks.site` that includes `fuckingfast.co` links.
2. Click the `FitDownloader` toolbar button.
3. Review the detected files and uncheck anything you do not want.
4. Use the popup selection shortcuts for quicker review: `Shift+Click` selects a range, and `Ctrl+Click` or `Cmd+Click` toggles items individually.
5. Set **Maximum parallel downloads per batch** (1–20) in the main popup, then click **Start downloads**. The value is saved automatically before starting.
6. Use **Apply** to save a new limit during a batch, or change it through **Settings**. Increasing the limit fills available slots; decreasing it allows existing downloads to finish before starting more. The limit applies separately to each tab's batch.
7. You can close the source page after starting a batch. Open the extension from any tab and use **Saved batches** to inspect or control preserved batches.
8. Finished and failed results stay available when reopening the popup. Use **Retry failed** for failures, or **Scan page again** on the original page for a fresh selection after finishing/cancelling active work.
9. After a full browser restart, press **Resume** to start queued work. Ordinary background-worker recovery reconciles existing Chrome downloads before continuing eligible queued files.
10. Saved batches and files retain their identities even when tabs change or a queue is reordered. Existing saved queues are upgraded automatically; active Chrome downloads retain their download IDs.
11. If Chrome rejects Pause, Resume or Cancel, successful changes are kept and affected files remain tracked. Use **Retry Pause**, **Retry Resume** or **Retry Cancel** to retry the unfinished operation. New queued files wait while an operation is incomplete; some existing downloads may still be running.
12. Pause, Resume, Cancel and removal actions in Chrome's Downloads update the open popup. Individually paused files retain their parallel slots. Resuming an interrupted download in Chrome restores tracking and holds queued files until you choose **Resume** in the extension.
13. Cancel also stops pending file-host requests and response reads. If Chrome is already creating a download, cancellation is applied once its ID is available. Tiny downloads that finish immediately no longer leave a stuck queue slot.

## Notes

- The extension only requests access to `fitgirl-repacks.site` and `fuckingfast.co`.
- Downloads run through Chrome's standard download manager.
- Chrome's **Ask where to save each file before downloading** setting still applies. Turn it off in Chrome if you want downloads to start without save prompts.
- If the target sites change their HTML structure, link detection may need to be updated.
- Source pages must use HTTPS on the exact `fitgirl-repacks.site` hostname. File links using HTTP are upgraded to HTTPS before any request. Downloads never fall back to HTTP.
- Scanning runs in an isolated script environment. Both landing and direct download URLs are checked against the supported hosts.
- Hover a filename to inspect its URL, or a failed download's status to read its error.
- Local extension storage keeps browser download IDs associated with their batch, file links and labels so interrupted attempts can be recognized after restarting. Erasing a download from Chrome's history removes that association; finished batch results remain available. A dedicated clear-history control remains planned work.
- Current file-host pages use a `hx-post="/f/<file-id>/go"` Download control instead of embedding a direct archive URL. The extension requests that exact same-host endpoint and reads secure links from HTMX response headers or response text. It does not click advertising controls, open ad tabs, or execute fetched scripts. Legacy embedded links still work.
- Requests include the browser's existing cookies for the supported file host; cookie values are never read by extension code. A host verification/refusal response pauses the batch and keeps files queued. Open the original file page to complete any verification yourself, then click **Resume** in the extension. This may still fail if the host does not accept requests from extensions.

## Updating and troubleshooting

After updating these files, open `chrome://extensions/`, find **FitDownloader**, and click **Reload**. Then reopen the popup on the repack page.

If fetching fails, check the extension's **Details → Site access** and allow the supported HTTPS sites. The previous version retried HTTP requests without matching host permissions, which could produce a CORS error after an HTTP-to-HTTPS redirect. This version upgrades the original URL and fetches it directly over HTTPS, stripping the filename fragment first. It does not use `no-cors` or ask you to disable browser security.

An HTTP 403 response means the host refused the request; a challenge page can also arrive with HTTP 200. These responses pause the queue with a verification message. Open the original file link in a normal browser tab to check whether the host is available and whether it requires a challenge, then resume. The extension does not bypass access controls. Unexpected HTTP redirects and download destinations outside the supported HTTPS hosts are rejected.

## Development checks

Use Node 24 (24.8.0 or newer) and run:

```text
npm ci --ignore-scripts
npm run check
npm run test:browser:install
npm run test:browser
```

`npm run check` runs scoped lint rules, manifest validation and 216 unit/DOM/tooling tests with application coverage thresholds (85% lines, 75% branches, 95% functions). Coverage includes unexecuted application scripts and excludes test harnesses. Open `coverage/index.html` for the detailed report.

Browser tests load the real extension in a separate Chromium profile, use controlled page fixtures, and download only a tiny generated text fixture. They do not visit the real file host or open advertising. Browser installation is kept in this project's dependency cache.

The four original recovery defects now have passing regressions in the required lifecycle suite. Run `npm run test:regressions` for the focused recovery subset. All CI jobs are required to pass; the temporary non-blocking known-defect job has been removed. See [tests/README.md](tests/README.md) and [IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md).

To check live compatibility, reload the unpacked extension and try one selected file before starting a full batch. Automated tests cover the observed download control and simulated host responses; the host's availability and verification requirements can change independently.

## Automatic releases

After the required **Tests** workflow succeeds on `main`, the **Release** workflow publishes a new manifest version as a GitHub release with `FitDownloader.zip` and `SHA256SUMS.txt`. Reusing an already published version leaves its assets unchanged; change the manifest/package/lock versions together for a new release. No additional repository secret is needed.

`npm run package` builds the runtime-only ZIP from committed `HEAD` into ignored `dist/`. Tests, dependencies, Git metadata and development documentation are excluded. See [RELEASING.md](RELEASING.md) for validation, retries and publishing details.


