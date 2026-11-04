const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { checkManifest } = require('./check-manifest.cjs');
const root = path.resolve(__dirname, '..');
const runtimeFiles = [
  'background.js', 'manifest.json', 'options.html', 'options.js', 'popup.html', 'popup.js',
  ...[16, 32, 48, 128, 512].map(size => `icons/icon-${size}.png`)
].sort();
const sha256 = data => createHash('sha256').update(data).digest('hex');

function buildPackage() {
  const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 10 * 1024 * 1024 });
  const sha = git(['rev-parse', 'HEAD']).toString().trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Expected a full commit SHA.');
  const read = file => git(['show', `${sha}:${file}`]);
  const manifest = JSON.parse(read('manifest.json'));
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const entries = git(['ls-tree', '-r', '--name-only', sha]).toString().trim().split('\n');
  for (const file of runtimeFiles) {
    if (!entries.includes(file)) throw new Error(`Missing release file: ${file}`);
    const mode = git(['ls-tree', sha, '--', file]).toString().split(' ')[0];
    if (mode !== '100644') throw new Error(`Release file must be a regular file: ${file}`);
  }
  checkManifest(manifest, file => runtimeFiles.includes(file), pkg.version);
  if (pkg.version !== manifest.version || lock.version !== manifest.version || lock.packages[''].version !== manifest.version) {
    throw new Error('Committed manifest/package/lock versions differ.');
  }
  for (const file of ['popup.html', 'options.html']) {
    for (const match of read(file).toString().matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
      if (!runtimeFiles.includes(match[1])) throw new Error(`Unpackaged HTML dependency: ${match[1]}`);
    }
  }
  // Git creates the ZIP from the exact committed snapshot, never the worktree.
  const zip = git(['archive', '--format=zip', sha, '--', ...runtimeFiles]);
  return { sha, version: manifest.version, tag: `v${manifest.version}`, files: runtimeFiles,
    assets: new Map([
      ['FitDownloader.zip', zip],
      ['SHA256SUMS.txt', Buffer.from(`${sha256(zip)}  FitDownloader.zip\n`)]
    ]) };
}

function writePackage(output = path.join(root, 'dist')) {
  const result = buildPackage();
  fs.mkdirSync(output, { recursive: true });
  for (const [name, data] of result.assets) fs.writeFileSync(path.join(output, name), data);
  console.log(`Packaged ${result.tag} from ${result.sha}: ${result.files.length} runtime files.`);
  return result;
}
module.exports = { buildPackage, writePackage, runtimeFiles, sha256 };
if (require.main === module) writePackage();
