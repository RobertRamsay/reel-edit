// Release Reel Edit: node release.js
//   1. bump "version", "build" (always +1) and "date" in version.json, write "notes"
//   2. commit, then run this. It builds the exe + zip, creates the GitHub release v<version>
//      with the zip attached, pushes, and updates the update feed (gist latest.json) so
//      running copies show "Update available".
// --dry builds and zips only.
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const root = __dirname, dry = process.argv.includes('--dry');
const V = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8'));
const run = (cmd, args, opt = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opt });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim();
const tag = 'v' + V.version;

if (!dry) {
  if (out('git', ['status', '--porcelain'])) throw new Error('commit your changes first (git status is not clean)');
  const feed = JSON.parse(out('gh', ['gist', 'view', V.gist, '--raw', '--filename', 'latest.json']));
  if (!(V.build > feed.build)) throw new Error(`version.json build ${V.build} must be higher than the published build ${feed.build}`);
  if (out('git', ['tag', '--list', tag])) throw new Error(`tag ${tag} already exists: bump "version" in version.json`);
}

console.log(`\n== Reel Edit ${tag} (build ${V.build}, ${V.date})`);
run('dotnet', ['publish', 'desktop', '-c', 'Release', '-o', 'dist']); // also rebuilds ReelEdit.html from src/

// stage ReelEdit/ (exe, web build, sources) and zip it
const stage = path.join(root, 'ReelEdit');
fs.rmSync(stage, { recursive: true, force: true });
const copy = (from, to) => { fs.mkdirSync(path.dirname(path.join(stage, to)), { recursive: true }); fs.copyFileSync(path.join(root, from), path.join(stage, to)); };
for (const f of ['README.txt', 'ReelEdit.html', 'version.json']) copy(f, f);
copy('dist/ReelEdit.exe', 'ReelEdit.exe');
for (const f of fs.readdirSync(path.join(root, 'src'))) copy('src/' + f, 'src/' + f);
for (const f of fs.readdirSync(path.join(root, 'desktop'))) if (fs.statSync(path.join(root, 'desktop', f)).isFile()) copy('desktop/' + f, 'desktop/' + f);
fs.rmSync(path.join(root, 'ReelEdit.zip'), { force: true });
run('powershell', ['-NoProfile', '-Command', 'Compress-Archive -Path ReelEdit -DestinationPath ReelEdit.zip -CompressionLevel Optimal']);
console.log('ReelEdit.zip', (fs.statSync(path.join(root, 'ReelEdit.zip')).size / 1048576).toFixed(1), 'MB');
if (dry) process.exit(0);

run('git', ['tag', '-a', tag, '-m', `Reel Edit ${tag} (build ${V.build})`]);
run('git', ['push', 'origin', 'HEAD', tag]);
run('gh', ['release', 'create', tag, 'ReelEdit.zip', '--repo', V.repo, '--title', `Reel Edit ${tag}`, '--notes', `${V.notes || ''}\n\nBuild ${V.build} · ${V.date}`]);

// the feed goes last, so nobody is told about a release that isn't downloadable yet
const latest = { version: V.version, build: V.build, date: V.date, url: `https://github.com/${V.repo}/releases/tag/${tag}`, notes: V.notes || '' };
const tmp = path.join(require('os').tmpdir(), 'latest.json');
fs.writeFileSync(tmp, JSON.stringify(latest, null, 2) + '\n');
run('gh', ['gist', 'edit', V.gist, '--filename', 'latest.json', tmp]);
console.log(`\nReleased ${tag}. Running copies will see it within ~5 minutes (feed cache).`);
