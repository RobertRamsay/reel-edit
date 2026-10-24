// Assembles src/* into a single self-contained ReelEdit.html
const fs = require('fs'), path = require('path');
const dir = __dirname;
const js = ['core.js', 'proxy.js', 'export.js', 'timeline.js', 'ui.js'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
const shell = fs.readFileSync(path.join(dir, 'shell.html'), 'utf8');
const out = shell.replace('/*@@APP@@*/', () => js);
fs.writeFileSync(path.join(dir, '..', 'ReelEdit.html'), out);
if (process.argv[2]) fs.writeFileSync(process.argv[2], js);
console.log('ReelEdit.html', (out.length / 1024).toFixed(1) + ' KB');
