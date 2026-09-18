import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { VaultStore } from './vault';
import { GitSync } from './sync';
import type { BootState, DiarySession, HelpTopic, Result, RichDocument, Settings, SyncStatus } from '../shared/types';

protocol.registerSchemesAsPrivileged([
  { scheme: 'diary-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

if (!app.isPackaged && process.env.STILL_E2E === '1' && process.env.STILL_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.STILL_USER_DATA));
}

const isDev = !app.isPackaged && process.env.ELECTRON_DEV === '1';
const appUrl = isDev ? 'http://127.0.0.1:5173/' : pathToFileURL(path.join(__dirname, '../../dist/index.html')).href;
let window: BrowserWindow | null = null;
let vault: VaultStore | null = null;
let gitSync: GitSync | null = null;
let closePending = false;
let timer: NodeJS.Timeout | null = null;
let queue: Promise<unknown> = Promise.resolve();
let settings: Settings = { vaultPath: null, autoSyncMinutes: 5, theme: 'dark', githubSetupComplete: false };
const helpLinks: Record<HelpTopic, string> = {
  'install-git': `https://git-scm.com/downloads/${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'}`,
  'install-github': 'https://cli.github.com/',
  'ssh-keys': 'https://docs.github.com/en/authentication/connecting-to-github-with-ssh',
  'host-fingerprints': 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints',
};
let syncStatus: SyncStatus = {
  phase: 'idle', message: 'Saved on this device. Connect a private repository to sync.',
  repository: null, lastSyncedAt: null,
};

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The operation failed. Please try again.';
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request.');
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== 'string' || !value || value.length > maximum) throw new Error(`Invalid ${label}.`);
  return value;
}

function richDocument(value: unknown): value is RichDocument {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'doc'
    && 'content' in value && Array.isArray(value.content);
}

function syncInterval(value: unknown): value is Settings['autoSyncMinutes'] {
  return typeof value === 'number' && [0, 1, 5, 15].includes(value);
}

function themePreference(value: unknown): value is Settings['theme'] {
  return value === 'light' || value === 'dark' || value === 'system';
}

function requireVault(): VaultStore {
  if (!vault) throw new Error('Choose a diary folder first.');
  return vault;
}

function requireUnlocked(): VaultStore {
  const current = requireVault();
  if (!current.isUnlocked) throw new Error('Your diary is locked. Sign in to continue.');
  return current;
}

function trusted(event: IpcMainInvokeEvent): boolean {
  return event.sender === window?.webContents
    && event.senderFrame === window.webContents.mainFrame
    && event.senderFrame.url.split('?')[0] === appUrl;
}

