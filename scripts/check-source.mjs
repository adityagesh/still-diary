import { execFileSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbidden = files.filter((file) =>
  /(?:^|\/)diary\.json$|\.(?:entry|asset|pem|key|p12|pfx)$/i.test(file)
  || /^(?:entries|assets|release|node_modules|dist|dist-electron)\//.test(file)
  || (/(?:^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith('.env.example')),
);

if (forbidden.length) {
  console.error(`Do not publish private data or build output in the app source repository:\n${forbidden.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} tracked paths: no diary schema, key files, environment secrets or build output.`);
}
