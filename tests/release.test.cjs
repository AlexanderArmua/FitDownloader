const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inflateRawSync, crc32 } = require('node:zlib');
const { buildPackage, runtimeFiles, sha256 } = require('../scripts/package-release.cjs');
const { compareVersions, publishRelease } = require('../scripts/publish-release.cjs');

test('release ZIP contains exactly the committed runtime files, with manifest at its root and valid checksum', () => {
  const bundle = buildPackage(), zip = bundle.assets.get('FitDownloader.zip');
  const entries = new Map();
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0);
  let offset = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50);
    const method = zip.readUInt16LE(offset + 10), size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28), extra = zip.readUInt16LE(offset + 30), comment = zip.readUInt16LE(offset + 32);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString();
    const local = zip.readUInt32LE(offset + 42);
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    const content = method === 0 ? data : inflateRawSync(data);
    assert.equal(crc32(content), zip.readUInt32LE(offset + 16));
    if (!name.endsWith('/')) entries.set(name, content);
    offset += 46 + nameLength + extra + comment;
  }
  assert.deepEqual([...entries.keys()].sort(), runtimeFiles);
  assert.equal(JSON.parse(entries.get('manifest.json')).version, bundle.version);
  assert.equal(bundle.assets.get('SHA256SUMS.txt').toString(), `${sha256(zip)}  FitDownloader.zip\n`);
  assert.deepEqual(buildPackage().assets.get('FitDownloader.zip'), zip, 'building the same commit is deterministic');
});

function fixture(overrides = {}) {
  const sha = 'a'.repeat(40), repository = 'AlexanderArmua/FitDownloader';
  const bundle = { sha, version: '0.2.6', tag: 'v0.2.6', assets: new Map([['FitDownloader.zip', Buffer.from('fixture ZIP')], ['SHA256SUMS.txt', Buffer.from('fixture checksum')]]) };
  const state = { main: sha, runs: [{ head_sha: sha, head_branch: 'main', event: 'push', conclusion: 'success', head_repository: { full_name: repository } }],
    published: null, latest: null, tag: null, draft: null, assets: [], uploads: [], calls: [], ...overrides };
  const missing = () => { const error = new Error('Not found'); error.status = 404; throw error; };
  const api = async (method, route, body) => {
    state.calls.push({ method, route, body });
    if (route.includes('/git/ref/heads/main')) return { object: { sha: state.main } };
    if (route.includes('/actions/workflows/')) return { workflow_runs: state.runs };
    if (method === 'GET' && route.includes('/releases/tags/')) return state.published || missing();
    if (method === 'GET' && route.endsWith('/releases/latest')) return state.latest || missing();
    if (route.includes('/git/ref/tags/')) return state.tag || missing();
    if (method === 'GET' && route.endsWith('/releases?per_page=100')) return state.draft ? [state.draft] : [];
    if (route.endsWith('/generate-notes')) return { body: 'Generated changes' };
    if (method === 'POST' && route.endsWith('/releases')) {
      state.draft = { ...body, id: 1, upload_url: 'https://uploads.github.com/repos/owner/repo/releases/1/assets{?name,label}' };
      return state.draft;
    }
    if (method === 'GET' && route.includes('/assets?')) return state.assets;
    if (method === 'DELETE') { state.assets = state.assets.filter(asset => !route.endsWith('/' + asset.id)); return null; }
    if (route.startsWith('https://uploads.github.com/')) {
      const asset = { id: state.assets.length + 1, name: new URL(route).searchParams.get('name'), size: body.length,
        state: 'uploaded', digest: 'sha256:' + sha256(body) };
      state.assets.push(asset); state.uploads.push(asset.name);
      if (state.failUpload === asset.name) throw new Error('Upload interrupted');
      if (state.moveMainOnUpload) state.main = 'b'.repeat(40);
      return state.badDigest ? { ...asset, digest: 'sha256:wrong' } : asset;
    }
    if (method === 'PATCH') { state.published = { ...state.draft, ...body, html_url: 'https://github.com/owner/repo/releases/tag/v0.2.6' }; return state.published; }
    throw new Error('Unexpected fixture request: ' + method + ' ' + route);
  };
  return { state, bundle, repository, api, run: () => publishRelease({ api, repository, bundle }) };
}

