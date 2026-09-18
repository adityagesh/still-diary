import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareRelease } from '../scripts/prepare-release.mjs';

const directories: string[] = [];
const names = ['Still-Diary-0.1.0-Windows-x64.exe', 'Still-Diary-0.1.0-Linux-x64.AppImage', 'Still-Diary-0.1.0-Linux-x64.deb'];

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'still-release-test-'));
  directories.push(directory);
  for (const name of names) await writeFile(path.join(directory, name), `test binary ${name}`);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('release integrity', () => {
  it('requires all three platform assets and writes exact SHA-256 checksums', async () => {
    const directory = await fixture();
    expect(await prepareRelease(directory, '0.1.0', 'v0.1.0')).toEqual(names);
    const expected = names.map((name) => `${createHash('sha256').update(`test binary ${name}`).digest('hex')}  ${name}`).join('\n') + '\n';
    expect(await readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8')).toBe(expected);
  });
  it('rejects a mismatched or unsafe tag/version', async () => {
    const directory = await fixture();
    await expect(prepareRelease(directory, '0.1.0', 'v0.2.0')).rejects.toThrow('must match');
    await expect(prepareRelease(directory, '../0.1.0', 'v../0.1.0')).rejects.toThrow('must match');
  });
  it('rejects missing or empty platform downloads', async () => {
    const directory = await fixture();
    await writeFile(path.join(directory, names[1]), '');
    await expect(prepareRelease(directory, '0.1.0', 'v0.1.0')).rejects.toThrow('empty');
    await rm(path.join(directory, names[1]));
    await expect(prepareRelease(directory, '0.1.0', 'v0.1.0')).rejects.toThrow();
  });
  it('rejects unrelated files instead of publishing them', async () => {
    const directory = await fixture();
    await writeFile(path.join(directory, 'diary.json'), '{}');
    await expect(prepareRelease(directory, '0.1.0', 'v0.1.0')).rejects.toThrow('Unexpected release files');
  });
});