function handle<T>(channel: string, operation: (value: unknown) => Promise<T>): void {
  ipcMain.handle(channel, async (event, value: unknown): Promise<Result<T>> => {
    if (!trusted(event)) return { ok: false, error: 'Untrusted request.' };
    try {
      return { ok: true, value: await serialized(() => operation(value)) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });
}

function emitStatus(status: SyncStatus): void {
  syncStatus = status;
  window?.webContents.send('diary:sync-status', status);
}

function attachVault(folder: string): void {
  vault?.lock();
  vault = new VaultStore(folder);
  gitSync = new GitSync(folder, path.join(app.getPath('userData'), 'disabled-git-hooks'));
}

async function persistSettings(): Promise<void> {
  const folder = app.getPath('userData');
  await mkdir(folder, { recursive: true });
  const temporary = path.join(folder, `settings-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await rename(temporary, path.join(folder, 'settings.json'));
}

async function loadSettings(): Promise<void> {
  let source: string;
  try {
    source = await readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const parsed = object(JSON.parse(source));
  if (parsed.vaultPath !== null && (typeof parsed.vaultPath !== 'string' || !path.isAbsolute(parsed.vaultPath))) {
    throw new Error('The saved diary location is invalid.');
  }
  if (!syncInterval(parsed.autoSyncMinutes) || !themePreference(parsed.theme)) {
    throw new Error('Saved preferences are invalid.');
  }
  settings = {
    vaultPath: parsed.vaultPath,
    autoSyncMinutes: parsed.autoSyncMinutes,
    theme: parsed.theme,
    githubSetupComplete: parsed.githubSetupComplete === true,
  };
  if (settings.vaultPath) attachVault(settings.vaultPath);
}

function scheduleSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (settings.autoSyncMinutes > 0) {
    timer = setInterval(() => {
      if (vault?.isUnlocked && !closePending) window?.webContents.send('diary:sync-requested');
    }, settings.autoSyncMinutes * 60_000);
    timer.unref();
  }
}

async function diarySession(): Promise<DiarySession> {
  const current = requireUnlocked();
  const today = await current.ensureToday();
  return { today, entries: await current.listEntries() };
}

function registerIpc(): void {
  handle('diary:boot', async (): Promise<BootState> => {
    let hasVault = false;
    let error: string | null = null;
    try {
      hasVault = vault ? await vault.exists() : false;
      if (settings.vaultPath && !hasVault) error = 'Your diary folder is unavailable. Reconnect the drive or open the folder again.';
    } catch (cause) {
      error = errorMessage(cause);
    }
    return { platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux', settings, hasVault, unlocked: vault?.isUnlocked ?? false, sync: syncStatus, error };
  });
  handle('diary:choose-folder', async () => {
    if (!window) throw new Error('The application window is unavailable.');
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('diary:create', async (value) => {
    if (vault?.isUnlocked) throw new Error('Lock your current diary before creating another.');
    const input = object(value);
    const folder = text(input.folder, 'folder');
    if (!path.isAbsolute(folder)) throw new Error('Choose an absolute folder path.');
    const next = new VaultStore(folder);
    const result = await next.create(text(input.passphrase, 'passphrase', 1024));
    attachVault(folder);
    vault = next;
    settings = { ...settings, vaultPath: folder, githubSetupComplete: false };
    await persistSettings();
    return result;
  });
  handle('diary:open', async (value) => {
    if (vault?.isUnlocked) throw new Error('Lock your current diary before opening another.');
    const folder = text(value, 'folder');
    if (!path.isAbsolute(folder)) throw new Error('Choose an absolute folder path.');
    const next = new VaultStore(folder);
    if (!await next.exists()) throw new Error('No diary.json found. Clone your existing diary repository, then choose its folder.');
    attachVault(folder);
    settings = { ...settings, vaultPath: folder, githubSetupComplete: false };
    await persistSettings();
    emitStatus({ phase: 'idle', message: 'Repository not yet checked.', repository: null, lastSyncedAt: null });
  });
  handle('diary:unlock', async (value) => {
    const current = requireVault();
    await current.unlock(text(value, 'passphrase', 1024));
    try {
      return await diarySession();
    } catch (error) {
      current.lock();
      throw error;
    }
  });
  handle('diary:recover', async (value) => {
    const input = object(value);
    return requireVault().recover(text(input.recoveryKey, 'recovery key', 512), text(input.newPassphrase, 'passphrase', 1024));
  });
  handle('diary:session', diarySession);
  handle('diary:lock', async () => { requireVault().lock(); });
  handle('diary:list', async () => requireUnlocked().listEntries());
  handle('diary:read', async (value) => requireUnlocked().readEntry(text(value, 'entry date', 10)));
  handle('diary:save', async (value) => {
    const input = object(value);
    const date = text(input.date, 'entry date', 10);
    if (typeof input.title !== 'string' || input.title.length > 200) throw new Error('Titles can be at most 200 characters.');
    const expectedRevision = text(input.expectedRevision, 'entry revision', 128);
    if (!richDocument(input.document)) throw new Error('Invalid entry document.');
    return requireUnlocked().saveEntry({ date, title: input.title, document: input.document, expectedRevision });
  });
  handle('diary:today', async () => requireUnlocked().ensureToday());
  handle('diary:add-image', async () => {
    const current = requireUnlocked();
    if (!window) throw new Error('The application window is unavailable.');
    const selection = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: [{ name: 'Images (maximum 20 MB)', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    });
    if (selection.canceled) return null;
    const { stat } = await import('node:fs/promises');
    const file = selection.filePaths[0];
    if ((await stat(file)).size > 20 * 1024 * 1024) throw new Error('Choose an image smaller than 20 MB.');
    return current.addImage(await readFile(file), path.basename(file));
  });
  handle('diary:repository', async () => {
    requireUnlocked();
    if (!gitSync) throw new Error('Choose a diary folder first.');
    return gitSync.inspect();
  });
  handle('diary:complete-setup', async () => {
    requireUnlocked();
    settings = { ...settings, githubSetupComplete: true };
    await persistSettings();
    return settings;
  });
  handle('diary:open-help', async (value) => {
    if (value !== 'install-git' && value !== 'install-github' && value !== 'ssh-keys' && value !== 'host-fingerprints') {
      throw new Error('Unknown help page.');
    }
    await shell.openExternal(helpLinks[value]);
  });
  handle('diary:sync', async () => {
    requireUnlocked();
    if (!gitSync) throw new Error('Choose a diary folder first.');
    emitStatus({ ...syncStatus, phase: 'syncing', message: 'Checking the private repository and syncing encrypted files...' });
    try {
      const status = await gitSync.sync();
      emitStatus(status);
      return status;
    } catch (error) {
      const status: SyncStatus = { ...syncStatus, phase: 'error', message: errorMessage(error) };
      emitStatus(status);
      return status;
    }
  });
  handle('diary:settings', async (value) => {
    const input = object(value);
    if (!syncInterval(input.autoSyncMinutes) || !themePreference(input.theme)) {
      throw new Error('Invalid preferences.');
    }
    settings = { ...settings, autoSyncMinutes: input.autoSyncMinutes, theme: input.theme };
    await persistSettings();
    scheduleSync();
    return settings;
  });
  ipcMain.on('diary:finish-close', (event) => {
    if (event.sender !== window?.webContents || !closePending) return;
    void serialized(async () => {
      vault?.lock();
      window?.destroy();
    });
  });
  ipcMain.on('diary:cancel-close', (event) => {
    if (event.sender === window?.webContents) closePending = false;
  });
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1380, height: 920, minWidth: 880, minHeight: 640,
    title: 'Still Diary',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.on('close', (event) => {
    if (!vault?.isUnlocked) return;
    event.preventDefault();
    if (!closePending) {
      closePending = true;
      window?.webContents.send('diary:save-before-close');
    }
  });
  window.on('closed', () => { vault?.lock(); window = null; closePending = false; });
  void window.loadURL(appUrl);
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(async () => {
    await loadSettings();
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    protocol.handle('diary-asset', async (request) => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== 'vault' || request.method !== 'GET' || url.search || url.hash) return new Response(null, { status: 400 });
        const id = url.pathname.slice(1);
        if (!/^[a-f0-9-]{36}$/i.test(id)) return new Response(null, { status: 400 });
        const image = await serialized(() => requireUnlocked().readImage(id));
        return new Response(new Uint8Array(image.data), {
          headers: { 'Content-Type': image.mimeType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
        });
      } catch {
        return new Response('Image unavailable. Unlock the diary or check that this image has synced.', { status: 404 });
      }
    });
    registerIpc();
    scheduleSync();
    createWindow();
    app.on('activate', () => { if (!window) createWindow(); });
  }).catch((error: unknown) => {
    dialog.showErrorBox('Still Diary could not start', errorMessage(error));
    app.quit();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => { if (timer) clearInterval(timer); });
}
