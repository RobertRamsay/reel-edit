// Assembles src/* into a single self-contained ReelEdit.html
const fs = require('fs'), path = require('path');
const dir = __dirname;
// version.json (repo root) is the single source of the version: the page gets APP_VER, the exe reads it in ReelEdit.csproj
const V = JSON.parse(fs.readFileSync(path.join(dir, '..', 'version.json'), 'utf8'));
const ver = `const APP_VER = ${JSON.stringify({ version: V.version, build: V.build, date: V.date, feed: V.feed })};\n`;
const js = ver + ['core.js', 'proxy.js', 'export.js', 'timeline.js', 'ui.js'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
const shell = fs.readFileSync(path.join(dir, 'shell.html'), 'utf8');
const out = shell.replace('/*@@APP@@*/', () => js);
fs.writeFileSync(path.join(dir, '..', 'ReelEdit.html'), out);
if (process.argv[2]) fs.writeFileSync(process.argv[2], js);
console.log(`ReelEdit.html v${V.version} build ${V.build}`, (out.length / 1024).toFixed(1) + ' KB');
