const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
for (const file of fs.readdirSync('src').filter(f => f.endsWith('.js'))) {
  execFileSync(process.execPath, ['--check', 'src/' + file], { stdio: 'inherit' });
}
for (const file of fs.readdirSync('test/live').filter(f => f.endsWith('.gs'))) {
  execFileSync(process.execPath, ['--check'], { input: fs.readFileSync('test/live/' + file), stdio: ['pipe', 'inherit', 'inherit'] });
}
JSON.parse(fs.readFileSync('src/appsscript.json', 'utf8'));
console.log('Source, live-test syntax, and manifest JSON checks passed.');
