import { contextBridge, ipcRenderer } from 'electron';
import type { DiaryApi, Result, SyncStatus } from '../shared/types';

function invoke<T>(channel: string, value?: unknown): Promise<Result<T>> {
  return ipcRenderer.invoke(channel, value) as Promise<Result<T>>;
}

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T): void => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: DiaryApi = {
  boot: () => invoke('diary:boot'),
  chooseFolder: () => invoke('diary:choose-folder'),
  create: (input) => invoke('diary:create', input),
  open: (folder) => invoke('diary:open', folder),
  unlock: (passphrase) => invoke('diary:unlock', passphrase),
  recover: (input) => invoke('diary:recover', input),
  session: () => invoke('diary:session'),
  lock: () => invoke('diary:lock'),
  listEntries: () => invoke('diary:list'),
  readEntry: (date) => invoke('diary:read', date),
  saveEntry: (input) => invoke('diary:save', input),
  ensureToday: () => invoke('diary:today'),
  addImage: () => invoke('diary:add-image'),
  sync: () => invoke('diary:sync'),
  repositoryInfo: () => invoke('diary:repository'),
  completeGithubSetup: () => invoke('diary:complete-setup'),
  openHelp: (topic) => invoke('diary:open-help', topic),
  updateSettings: (input) => invoke('diary:settings', input),
  onSyncStatus: (listener) => subscribe<SyncStatus>('diary:sync-status', listener),
  onSyncRequested: (listener) => subscribe('diary:sync-requested', listener),
  onSaveBeforeClose: (listener) => subscribe('diary:save-before-close', listener),
  finishClose: () => ipcRenderer.send('diary:finish-close'),
  cancelClose: () => ipcRenderer.send('diary:cancel-close'),
};

contextBridge.exposeInMainWorld('diary', api);
