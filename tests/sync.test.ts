import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitSync, isVaultPath, parseGitHubOrigin, runCommand, type CommandOptions, type CommandResult, type CommandRunner } from '../electron/sync';

const URL = 'git@github.com:diary-test/private-vault.git';
const DIARY_ID = 'c6c50d9f-6aeb-4bda-aa2f-ef6123c7083e';
const ENTRY_A = 'entries/2026/09/2026-09-18.entry';
const ENTRY_B = 'entries/2026/09/2026-09-19.entry';
const roots: string[] = [];

interface Call {
  executable: string;
  args: readonly string[];
  options: CommandOptions;
  command: string;
}

function gitCommand(args: readonly string[]): string {
  let index = 0;
  while (args[index] === '-c') index += 2;
  return args[index] ?? '';
}

function fake(stdout = '', code = 0, stderr = ''): CommandResult {
  return { stdout, code, stderr };
}

async function git(directory: string, ...args: string[]): Promise<string> {
  const result = await runCommand('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@localhost',
    '-c', 'commit.gpgSign=false', '-c', 'core.fsmonitor=false', '-c', 'safe.bareRepository=all',
    '-c', `core.hooksPath=${path.join(directory, 'unused-test-hooks')}`,
    ...args,
  ], { cwd: directory, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }, timeout: 15_000, maxBuffer: 1024 * 1024 });
  if (result.code !== 0) throw new Error(`Test git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function put(directory: string, file: string, contents: string): Promise<void> {
  const target = path.join(directory, ...file.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
}

async function windowsShortPath(directory: string): Promise<string> {
  const result = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$fs = New-Object -ComObject Scripting.FileSystemObject; $fs.GetFolder($env:STILL_DIARY_ALIAS_TEST).ShortPath'], {
    cwd: process.cwd(),
    env: { ...process.env, STILL_DIARY_ALIAS_TEST: directory },
    timeout: 5_000,
    maxBuffer: 16 * 1024,
  });
  if (result.code !== 0) throw new Error('Could not resolve Windows short path for the alias regression.');
  return result.stdout.trim();
}

async function fixture() {
  // Fixtures deliberately stay under the project, never in an OS temporary directory.
  const root = path.join(process.cwd(), `.sync-test-${randomUUID()}`);
  roots.push(root);
  const local = path.join(root, 'local diary');
  const remote = path.join(root, 'remote.git');
  const hooks = path.join(root, 'empty-hooks');
  await mkdir(local, { recursive: true });
  await git(root, 'init', '--bare', '--initial-branch=main', remote);
  await git(local, 'init', '--initial-branch=main');
  await git(local, 'remote', 'add', 'origin', URL);
  await put(local, 'diary.json', JSON.stringify({ version: 1, diaryId: DIARY_ID, encrypted: 'test-envelope' }));
  const calls: Call[] = [];
  let intercept: ((call: Call) => CommandResult | Promise<CommandResult> | undefined) | undefined;
  const runner: CommandRunner = async (executable, args, options) => {
    const command = executable === 'git' ? gitCommand(args) : /^ssh(?:\.exe)?$/i.test(path.basename(executable)) ? 'ssh' : executable;
    const call = { executable, args, options, command };
    calls.push(call);
    const intercepted = intercept?.(call);
    if (intercepted !== undefined) return intercepted;
    if (executable === 'gh') return fake('true\n');
    if (command === 'ssh') return fake('', 0, 'OpenSSH_test');
    if (executable !== 'git') throw new Error('Unexpected test executable');
    const network = ['ls-remote', 'fetch', 'push'].includes(command);
    if (network && !args.includes(URL)) throw new Error('Test blocked an unknown network destination');
    // Production policy stays intact; only this injected runner can substitute a local transport.
    const safeArgs = args.map((arg) => network && arg === URL ? remote : arg);
    return runCommand(executable, ['-c', 'protocol.file.allow=always', ...safeArgs], options);
  };
  const sync = new GitSync(local, hooks, runner);
  return {
    root, local, remote, hooks, calls, runner, sync,
    intercept(fn: typeof intercept) { intercept = fn; },
    async peer() {
      const peer = path.join(root, `peer-${randomUUID()}`);
      await git(root, 'clone', '--no-local', remote, peer);
      return peer;
    },
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('sync schema and URL policy', () => {
  it('accepts only exact GitHub SSH URL forms', () => {
    expect(parseGitHubOrigin(URL)).toBe('diary-test/private-vault');
    expect(parseGitHubOrigin('ssh://git@github.com/owner/repo.git')).toBe('owner/repo');
    for (const url of [
      'https://github.com/owner/repo.git', 'git@evil.test:owner/repo.git',
      'ssh://git@github.com:22/owner/repo.git', 'ssh://root@github.com/owner/repo.git',
      'git@github.com:owner/repo', 'git@github.com:owner/repo.git\n-oProxyCommand=bad',
      'git@github.com:owner/../repo.git', '-oProxyCommand=bad', 'git@github.com:owner/repo.git ',
    ]) expect(parseGitHubOrigin(url)).toBeNull();
  });

  it('allowlists real matching entry dates and UUID assets, not traversal or arbitrary files', () => {
    for (const file of ['diary.json', ENTRY_A, 'assets/aa43aa55-879b-4f74-a723-26c091a95ac9.asset']) expect(isVaultPath(file)).toBe(true);
    for (const file of ['../diary.json', 'entries/2026/09/2026-10-18.entry', 'entries/2026/02/2026-02-30.entry',
      'entries/2026/09/2026-09-18.entry.bak', 'assets/photo.png', '.gitattributes', '.gitignore', 'plain.txt',
      'assets/aa43aa55-879b-1f74-a723-26c091a95ac9.asset', 'assets/AA43AA55-879B-4F74-A723-26C091A95AC9.asset',
      'entries\\2026\\09\\2026-09-18.entry', 'assets/../../diary.json']) expect(isVaultPath(file)).toBe(false);
  });
});

describe('fail-closed repository inspection', () => {
  it('reports verified private repositories without running Git network operations', async () => {
    const f = await fixture();
    expect(await f.sync.inspect()).toMatchObject({ connected: true, repository: 'diary-test/private-vault', branch: 'main', isPrivate: true });
    expect(f.calls.some((call) => ['fetch', 'push', 'ls-remote'].includes(call.command))).toBe(false);
  });

  it.each(['false\n', '', 'null\n', 'true\nfalse\n'])('blocks unverified privacy response %j before any network or staging', async (privacy) => {
    const f = await fixture();
    f.intercept((call) => call.executable === 'gh' ? fake(privacy) : undefined);
    const status = await f.sync.sync();
    expect(status).toMatchObject({ phase: 'blocked', lastSyncedAt: null });
    expect(status.message).toMatch(/verify.*private/i);
    expect(f.calls.some((call) => ['fetch', 'push', 'ls-remote', 'add', 'commit'].includes(call.command))).toBe(false);
  });

  it.each(['gh', 'ssh', 'git'])('reports missing %s with actionable setup guidance', async (tool) => {
    const f = await fixture();
    f.intercept((call) => {
      if (call.executable === tool || tool === 'ssh' && call.command === 'ssh') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return undefined;
    });
    expect(await f.sync.inspect()).toMatchObject({ connected: false, isPrivate: false });
    const result = await f.sync.sync();
    expect(result.phase).toBe('blocked');
    expect(result.message).toMatch(/install/i);
    expect(f.calls.some((call) => ['fetch', 'push', 'ls-remote'].includes(call.command))).toBe(false);
  });

  it('blocks failed CLI authentication/network verification', async () => {
    const f = await fixture();
    f.intercept((call) => call.executable === 'gh' ? fake('', 1, 'not authenticated') : undefined);
    expect((await f.sync.sync()).phase).toBe('blocked');
    expect(f.calls.some((call) => ['fetch', 'push', 'ls-remote'].includes(call.command))).toBe(false);
  });

  it.each(['missing', 'https', 'pushurl', 'rewrite', 'merge-options', 'custom-transport'])('blocks unsafe origin configuration: %s', async (problem) => {
    const f = await fixture();
    if (problem === 'missing') await git(f.local, 'remote', 'remove', 'origin');
    if (problem === 'https') await git(f.local, 'remote', 'set-url', 'origin', 'https://github.com/diary-test/private-vault.git');
    if (problem === 'pushurl') await git(f.local, 'config', 'remote.origin.pushurl', 'git@github.com:elsewhere/other.git');
    if (problem === 'rewrite') await git(f.local, 'config', 'url.ssh://evil.test/.insteadOf', 'git@github.com:');
    if (problem === 'merge-options') await git(f.local, 'config', 'branch.main.mergeOptions', '-s unsafe');
    if (problem === 'custom-transport') await git(f.local, 'config', 'remote.origin.vcs', 'unsafe');
    expect((await f.sync.inspect()).connected).toBe(false);
    expect(f.calls.some((call) => ['fetch', 'push', 'ls-remote'].includes(call.command))).toBe(false);
  });

  it('rejects a folder inside a parent repository', async () => {
    const f = await fixture();
    const nested = path.join(f.local, 'nested');
    await mkdir(nested);
    const info = await new GitSync(nested, f.hooks, f.runner).inspect();
    expect(info.connected).toBe(false);
    expect(info.message).toMatch(/initialize or clone/i);
  });

  it.runIf(process.platform === 'win32')('accepts equivalent Windows 8.3 directory and hooks aliases', async ({ skip }) => {
    const f = await fixture();
    await mkdir(f.hooks);
    const alias = await windowsShortPath(f.local);
    const hooksAlias = await windowsShortPath(f.hooks);
    if (path.resolve(alias).toLowerCase() === path.resolve(f.local).toLowerCase()) return skip();
    expect(await realpath(alias)).toBe(await realpath(f.local));
    const sync = new GitSync(alias, hooksAlias, f.runner);
    expect(await sync.inspect()).toMatchObject({ connected: true, branch: 'main' });
    expect((await sync.sync()).phase).toBe('synced');
  });

  it.runIf(process.platform === 'win32')('reports an uninitialized 8.3-aliased directory as missing Git, not as a symlink', async ({ skip }) => {
    const f = await fixture();
    const directory = path.join(f.root, 'uninitialized diary');
    await mkdir(directory);
    const alias = await windowsShortPath(directory);
    if (path.resolve(alias).toLowerCase() === path.resolve(directory).toLowerCase()) return skip();
    const info = await new GitSync(alias, f.hooks, f.runner).inspect();
    expect(info.connected).toBe(false);
    expect(info.message).toMatch(/initialize or clone/i);
    expect(info.message).not.toMatch(/symlink/i);
  });

  it.runIf(process.platform === 'win32')('keeps hooks outside the diary even when the diary is selected through an 8.3 alias', async ({ skip }) => {
    const f = await fixture();
    const alias = await windowsShortPath(f.local);
    if (path.resolve(alias).toLowerCase() === path.resolve(f.local).toLowerCase()) return skip();
    const hooks = path.join(f.local, 'not-allowed-hooks');
    const info = await new GitSync(alias, hooks, f.runner).inspect();
    expect(info.message).toMatch(/must be outside the diary/i);
    expect(await readdir(f.local)).not.toContain('not-allowed-hooks');
  });
});

describe('local repository safety', () => {
  it.each([
    { version: 2, diaryId: DIARY_ID },
    { diaryId: DIARY_ID },
    { version: 1, diaryId: DIARY_ID.toUpperCase() },
    { version: 1, diaryId: 'c6c50d9f-6aeb-1bda-aa2f-ef6123c7083e' },
    { version: 1, diaryId: DIARY_ID, oversized: 'x'.repeat(16 * 1024) },
  ])('blocks invalid or oversized metadata before staging or Git networking', async (metadata) => {
    const f = await fixture();
    await put(f.local, 'diary.json', JSON.stringify(metadata));
    expect((await f.sync.sync()).phase).toBe('blocked');
    expect(f.calls.some((call) => ['add', 'commit', 'fetch', 'push', 'ls-remote'].includes(call.command))).toBe(false);
  });

  it.each(['plain.txt', '.gitattributes', '.gitignore', 'entries/2026/09/2026-09-18.entry.bak'])('does not stage unexpected file %s', async (file) => {
    const f = await fixture();
    await put(f.local, file, 'must not commit');
    expect((await f.sync.sync()).phase).toBe('blocked');
    expect(f.calls.some((call) => ['add', 'commit', 'fetch', 'push'].includes(call.command))).toBe(false);
  });

  it('rejects unexpected tracked files even if missing from the working tree', async () => {
    const f = await fixture();
    await put(f.local, 'private.txt', 'not encrypted');
    await git(f.local, 'add', '--', 'private.txt');
    await git(f.local, 'commit', '-m', 'unsafe fixture');
    await rm(path.join(f.local, 'private.txt'));
    expect((await f.sync.sync()).message).toMatch(/index contains unexpected/i);
  });

  it('does not commit even allowlisted preexisting staged changes', async () => {
    const f = await fixture();
    await git(f.local, 'add', '--', 'diary.json');
    expect((await f.sync.sync()).message).toMatch(/already staged/i);
    expect(f.calls.some((call) => ['commit', 'fetch', 'push'].includes(call.command))).toBe(false);
  });

  it.each(['MERGE_HEAD', 'rebase-merge', 'index.lock'])('guards an ongoing operation %s', async (marker) => {
    const f = await fixture();
    await put(f.local, `.git/${marker}`, 'operation-in-progress');
    expect((await f.sync.sync()).message).toMatch(/existing Git operation/i);
    expect(f.calls.some((call) => ['add', 'fetch', 'push'].includes(call.command))).toBe(false);
  });

  it('rejects info attributes that could invoke a configured filter', async () => {
    const f = await fixture();
    await put(f.local, '.git/info/attributes', '*.json filter=malicious');
    await git(f.local, 'config', 'filter.malicious.clean', 'a-command-that-must-never-run');
    expect((await f.sync.sync()).message).toMatch(/attributes/i);
    expect(f.calls.some((call) => call.command === 'add')).toBe(false);
  });

  it('rejects linked vault directories (including Windows junctions)', async () => {
    const f = await fixture();
    const outside = path.join(f.root, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(f.local, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await f.sync.sync()).message).toMatch(/symlink/i);
  });

  it('rejects selected directories reached through a linked ancestor', async () => {
    const f = await fixture();
    const selected = path.join(f.local, 'selected');
    await mkdir(selected);
    const link = path.join(f.root, 'linked-parent');
    await symlink(f.local, link, process.platform === 'win32' ? 'junction' : 'dir');
    const info = await new GitSync(path.join(link, 'selected'), f.hooks, f.runner).inspect();
    expect(info.connected).toBe(false);
    expect(info.message).toMatch(/symlink/i);
  });

  it('rejects hooks directories reached through a linked ancestor', async () => {
    const f = await fixture();
    const actual = path.join(f.root, 'actual-hooks-parent');
    await mkdir(actual);
    const link = path.join(f.root, 'linked-hooks-parent');
    await symlink(actual, link, process.platform === 'win32' ? 'junction' : 'dir');
    const info = await new GitSync(f.local, path.join(link, 'empty-hooks'), f.runner).inspect();
    expect(info.connected).toBe(false);
    expect(info.message).toMatch(/real, empty directory/i);
    expect(await readdir(actual)).toEqual([]);
  });

  it('rejects a nonempty hooks directory instead of deleting its contents', async () => {
    const f = await fixture();
    await put(f.hooks, 'pre-commit', 'not an app-owned empty directory');
    expect((await f.sync.sync()).message).toMatch(/empty directory/i);
    expect(await readFile(path.join(f.hooks, 'pre-commit'), 'utf8')).toContain('not an app');
  });

  it('rejects assume-unchanged files that could hide local edits', async () => {
    const f = await fixture();
    expect((await f.sync.sync()).phase).toBe('synced');
    await git(f.local, 'update-index', '--assume-unchanged', 'diary.json');
    expect((await f.sync.sync()).message).toMatch(/assume-unchanged/i);
  });

  it('overrides configured hooks and fsmonitor without executing them', async () => {
    const f = await fixture();
    await put(f.local, '.git/hooks/pre-commit', '#!/bin/sh\nexit 1\n');
    await git(f.local, 'config', 'core.fsmonitor', 'a-command-that-must-never-run');
    await git(f.local, 'config', 'core.sshCommand', 'a-command-that-must-never-run');
    expect((await f.sync.sync()).phase).toBe('synced');
  });
});

describe('local-only Git synchronization integration', () => {
  it('initializes an empty main remote, stages only explicit schema paths, and uses fixed identity and safe command options', async () => {
    const f = await fixture();
    await put(f.local, ENTRY_A, 'encrypted-entry-a');
    await put(f.local, 'assets/aa43aa55-879b-4f74-a723-26c091a95ac9.asset', 'encrypted-image');
    const result = await f.sync.sync();
    expect(result).toMatchObject({ phase: 'synced', repository: 'diary-test/private-vault' });
    expect(result.lastSyncedAt).toMatch(/^\d{4}-/);
    expect(await git(f.local, 'status', '--porcelain')).toBe('');
    expect(await git(f.local, 'log', '-1', '--format=%an <%ae>')).toBe('Still Diary <diary@localhost>');
    expect(await git(f.remote, 'rev-parse', 'refs/heads/main')).toBe(await git(f.local, 'rev-parse', 'HEAD'));
    expect(await readdir(f.hooks)).toEqual([]);
    for (const call of f.calls) {
      expect(call.options.timeout).toBeGreaterThan(0);
      expect(call.options.maxBuffer).toBeGreaterThan(0);
      expect(call.options.env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(call.options.env.GCM_INTERACTIVE).toBe('never');
      expect(call.options.env.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=yes');
      expect(call.options.env.GIT_SSH_COMMAND).toContain('BatchMode=yes');
      expect(call.options.env.GIT_SSH_COMMAND).toContain('-F none');
      if (call.executable === 'git') {
        expect(call.args).toContain('core.fsmonitor=false');
        expect(call.args).toContain(`core.hooksPath=${f.hooks}`);
      }
      if (call.command === 'add') {
        const paths = call.args.slice(call.args.indexOf('--') + 1);
        expect(paths.length).toBeGreaterThan(0);
        expect(paths.every(isVaultPath)).toBe(true);
        expect(call.args).not.toContain('-A');
        expect(call.args).not.toContain('.');
      }
    }
    const push = f.calls.find((call) => call.command === 'push')!;
    expect(push.args.slice(-2)).toEqual([URL, 'HEAD:refs/heads/main']);
    expect(push.args.some((arg) => arg.startsWith('--force'))).toBe(false);
    const networkIndex = f.calls.findIndex((call) => call.command === 'ls-remote');
    expect(f.calls.slice(0, networkIndex).some((call) => call.executable === 'gh')).toBe(true);
    expect(f.calls.filter((call) => call.executable === 'gh')).toHaveLength(2);
    const sshProbe = f.calls.find((call) => call.command === 'ssh')!;
    const gitPush = f.calls.find((call) => call.command === 'push')!;
    if (path.isAbsolute(sshProbe.executable)) {
      expect(gitPush.options.env.GIT_SSH_COMMAND).toBe(`'${sshProbe.executable.replace(/'/g, "'\\''")}' -F none -o BatchMode=yes -o StrictHostKeyChecking=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o ConnectTimeout=15 -o ConnectionAttempts=1`);
    } else {
      expect(gitPush.options.env.GIT_SSH_COMMAND).toMatch(/^ssh /);
    }
  });

  it('syncs a clean repository without additional commits and commits allowlisted deletions', async () => {
    const f = await fixture();
    await put(f.local, ENTRY_A, 'encrypted-entry');
    expect((await f.sync.sync()).phase).toBe('synced');
    const head = await git(f.local, 'rev-parse', 'HEAD');
    expect((await f.sync.sync()).phase).toBe('synced');
    expect(await git(f.local, 'rev-parse', 'HEAD')).toBe(head);
    await rm(path.join(f.local, ...ENTRY_A.split('/')));
    expect((await f.sync.sync()).phase).toBe('synced');
    expect(await git(f.remote, 'ls-tree', '-r', '--name-only', 'main')).toBe('diary.json');
  });

  it('fast-forwards a preexisting tracked branch without fetching unrelated branches', async () => {
    const f = await fixture();
    expect((await f.sync.sync()).phase).toBe('synced');
    const peer = await f.peer();
    await put(peer, ENTRY_A, 'remote-encrypted');
    await git(peer, 'add', '--', ENTRY_A);
    await git(peer, 'commit', '-m', 'remote update');
    await git(peer, 'push', 'origin', 'HEAD:refs/heads/main');
    const remoteHead = await git(peer, 'rev-parse', 'HEAD');
    expect((await f.sync.sync()).phase).toBe('synced');
    expect(await git(f.local, 'rev-parse', 'HEAD')).toBe(remoteHead);
    expect(await readFile(path.join(f.local, ...ENTRY_A.split('/')), 'utf8')).toBe('remote-encrypted');
    const fetch = f.calls.filter((call) => call.command === 'fetch').at(-1)!;
    expect(fetch.args.slice(-2)).toEqual([URL, 'refs/heads/main']);
    expect(fetch.args).toContain('--no-tags');
    expect(fetch.args).not.toContain('--all');
  });

  it('merges diverged nonoverlapping encrypted files and preserves both histories', async () => {
    const f = await fixture();
    expect((await f.sync.sync()).phase).toBe('synced');
    const peer = await f.peer();
    await put(peer, ENTRY_A, 'remote-encrypted');
    await git(peer, 'add', '--', ENTRY_A);
    await git(peer, 'commit', '-m', 'peer entry');
    await git(peer, 'push', 'origin', 'HEAD:refs/heads/main');
    await put(f.local, ENTRY_B, 'local-encrypted');
    expect((await f.sync.sync()).phase).toBe('synced');
    expect((await git(f.local, 'rev-list', '--parents', '-n', '1', 'HEAD')).split(' ')).toHaveLength(3);
    expect(await readFile(path.join(f.local, ...ENTRY_A.split('/')), 'utf8')).toBe('remote-encrypted');
    expect(await readFile(path.join(f.local, ...ENTRY_B.split('/')), 'utf8')).toBe('local-encrypted');
  });

  it('blocks same-file conflicts before merge, preserving local committed edits and fetched remote version', async () => {
    const f = await fixture();
    await put(f.local, ENTRY_A, 'base-encrypted');
    const first = await f.sync.sync();
    expect(first.phase).toBe('synced');
    const peer = await f.peer();
    await put(peer, ENTRY_A, 'remote-encrypted');
    await git(peer, 'add', '--', ENTRY_A);
    await git(peer, 'commit', '-m', 'peer edit');
    await git(peer, 'push', 'origin', 'HEAD:refs/heads/main');
    const remoteHead = await git(f.remote, 'rev-parse', 'main');
    await put(f.local, ENTRY_A, 'local-encrypted');
    const result = await f.sync.sync();
    expect(result).toMatchObject({ phase: 'blocked', lastSyncedAt: first.lastSyncedAt });
    expect(result.message).toMatch(/preserve both versions.*manual resolution/i);
    expect(await readFile(path.join(f.local, ...ENTRY_A.split('/')), 'utf8')).toBe('local-encrypted');
    expect(await git(f.local, 'show', `HEAD:${ENTRY_A}`)).toBe('local-encrypted');
    expect(await git(f.local, 'show', `FETCH_HEAD:${ENTRY_A}`)).toBe('remote-encrypted');
    expect(await git(f.local, 'status', '--porcelain')).toBe('');
    expect(await git(f.remote, 'rev-parse', 'main')).toBe(remoteHead);
    expect(f.calls.some((call) => call.command === 'merge' && call.args.includes('--abort'))).toBe(false);
    expect(f.calls.some((call) => call.command === 'reset')).toBe(false);
  });

  it.each(['different-id', 'unsupported-version', 'oversized-metadata', 'unexpected-file', 'symlink'])('rejects unsafe remote tree %s before merge or push', async (problem) => {
    const f = await fixture();
    expect((await f.sync.sync()).phase).toBe('synced');
    const localHead = await git(f.local, 'rev-parse', 'HEAD');
    const peer = await f.peer();
    if (problem === 'different-id') {
      await put(peer, 'diary.json', JSON.stringify({ version: 1, diaryId: randomUUID() }));
      await git(peer, 'add', '--', 'diary.json');
    } else if (problem === 'unsupported-version' || problem === 'oversized-metadata') {
      await put(peer, 'diary.json', JSON.stringify({
        version: problem === 'unsupported-version' ? 2 : 1,
        diaryId: DIARY_ID,
        padding: problem === 'oversized-metadata' ? 'x'.repeat(16 * 1024) : '',
      }));
      await git(peer, 'add', '--', 'diary.json');
    } else if (problem === 'unexpected-file') {
      await put(peer, '.gitattributes', '*.entry filter=evil');
      await git(peer, 'add', '--', '.gitattributes');
    } else {
      const blob = await git(peer, 'hash-object', '-w', 'diary.json');
      await git(peer, 'update-index', '--add', '--cacheinfo', `120000,${blob},${ENTRY_A}`);
    }
    await git(peer, 'commit', '-m', 'unsafe remote');
    await git(peer, 'push', 'origin', 'HEAD:refs/heads/main');
    const from = f.calls.length;
    expect((await f.sync.sync()).phase).toBe('blocked');
    expect(await git(f.local, 'rev-parse', 'HEAD')).toBe(localHead);
    expect(f.calls.slice(from).some((call) => ['merge', 'push'].includes(call.command))).toBe(false);
  });

  it('aborts an actual merge conflict if it still occurs after preflight', async () => {
    const f = await fixture();
    await put(f.local, ENTRY_A, 'base-encrypted');
    expect((await f.sync.sync()).phase).toBe('synced');
    const peer = await f.peer();
    await put(peer, ENTRY_A, 'remote-encrypted');
    await git(peer, 'add', '--', ENTRY_A);
    await git(peer, 'commit', '-m', 'peer change');
    await git(peer, 'push', 'origin', 'HEAD:refs/heads/main');
    await put(f.local, ENTRY_A, 'local-encrypted');
    f.intercept((call) => call.command === 'diff' && call.args.at(-1) === '--' ? fake() : undefined);
    const result = await f.sync.sync();
    expect(result.phase).toBe('blocked');
    expect(result.message).toMatch(/manual resolution/i);
    expect(f.calls.some((call) => call.command === 'merge' && call.args.includes('--abort'))).toBe(true);
    expect(await readFile(path.join(f.local, ...ENTRY_A.split('/')), 'utf8')).toBe('local-encrypted');
    expect(await git(f.local, 'show', `FETCH_HEAD:${ENTRY_A}`)).toBe('remote-encrypted');
    expect(await git(f.local, 'status', '--porcelain')).toBe('');
  });

  it('blocks disjoint line edits to one encrypted file rather than creating invalid combined ciphertext', async () => {
    const f = await fixture();
    await put(f.local, ENTRY_A, 'one\ntwo\nthree\nfour\nfive\n');
    expect((await f.sync.sync()).phase).toBe('synced');
    const peer = await f.peer();
    await put(peer, ENTRY_A, 'remote\ntwo\nthree\nfour\nfive\n');
    await git(peer, 'add', '--', ENTRY_A);
    await git(peer, 'commit', '-m', 'remote line');
    await git(peer, 'push', 'origin', 'HEAD:refs/heads/main');
    await put(f.local, ENTRY_A, 'one\ntwo\nthree\nfour\nlocal\n');
    const from = f.calls.length;
    expect((await f.sync.sync()).phase).toBe('blocked');
    expect(f.calls.slice(from).some((call) => call.command === 'merge')).toBe(false);
    expect(await readFile(path.join(f.local, ...ENTRY_A.split('/')), 'utf8')).toBe('one\ntwo\nthree\nfour\nlocal\n');
  });

  it('reverifies privacy immediately before push and preserves a local commit if privacy changes', async () => {
    const f = await fixture();
    let verifications = 0;
    f.intercept((call) => call.executable === 'gh' ? fake(++verifications === 1 ? 'true' : 'false') : undefined);
    expect((await f.sync.sync()).phase).toBe('blocked');
    expect(await git(f.local, 'rev-parse', '--verify', 'HEAD')).toMatch(/^[0-9a-f]{40}$/);
    expect(f.calls.some((call) => call.command === 'push')).toBe(false);
  });

  it.each(['ls-remote', 'fetch', 'push'])('preserves commits and prior sync time when %s times out', async (command) => {
    const f = await fixture();
    const first = await f.sync.sync();
    expect(first.phase).toBe('synced');
    await put(f.local, ENTRY_A, 'pending-encrypted');
    f.intercept((call) => {
      if (call.command === command) throw Object.assign(new Error('timed out'), { killed: true });
      return undefined;
    });
    const result = await f.sync.sync();
    expect(result).toMatchObject({ phase: 'offline', lastSyncedAt: first.lastSyncedAt });
    expect(result.message).toMatch(/timed out/);
    expect(await git(f.local, 'show', `HEAD:${ENTRY_A}`)).toBe('pending-encrypted');
  });

  it('never claims synced after a rejected push', async () => {
    const f = await fixture();
    f.intercept((call) => call.command === 'push' ? fake('', 1, '[rejected] non-fast-forward') : undefined);
    expect(await f.sync.sync()).toMatchObject({ phase: 'offline', lastSyncedAt: null });
    expect(await git(f.local, 'rev-parse', '--verify', 'HEAD')).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('bounded shell-free command runner', () => {
  it('passes shell metacharacters as one literal argument', async () => {
    const argument = 'value with spaces & echo MUST_NOT_RUN ; $(anything)';
    const result = await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', argument], {
      cwd: process.cwd(), env: process.env, timeout: 5_000, maxBuffer: 4096,
    });
    expect(result.stdout).toBe(argument);
    expect(result.code).toBe(0);
  });

  it('rejects killed processes and buffer overflow rather than treating them as success', async () => {
    const options = { cwd: process.cwd(), env: process.env, timeout: 100, maxBuffer: 1024 };
    await expect(runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], options)).rejects.toThrow();
    await expect(runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], { ...options, timeout: 5_000 })).rejects.toThrow();
  });
});
