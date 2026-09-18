import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export async function prepareRelease(directory, version, tag) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) || tag !== `v${version}`) {
    throw new Error('Release tag must match the version in package.json (for example, v0.1.0).');
  }
  const files = [
    `Still-Diary-${version}-Windows-x64.exe`,
    `Still-Diary-${version}-Linux-x64.AppImage`,
    `Still-Diary-${version}-Linux-x64.deb`,
  ];
  const unexpected = (await readdir(directory)).filter((name) => !files.includes(name) && name !== 'SHA256SUMS.txt');
  if (unexpected.length) throw new Error(`Unexpected release files: ${unexpected.join(', ')}`);
  const checksums = [];
  for (const filename of files) {
    const file = path.join(directory, filename);
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.size === 0) throw new Error(`Missing, empty or linked release asset: ${filename}`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    checksums.push(`${hash.digest('hex')}  ${filename}`);
  }
  await writeFile(path.join(directory, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [tag, directory] = process.argv.slice(2);
    if (!tag || !directory) throw new Error('Usage: node scripts/prepare-release.mjs <tag> <artifact-directory>');
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const files = await prepareRelease(directory, manifest.version, tag);
    const notes = `# Still Diary ${tag}

Open source. Your data stays with you. Encrypted before it leaves your device.

## Install
- **Windows 10/11 (x64):** download \`${files[0]}\` and open the portable app.
- **Ubuntu/Debian (x64):** download \`${files[2]}\` and install it with your package manager.
- **Linux portable (x64):** download \`${files[1]}\`, make it executable, and run it.
- Check your download against \`SHA256SUMS.txt\`. See the README for installation and troubleshooting.

This public repository contains the app only. Each user's diary belongs in a separate private GitHub repository.

The app includes local encryption, recovery keys, local autosave, optional GitHub/SSH sync, and Windows/Linux desktop builds.

**Important:** builds are currently unsigned. Do not bypass operating-system security warnings. Encryption has not undergone an independent audit. Save your emergency recovery key outside your diary repository: losing both it and your passphrase means the diary cannot be recovered.
`;
    await writeFile(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'still-release-notes.md'), notes);
    console.log(`Prepared ${tag}: ${files.length} verified assets and SHA256SUMS.txt.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
