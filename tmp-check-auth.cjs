const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const url = 'https://github.com/GaoHu1997/dsh-git-branch.git';
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

function run(label, args) {
  try {
    const out = execFileSync('git', args,
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, windowsHide: true, env });
    console.log(label + ': OK -> ' + out.toString().trim().split('\n')[0]);
  } catch (err) {
    console.log(label + ': FAILED status=' + err.status + ' code=' + err.code +
      ' signal=' + err.signal + ' killed=' + err.killed);
    if (err.message) console.log('  node-error: ' + String(err.message).split('\n')[0]);
    if (err.stdout && err.stdout.toString().trim()) console.log('  stdout: ' + err.stdout.toString().trim());
    if (err.stderr && err.stderr.toString().trim()) console.log('  stderr: ' + err.stderr.toString().trim());
  }
}

// stored plugin credential -> basic header (exactly like the plugin)
const file = path.join(os.homedir(), '.dsh', 'git-credentials.json');
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const arr = Array.isArray(raw) ? raw : (raw.credentials ?? []);
const e = arr.find(x => x.host === 'github.com');
const u = (!e.username || e.username.trim() === '') ? 'oauth2' : e.username;
const b = Buffer.from(u + ':' + e.secret, 'utf8').toString('base64');
const header = ['-c', 'http.https://github.com/.extraHeader=AUTHORIZATION: basic ' + b];

// what does ~/.git-credentials hold for github.com? (mask the password)
const gc = path.join(os.homedir(), '.git-credentials');
if (fs.existsSync(gc)) {
  const lines = fs.readFileSync(gc, 'utf8').split(/\r?\n/).filter(l => l.includes('github.com'));
  for (const l of lines) {
    const m = /^(https?:\/\/)([^:]+):([^@]+)@(.*)$/.exec(l);
    if (m) console.log('~/.git-credentials github line: ' + m[1] + m[2] + ':' + '*'.repeat(m[3].length) + '@' + m[4]);
    else console.log('~/.git-credentials github line (unparsed, masked): ' + l.replace(/:[^:@/]+@/, ':***@'));
  }
} else {
  console.log('~/.git-credentials: not present');
}

console.log('--- tests ---');
run('T1 plugin-style (helpers untouched)', [...header, 'ls-remote', url, 'HEAD']);
run('T2 extraHeader + helper-selector disabled', [...header, '-c', 'credential.helper=', 'ls-remote', url, 'HEAD']);
run('T3 extraHeader only (all helpers off)',
  [...header, '-c', 'credential.helper=', '-c', 'credential.https://github.com.helper=', 'ls-remote', url, 'HEAD']);
run('T4 store credential only (no extraHeader)',
  ['-c', 'credential.helper=', '-c', 'credential.https://github.com.helper=store', 'ls-remote', url, 'HEAD']);
run('T5 anonymous (public repo baseline)',
  ['-c', 'credential.helper=', '-c', 'credential.https://github.com.helper=', 'ls-remote', url, 'HEAD']);
