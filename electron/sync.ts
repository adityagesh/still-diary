import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { RepositoryInfo, SyncStatus } from '../shared/types';
import { FORMAT_VERSION, UUID_PATTERN } from './crypto';

export interface CommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Injection is for local-only tests; production always uses execFile without a shell. */
export type CommandRunner = (
  executable: string,
  args: readonly string[],
  options: CommandOptions,
) => Promise<CommandResult>;

export const runCommand: CommandRunner = (executable, args, options) =>
  new Promise((resolve, reject) => {
    execFile(executable, [...args], { ...options, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error && (typeof error.code !== 'number' || error.killed)) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr, code: error && typeof error.code === 'number' ? error.code : 0 });
    });
  });

const SSH_OPTIONS = '-F none -o BatchMode=yes -o StrictHostKeyChecking=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o ConnectTimeout=15 -o ConnectionAttempts=1';
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024;
const ASSET_PATH = /^assets\/([^/]+)\.asset$/;
const ORIGIN = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]+)\.git$/;

export function parseGitHubOrigin(url: string): string | null {
  const match = ORIGIN.exec(url);
  if (!match || match[2] === '.' || match[2] === '..' || match[2].startsWith('-')) return null;
  return `${match[1]}/${match[2]}`;
}

export function isVaultPath(file: string): boolean {
  if (file === 'diary.json') return true;
  const asset = ASSET_PATH.exec(file);
  if (asset) return UUID_PATTERN.test(asset[1]);
  const match = /^entries\/(\d{4})\/(0[1-9]|1[0-2])\/(\d{4})-(\d{2})-(\d{2})\.entry$/.exec(file);
  if (!match || match[1] !== match[3] || match[2] !== match[4]) return false;
  const date = `${match[3]}-${match[4]}-${match[5]}`;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

class SyncFailure extends Error {
  constructor(readonly phase: 'blocked' | 'offline' | 'error', message: string) {
    super(message);
  }
}

interface Context {
  url: string;
  repository: string;
  branch: string;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function errorDescription(error: unknown): string {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'the required command is not installed or is not on PATH';
  if (error instanceof Error && ('killed' in error && error.killed || /timed? ?out/i.test(error.message))) return 'the command timed out';
  return 'the command could not complete';
}

export class GitSync {
  private directory: string;
  private hooksDirectory: string;
  private readonly selectedDirectory: string;
  private readonly selectedHooksDirectory: string;
  private lastSyncedAt: string | null = null;
  private repository: string | null = null;
  private sshExecutable = 'ssh';
  private sshCommand = `ssh ${SSH_OPTIONS}`;

  constructor(directory: string, hooksDirectory: string, private readonly runner: CommandRunner = runCommand) {
    this.directory = this.selectedDirectory = path.resolve(directory);
    this.hooksDirectory = this.selectedHooksDirectory = path.resolve(hooksDirectory);
  }

  private environment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!/^(GIT_|GCM_|SSH_ASKPASS|SSH_ASKPASS_REQUIRE)/i.test(key)) env[key] = value;
    }
    return {
      ...env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_SSH_COMMAND: this.sshCommand,
      GIT_SSH_VARIANT: 'ssh',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_NO_LAZY_FETCH: '1',
      GIT_PROTOCOL_FROM_USER: '0',
      GIT_MERGE_AUTOEDIT: 'no',
      GH_HOST: 'github.com',
      GH_PROMPT_DISABLED: '1',
      GH_PAGER: 'cat',
      LC_ALL: 'C',
    };
  }

  private async command(executable: string, args: readonly string[]): Promise<CommandResult> {
    return this.runner(executable, args, {
      cwd: this.directory,
      env: this.environment(),
      timeout: executable === 'git' ? 60_000 : 30_000,
      maxBuffer: MAX_BUFFER,
    });
  }

  private async git(args: readonly string[], accepted: readonly number[] = [0]): Promise<CommandResult> {
    const config = [
      `core.hooksPath=${this.hooksDirectory}`,
      'core.fsmonitor=false', 'core.attributesFile=', 'core.autocrlf=false',
      `core.sshCommand=${this.sshCommand}`, 'core.askPass=', 'core.pager=cat',
      'user.name=Still Diary', 'user.email=diary@localhost',
      'commit.gpgSign=false', 'merge.gpgSign=false', 'merge.verifySignatures=false',
      'merge.autoStash=false', 'merge.renames=false', 'diff.renames=false',
      'submodule.recurse=false', 'fetch.recurseSubmodules=false',
      'push.recurseSubmodules=no', 'push.followTags=false', 'push.gpgSign=false',
      'push.negotiate=false', 'fetch.writeCommitGraph=false',
      'gc.auto=0', 'maintenance.auto=false', 'protocol.allow=never', 'protocol.ssh.allow=always',
    ];
    const result = await this.command('git', [...config.flatMap((value) => ['-c', value]), ...args]);
    if (!accepted.includes(result.code)) throw new Error(`Git ${args[0]} failed (exit ${result.code}).`);
    return result;
  }

  private async exists(file: string): Promise<boolean> {
    try {
      await lstat(file);
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  }

  private async canonicalDirectory(directory: string, message: string, allowMissing = false): Promise<string> {
    let existing = directory;
    const missing: string[] = [];
    if (allowMissing) {
      while (!(await this.exists(existing))) {
        missing.unshift(path.basename(existing));
        const parent = path.dirname(existing);
        if (parent === existing) throw new SyncFailure('blocked', message);
        existing = parent;
      }
    }
    // realpath also expands legitimate Windows 8.3 names; inspect ancestors to distinguish links.
    for (let current = existing; ; current = path.dirname(current)) {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SyncFailure('blocked', message);
      if (path.dirname(current) === current) break;
    }
    return path.join(await realpath(existing), ...missing);
  }

  private async prepare(): Promise<void> {
    this.directory = await this.canonicalDirectory(this.selectedDirectory, 'Choose the real diary directory, not a symlink.');
    this.hooksDirectory = await this.canonicalDirectory(this.selectedHooksDirectory, 'The app-owned Git hooks directory must be a real, empty directory.', true);
    const relativeHooks = path.relative(this.directory, this.hooksDirectory);
    if (!relativeHooks || (!relativeHooks.startsWith(`..${path.sep}`) && relativeHooks !== '..' && !path.isAbsolute(relativeHooks))) {
      throw new SyncFailure('blocked', 'The empty app-owned Git hooks directory must be outside the diary.');
    }
    await mkdir(this.hooksDirectory, { recursive: true, mode: 0o700 });
    const hooks = await lstat(this.hooksDirectory);
    if (!hooks.isDirectory() || hooks.isSymbolicLink() || !samePath(await realpath(this.hooksDirectory), this.hooksDirectory) ||
      (await readdir(this.hooksDirectory)).length !== 0) {
      throw new SyncFailure('blocked', 'The app-owned Git hooks directory must be a real, empty directory.');
    }
    const dotGit = path.join(this.directory, '.git');
    if (!(await this.exists(dotGit))) throw new SyncFailure('blocked', 'Initialize or clone a private GitHub repository inside this diary directory first.');
    const gitStat = await lstat(dotGit);
    if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) {
      throw new SyncFailure('blocked', 'Use a normal repository with its own .git directory; linked worktrees and symlinked repositories are not supported.');
    }
    // Git for Windows may prepend its bundled SSH to PATH, which cannot use the Windows SSH agent.
    const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (process.platform === 'win32' && windowsRoot && path.isAbsolute(windowsRoot)) {
      const systemSsh = path.join(windowsRoot, 'System32', 'OpenSSH', 'ssh.exe');
      if (await this.exists(systemSsh) && (await lstat(systemSsh)).isFile()) {
        this.sshExecutable = systemSsh;
        this.sshCommand = `'${systemSsh.replace(/'/g, "'\\''")}' ${SSH_OPTIONS}`;
      }
    }
  }

  private async context(): Promise<Context> {
    await this.prepare();
    let root: CommandResult;
    try {
      root = await this.git(['rev-parse', '--show-toplevel']);
    } catch (error) {
      throw new SyncFailure('blocked', `Git is unavailable or this is not a working repository (${errorDescription(error)}). Install Git, then initialize or clone the diary repository.`);
    }
    if (!samePath(root.stdout.trim(), this.directory)) {
      throw new SyncFailure('blocked', 'The diary directory must be the repository root, not a folder inside a parent repository.');
    }
    const gitDirectory = await this.git(['rev-parse', '--absolute-git-dir']);
    if (!samePath(gitDirectory.stdout.trim(), path.join(this.directory, '.git'))) {
      throw new SyncFailure('blocked', 'The diary must have its own .git directory.');
    }
    const rewrites = await this.git(['config', '--name-only', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$'], [0, 1]);
    if (rewrites.stdout.trim()) throw new SyncFailure('blocked', 'Remove Git URL rewrite rules from this repository before syncing.');
    const customCommands = await this.git(['config', '--name-only', '--get-regexp', '^(core\\.alternaterefscommand|branch\\..*\\.mergeoptions|remote\\..*\\.(vcs|uploadpack|receivepack))$'], [0, 1]);
    if (customCommands.stdout.trim()) throw new SyncFailure('blocked', 'Remove custom remote commands and branch merge options from this repository before syncing.');
    const raw = await this.git(['config', '--get-all', 'remote.origin.url'], [0, 1]);
    const urls = raw.stdout.trim().split(/\r?\n/);
    const repository = urls.length === 1 ? parseGitHubOrigin(urls[0]) : null;
    if (!repository) {
      this.repository = null;
      throw new SyncFailure('blocked', 'Set one origin using git@github.com:OWNER/REPO.git or ssh://git@github.com/OWNER/REPO.git. HTTPS, ports, options, and other hosts are not supported.');
    }
    this.repository = repository;
    const fetch = await this.git(['remote', 'get-url', '--all', 'origin']);
    const push = await this.git(['remote', 'get-url', '--push', '--all', 'origin']);
    if (fetch.stdout.trim() !== urls[0] || push.stdout.trim() !== urls[0]) {
      throw new SyncFailure('blocked', 'Origin fetch and push URLs must be identical; remove extra push URLs or URL rewrites.');
    }
    const branchResult = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1]);
    const branch = branchResult.stdout.trim();
    if (branchResult.code !== 0 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
      (await this.git(['check-ref-format', `refs/heads/${branch}`], [0, 1])).code !== 0) {
      throw new SyncFailure('blocked', 'Check out a named branch with a safe Git ref name (for example main) before syncing.');
    }
    try {
      const ssh = await this.command(this.sshExecutable, ['-V']);
      if (ssh.code !== 0) throw new Error('SSH unavailable');
    } catch (error) {
      throw new SyncFailure('blocked', `OpenSSH is unavailable (${errorDescription(error)}). Install OpenSSH and manually configure your GitHub SSH key and known_hosts first.`);
    }
    return { url: urls[0], repository, branch };
  }

  private async verifyPrivate(repository: string): Promise<void> {
    try {
      const result = await this.command('gh', ['api', '--hostname', 'github.com', `repos/${repository}`, '--jq', '.private']);
      if (result.code !== 0 || result.stdout.trim() !== 'true') throw new Error('Privacy not verified');
    } catch (error) {
      throw new SyncFailure('blocked', `Cannot verify that ${repository} is private (${errorDescription(error)}). Install GitHub CLI, sign in manually, check connectivity, and ensure the repository is private. No Git network operation is permitted without verification.`);
    }
  }

  async inspect(): Promise<RepositoryInfo> {
    let context: Context | undefined;
    try {
      context = await this.context();
      await this.verifyPrivate(context.repository);
      return { connected: true, repository: context.repository, branch: context.branch, isPrivate: true, message: 'Private GitHub repository verified. SSH must already be configured with a trusted GitHub host key.' };
    } catch (error) {
      return {
        connected: false, repository: this.repository, branch: context?.branch ?? null, isPrivate: false,
        message: error instanceof SyncFailure ? error.message : `Repository inspection failed (${errorDescription(error)}). Check the selected folder and repository permissions.`,
      };
    }
  }

  private async checkOperation(): Promise<void> {
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer', 'BISECT_LOG', 'index.lock', 'shallow', 'info/grafts', 'objects/info/alternates', 'objects/info/http-alternates']) {
      if (await this.exists(path.join(this.directory, '.git', name))) {
        throw new SyncFailure('blocked', `Finish the existing Git operation or remove its cause before syncing (.git/${name}). Shallow repositories, grafts, and alternate object stores are not supported.`);
      }
    }
    const attributes = path.join(this.directory, '.git', 'info', 'attributes');
    if (await this.exists(attributes)) {
      const stat = await lstat(attributes);
      if (!stat.isFile() || stat.isSymbolicLink() || (await readFile(attributes, 'utf8')).trim()) {
        throw new SyncFailure('blocked', 'Remove .git/info/attributes before syncing; custom attributes and filters are not allowed.');
      }
    }
  }

  private async workingFiles(): Promise<string[]> {
    const files: string[] = [];
    const visit = async (directory: string, prefix: string): Promise<void> => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        if (!prefix && item.name === '.git') continue;
        const name = prefix ? `${prefix}/${item.name}` : item.name;
        const fullPath = path.join(directory, item.name);
        const stat = await lstat(fullPath);
        if (stat.isSymbolicLink()) throw new SyncFailure('blocked', 'Symlinks are not allowed in a diary repository. Remove the linked vault path before syncing.');
        if (stat.isDirectory()) {
          if (!/^(?:assets|entries(?:\/\d{4}(?:\/(?:0[1-9]|1[0-2]))?)?)$/.test(name)) {
            throw new SyncFailure('blocked', 'Unexpected directory in the diary. Keep only diary.json, entries/YYYY/MM/YYYY-MM-DD.entry, and assets/<uuid>.asset.');
          }
          await visit(fullPath, name);
        } else if (stat.isFile() && isVaultPath(name)) files.push(name);
        else throw new SyncFailure('blocked', 'Unexpected file in the diary. Move non-vault files (including .gitignore and .gitattributes) outside this dedicated repository.');
      }
    };
    await visit(this.directory, '');
    if (!files.includes('diary.json')) throw new SyncFailure('blocked', 'diary.json is missing. Open or create the encrypted diary before syncing.');
    return files;
  }

  private async indexFiles(): Promise<string[]> {
    const result = await this.git(['ls-files', '--stage', '-z']);
    const files: string[] = [];
    for (const record of result.stdout.split('\0').filter(Boolean)) {
      const match = /^(100644|100755) [0-9a-f]+ 0\t(.+)$/.exec(record);
      if (!match || !isVaultPath(match[2])) {
        throw new SyncFailure('blocked', 'The Git index contains unexpected files, symlinks, submodules, or unresolved conflicts. Only encrypted vault schema paths may be tracked.');
      }
      files.push(match[2]);
    }
    const flags = await this.git(['ls-files', '-v', '-z']);
    if (flags.stdout.split('\0').filter(Boolean).some((record) => !record.startsWith('H '))) {
      throw new SyncFailure('blocked', 'Remove skip-worktree/assume-unchanged index flags and sparse checkout before syncing.');
    }
    return files;
  }

  private diaryId(contents: string): string {
    try {
      const metadata: unknown = JSON.parse(contents);
      if (metadata && typeof metadata === 'object' && 'version' in metadata && metadata.version === FORMAT_VERSION &&
        'diaryId' in metadata && typeof metadata.diaryId === 'string' && UUID_PATTERN.test(metadata.diaryId)) return metadata.diaryId;
    } catch { /* A malformed envelope must never be merged into an open vault. */ }
    throw new SyncFailure('blocked', 'diary.json requires version 1 and a lowercase UUIDv4 diaryId. Restore valid encrypted diary metadata before syncing.');
  }

  private async localDiaryId(): Promise<string> {
    const file = path.join(this.directory, 'diary.json');
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_METADATA_BYTES) throw new SyncFailure('blocked', 'diary.json must be a regular metadata file no larger than 16 KiB.');
    return this.diaryId(await readFile(file, 'utf8'));
  }

  private async commitPending(files: string[]): Promise<void> {
    const staged = await this.git(['diff', '--cached', '--name-only', '--no-ext-diff', '--no-textconv', '-z']);
    if (staged.stdout) throw new SyncFailure('blocked', 'There are already staged changes. Commit or unstage them manually before syncing; the app will not include an unexpected index.');
    const paths = [...new Set(files)];
    for (let start = 0; start < paths.length; start += 100) {
      await this.git(['add', '--force', '--', ...paths.slice(start, start + 100)]);
    }
    const changed = await this.git(['diff', '--cached', '--quiet', '--no-ext-diff', '--no-textconv', '--exit-code'], [0, 1]);
    if (changed.code === 1) await this.git(['commit', '--no-verify', '--no-gpg-sign', '-m', 'Update encrypted diary']);
    await this.assertClean();
  }

  private async assertClean(): Promise<void> {
    const status = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (status.stdout) throw new SyncFailure('blocked', 'The working tree changed during sync. Local changes are preserved; finish the changes and try again.');
  }

  private async network(args: readonly string[]): Promise<CommandResult> {
    try {
      return await this.git(args);
    } catch (error) {
      throw new SyncFailure('offline', `Git ${args[0]} did not complete (${errorDescription(error)}). Local commits are preserved. Check connectivity, GitHub SSH access, and trusted host keys, then try again. If the remote branch changed, fetch and resolve it manually.`);
    }
  }

  private async remoteCommit(context: Context): Promise<string | null> {
    let listing: CommandResult;
    try {
      listing = await this.git(['ls-remote', '--exit-code', '--heads', '--upload-pack=git-upload-pack', context.url, `refs/heads/${context.branch}`], [0, 2]);
    } catch (error) {
      throw new SyncFailure('offline', `Cannot read the remote branch (${errorDescription(error)}). Local commits are preserved. Check connectivity and manually configure GitHub SSH access and trusted host keys.`);
    }
    if (listing.code === 2 && !listing.stdout.trim()) return null;
    const ref = listing.stdout.trim().split('\t');
    if (ref.length !== 2 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(ref[0]) || ref[1] !== `refs/heads/${context.branch}`) {
      throw new SyncFailure('blocked', 'The remote returned an unexpected branch ref. Resolve the repository configuration manually.');
    }
    await this.network(['fetch', '--no-tags', '--no-recurse-submodules', '--no-auto-maintenance', '--upload-pack=git-upload-pack', '--refmap=', context.url, `refs/heads/${context.branch}`]);
    const fetched = (await this.git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).stdout.trim();
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(fetched)) throw new SyncFailure('blocked', 'The fetched branch has an invalid commit ID.');
    return fetched;
  }

  private async validateRemote(commit: string, diaryId: string): Promise<void> {
    const tree = await this.git(['ls-tree', '-r', '-z', '--full-tree', commit]);
    let hasMetadata = false;
    for (const record of tree.stdout.split('\0').filter(Boolean)) {
      const match = /^(100644|100755) blob [0-9a-f]+\t(.+)$/.exec(record);
      if (!match || !isVaultPath(match[2])) throw new SyncFailure('blocked', 'The remote contains unexpected files, symlinks, or submodules. No merge or push was performed; only encrypted vault schema paths are allowed.');
      if (match[2] === 'diary.json') hasMetadata = true;
    }
    if (!hasMetadata) throw new SyncFailure('blocked', 'The remote branch is not an encrypted diary (diary.json is missing). No merge or push was performed.');
    const metadata = await this.git(['show', `${commit}:diary.json`]);
    if (Buffer.byteLength(metadata.stdout, 'utf8') > MAX_METADATA_BYTES) throw new SyncFailure('blocked', 'Remote diary.json exceeds the 16 KiB metadata size limit. No merge or push was performed.');
    if (this.diaryId(metadata.stdout) !== diaryId) {
      throw new SyncFailure('blocked', 'The remote belongs to a different diaryId. No merge or push was performed. Choose the matching private repository; both diaries are preserved.');
    }
  }

  private async mergeRemote(commit: string, diaryId: string): Promise<void> {
    try {
      // Ciphertext is indivisible: even a textual "clean merge" of two edits can corrupt an envelope.
      const base = await this.git(['merge-base', 'HEAD', commit], [0, 1]);
      if (base.code === 0) {
        const ancestor = base.stdout.trim();
        if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(ancestor)) throw new Error('Invalid merge base');
        const local = await this.git(['diff', '--name-only', '--no-ext-diff', '--no-textconv', '-z', ancestor, 'HEAD', '--']);
        const remote = await this.git(['diff', '--name-only', '--no-ext-diff', '--no-textconv', '-z', ancestor, commit, '--']);
        const changedLocally = new Set(local.stdout.split('\0').filter(Boolean));
        if (remote.stdout.split('\0').filter(Boolean).some((file) => changedLocally.has(file))) {
          throw new Error('Concurrent edits to the same encrypted envelope need manual resolution');
        }
      }
      await this.git(['merge', '--no-commit', '--no-edit', '--no-stat', '--no-autostash', '--no-gpg-sign', '--no-verify-signatures', '--no-overwrite-ignore', commit]);
      await this.workingFiles();
      await this.indexFiles();
      if (await this.localDiaryId() !== diaryId) throw new Error('Merged diary identity changed');
      if (await this.exists(path.join(this.directory, '.git', 'MERGE_HEAD'))) {
        await this.git(['commit', '--no-verify', '--no-gpg-sign', '-m', 'Merge encrypted diary updates']);
      }
      await this.assertClean();
    } catch {
      if (await this.exists(path.join(this.directory, '.git', 'MERGE_HEAD'))) {
        try {
          await this.git(['merge', '--abort']);
        } catch {
          throw new SyncFailure('blocked', `The merge needs manual recovery; automatic abort could not complete. Both versions are preserved in local commits and fetched commit ${commit}. Do not discard either version. Resolve or abort the merge manually.`);
        }
      }
      throw new SyncFailure('blocked', `The histories conflict or cannot be merged safely. The merge was not completed; local committed edits and fetched remote commit ${commit} (FETCH_HEAD) preserve both versions. Manual resolution is required before syncing again.`);
    }
  }

  async sync(): Promise<SyncStatus> {
    try {
      const context = await this.context();
      await this.checkOperation();
      const files = await this.workingFiles();
      const tracked = await this.indexFiles();
      const diaryId = await this.localDiaryId();
      await this.verifyPrivate(context.repository);
      await this.commitPending([...files, ...tracked]);
      const remote = await this.remoteCommit(context);
      if (remote) {
        await this.validateRemote(remote, diaryId);
        await this.mergeRemote(remote, diaryId);
      }
      await this.assertClean();
      const currentBranch = (await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
      if (currentBranch !== context.branch) throw new SyncFailure('blocked', 'The selected branch changed during sync. Nothing was pushed; try again after finishing manual Git operations.');
      await this.verifyPrivate(context.repository);
      await this.network(['push', '--porcelain', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', '--receive-pack=git-receive-pack', context.url, `HEAD:refs/heads/${context.branch}`]);
      this.lastSyncedAt = new Date().toISOString();
      return { phase: 'synced', repository: context.repository, lastSyncedAt: this.lastSyncedAt, message: 'Encrypted diary synced to the verified private GitHub repository.' };
    } catch (error) {
      return {
        phase: error instanceof SyncFailure ? error.phase : 'error',
        repository: this.repository,
        lastSyncedAt: this.lastSyncedAt,
        message: error instanceof SyncFailure ? error.message : `Sync stopped (${errorDescription(error)}). Local files and commits are preserved; check Git and folder permissions before retrying.`,
      };
    }
  }
}