test('release uploads all assets to a draft before publishing the tested main commit', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.skipped, false);
  assert.deepEqual(f.state.uploads, [...f.bundle.assets.keys()]);
  assert.equal(f.state.published.target_commitish, f.bundle.sha);
  assert.equal(f.state.published.make_latest, 'true');
  assert.equal(f.state.published.draft, false);
  assert.match(f.state.published.body, /Load unpacked/);
  assert.match(f.state.published.body, /Generated changes/);
  assert.equal(f.state.calls.at(-1).method, 'PATCH');
});

for (const [name, overrides] of [
  ['obsolete commit', { main: 'b'.repeat(40) }],
  ['missing CI', { runs: [] }],
  ['wrong commit CI', { runs: [{ head_sha: 'b'.repeat(40), head_branch: 'main', event: 'push', conclusion: 'success' }] }],
  ['PR CI', { runs: [{ head_sha: 'a'.repeat(40), head_branch: 'main', event: 'pull_request', conclusion: 'success' }] }],
  ['foreign repository CI', { runs: [{ head_sha: 'a'.repeat(40), head_branch: 'main', event: 'push', conclusion: 'success', head_repository: { full_name: 'someone/FitDownloader' } }] }],
  ['version downgrade', { latest: { tag_name: 'v0.2.10' } }],
  ['conflicting tag', { tag: { object: { type: 'commit', sha: 'b'.repeat(40) } } }],
  ['unrelated draft', { draft: { tag_name: 'v0.2.6', draft: true, target_commitish: 'b'.repeat(40) } }]
]) {
  test(`release rejects ${name} without publishing or changing public assets`, async () => {
    const f = fixture(overrides);
    await assert.rejects(f.run());
    assert.equal(f.state.calls.some(call => ['POST', 'PATCH', 'DELETE'].includes(call.method)), false);
  });
}

test('already published version is skipped without overwriting assets on later documentation commits', async () => {
  const f = fixture({ published: { draft: false, html_url: 'https://github.com/owner/repo/releases/tag/v0.2.6' } });
  assert.equal((await f.run()).skipped, true);
  assert.equal(f.state.calls.some(call => call.method !== 'GET'), false);
});

test('interrupted upload leaves a draft and rerun resumes with verified existing assets', async () => {
  const f = fixture({ failUpload: 'SHA256SUMS.txt' });
  await assert.rejects(f.run(), /Upload interrupted/);
  assert.equal(f.state.published, null);
  assert.equal(f.state.draft.draft, true);
  f.state.failUpload = null;
  assert.equal((await f.run()).skipped, false);
  assert.deepEqual(f.state.uploads, ['FitDownloader.zip', 'SHA256SUMS.txt']);
});

for (const overrides of [{ badDigest: true }, { moveMainOnUpload: true }]) {
  test(`release remains a draft on ${overrides.badDigest ? 'checksum mismatch' : 'main advancing during upload'}`, async () => {
    const f = fixture(overrides);
    await assert.rejects(f.run());
    assert.equal(f.state.published, null);
  });
}

test('release version comparison is numeric and accepts four-part extension versions', () => {
  assert.equal(compareVersions('v0.2.10', 'v0.2.9'), 1);
  assert.equal(compareVersions('v0.2.6', 'v0.2.6.0'), 0);
  assert.equal(compareVersions('v0.2.6.1', 'v0.2.6'), 1);
});

test('release refuses an unexpected upload host before sending asset data', async () => {
  const f = fixture({ draft: { id: 1, tag_name: 'v0.2.6', target_commitish: 'a'.repeat(40),
    draft: true, upload_url: 'https://evil.example/upload{?name}' } });
  await assert.rejects(f.run(), /Unexpected GitHub upload/);
  assert.equal(f.state.calls.some(call => call.method !== 'GET'), false);
});

test('retry replaces an incomplete asset only while the release is a draft', async () => {
  const f = fixture({ draft: { id: 1, tag_name: 'v0.2.6', target_commitish: 'a'.repeat(40),
    draft: true, upload_url: 'https://uploads.github.com/repos/owner/repo/releases/1/assets{?name,label}' },
  assets: [{ id: 20, name: 'FitDownloader.zip', state: 'starter', size: 0 }] });
  await f.run();
  assert.equal(f.state.calls.filter(call => call.method === 'DELETE').length, 1);
  assert.deepEqual(f.state.uploads, ['FitDownloader.zip', 'SHA256SUMS.txt']);
});
