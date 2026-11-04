const fs = require('node:fs');
const { buildPackage, sha256 } = require('./package-release.cjs');

function compareVersions(a, b) {
  const left = a.replace(/^v/, '').split('.').map(Number);
  const right = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}
async function optional(api, route) {
  try { return await api('GET', route); }
  catch (error) { if (error.status === 404) return null; throw error; }
}
async function publishRelease({ api, repository, bundle }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository.');
  const prefix = `/repos/${repository}`;
  async function requireCurrentMain() {
    const ref = await api('GET', `${prefix}/git/ref/heads/main`);
    if (ref.object.sha !== bundle.sha) throw new Error('Release commit is no longer main. Wait for CI on the current main commit.');
  }
  await requireCurrentMain();
  const runs = await api('GET', `${prefix}/actions/workflows/tests.yml/runs?branch=main&event=push&status=success&head_sha=${bundle.sha}&per_page=100`);
  if (!runs.workflow_runs.some(run => run.head_sha === bundle.sha && run.head_branch === 'main' &&
      run.event === 'push' && run.conclusion === 'success' && run.head_repository?.full_name === repository)) {
    throw new Error('Required Tests workflow has not passed for this main commit.');
  }
  const published = await optional(api, `${prefix}/releases/tags/${bundle.tag}`);
  if (published && !published.draft) return { skipped: true, url: published.html_url };
  const latest = await optional(api, `${prefix}/releases/latest`);
  if (latest && /^v\d+\.\d+\.\d+(\.\d+)?$/.test(latest.tag_name) && compareVersions(bundle.tag, latest.tag_name) <= 0) {
    throw new Error('Version must be newer than the latest release.');
  }
  const tag = await optional(api, `${prefix}/git/ref/tags/${bundle.tag}`);
  if (tag && (tag.object.type !== 'commit' || tag.object.sha !== bundle.sha)) throw new Error('Release tag already points to another commit; it will not be moved.');
  const releases = await api('GET', `${prefix}/releases?per_page=100`);
  let draft = published || releases.find(release => release.tag_name === bundle.tag);
  if (draft && (!draft.draft || draft.target_commitish !== bundle.sha)) throw new Error('Existing release draft belongs to another commit.');
  if (!draft) {
    const notes = await api('POST', `${prefix}/releases/generate-notes`, { tag_name: bundle.tag, target_commitish: bundle.sha });
    const body = `Download **FitDownloader.zip** below, extract it, then open chrome://extensions, enable Developer mode and choose **Load unpacked**. Select the extracted folder containing manifest.json.\n\n` +
      `To update an unpacked installation, replace the files in the same folder and click **Reload** in chrome://extensions. GitHub releases do not automatically update unpacked Chrome extensions.\n\n` +
      `The ZIP contains runtime files only. SHA256SUMS.txt provides the download checksum.\n\nTested commit: ${bundle.sha}\n\n${notes.body || ''}`;
    draft = await api('POST', `${prefix}/releases`, { tag_name: bundle.tag, target_commitish: bundle.sha,
      name: `FitDownloader ${bundle.tag}`, body, draft: true, prerelease: false });
  }
  const upload = new URL(draft.upload_url.split('{')[0]);
  if (upload.protocol !== 'https:' || upload.hostname !== 'uploads.github.com' || upload.username || upload.password || upload.port) throw new Error('Unexpected GitHub upload destination.');
  const existing = await api('GET', `${prefix}/releases/${draft.id}/assets?per_page=100`);
  for (const [name, data] of bundle.assets) {
    const digest = 'sha256:' + sha256(data);
    const asset = existing.find(asset => asset.name === name);
    if (asset?.state === 'uploaded' && asset.size === data.length && asset.digest === digest) continue;
    if (asset) await api('DELETE', `${prefix}/releases/assets/${asset.id}`);
    const uploaded = await api('POST', upload.href + '?name=' + encodeURIComponent(name), data);
    if (uploaded.state !== 'uploaded' || uploaded.size !== data.length || (uploaded.digest && uploaded.digest !== digest)) throw new Error(`Release asset verification failed: ${name}`);
  }
  await requireCurrentMain();
  const release = await api('PATCH', `${prefix}/releases/${draft.id}`, { draft: false, make_latest: 'true' });
  return { skipped: false, url: release.html_url };
}

function githubApi(token) {
  if (!token) throw new Error('GITHUB_TOKEN is required.');
  return async (method, route, body) => {
    const url = new URL(route, 'https://api.github.com');
    if (url.protocol !== 'https:' || !['api.github.com', 'uploads.github.com'].includes(url.hostname) || url.username || url.password || url.port) throw new Error('Invalid GitHub API URL.');
    const response = await fetch(url, { method, redirect: 'error', headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
      'User-Agent': 'FitDownloader-release'
    }, body: body == null ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    if (!response.ok) {
      const error = new Error(`GitHub ${method} ${url.pathname} failed (${response.status}).`);
      error.status = response.status; throw error;
    }
    return response.status === 204 ? null : response.json();
  };
}
module.exports = { compareVersions, publishRelease, githubApi };
if (require.main === module) {
  publishRelease({ api: githubApi(process.env.GITHUB_TOKEN), repository: process.env.GITHUB_REPOSITORY, bundle: buildPackage() })
    .then(result => {
      const message = `${result.skipped ? 'Already published' : 'Published'}: ${result.url}`;
      console.log(message);
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, message + '\n');
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
