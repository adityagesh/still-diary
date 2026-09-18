export interface RichNode {
  type: string;
  text?: string;
  attrs?: Record<string, string | number | boolean | null>;
  marks?: Array<{ type: string; attrs?: Record<string, string | number | boolean | null> }>;
  content?: RichNode[];
}

export interface RichDocument extends RichNode {
  type: 'doc';
}

export interface EntrySummary {
  date: string;
  title: string;
  preview: string;
  updatedAt: string;
  revision: string;
}

export interface DiaryEntry {
  date: string;
  title: string;
  document: RichDocument;
  createdAt: string;
  updatedAt: string;
  revision: string;
}

export interface SaveEntryInput {
  date: string;
  title: string;
  document: RichDocument;
  expectedRevision: string;
}

export interface AddedImage {
  id: string;
  mimeType: string;
}

export type SyncPhase = 'idle' | 'syncing' | 'synced' | 'offline' | 'blocked' | 'error';

export interface SyncStatus {
  phase: SyncPhase;
  message: string;
  lastSyncedAt: string | null;
  repository: string | null;
}

export interface RepositoryInfo {
  connected: boolean;
  repository: string | null;
  branch: string | null;
  isPrivate: boolean;
  message: string;
}

export interface Settings {
  vaultPath: string | null;
  autoSyncMinutes: 0 | 1 | 5 | 15;
  theme: 'light' | 'dark' | 'system';
  githubSetupComplete: boolean;
}

export type HelpTopic = 'install-git' | 'install-github' | 'ssh-keys' | 'host-fingerprints';
export type DesktopPlatform = 'windows' | 'linux' | 'mac';

export interface BootState {
  platform: DesktopPlatform;
  settings: Settings;
  hasVault: boolean;
  unlocked: boolean;
  sync: SyncStatus;
  error: string | null;
}

export interface DiarySession {
  entries: EntrySummary[];
  today: DiaryEntry;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface DiaryApi {
  boot(): Promise<Result<BootState>>;
  chooseFolder(): Promise<Result<string | null>>;
  create(input: { folder: string; passphrase: string }): Promise<Result<{ recoveryKey: string }>>;
  open(folder: string): Promise<Result<void>>;
  unlock(passphrase: string): Promise<Result<DiarySession>>;
  recover(input: { recoveryKey: string; newPassphrase: string }): Promise<Result<{ recoveryKey: string }>>;
  session(): Promise<Result<DiarySession>>;
  lock(): Promise<Result<void>>;
  listEntries(): Promise<Result<EntrySummary[]>>;
  readEntry(date: string): Promise<Result<DiaryEntry>>;
  saveEntry(input: SaveEntryInput): Promise<Result<DiaryEntry>>;
  ensureToday(): Promise<Result<DiaryEntry>>;
  addImage(): Promise<Result<AddedImage | null>>;
  sync(): Promise<Result<SyncStatus>>;
  repositoryInfo(): Promise<Result<RepositoryInfo>>;
  completeGithubSetup(): Promise<Result<Settings>>;
  openHelp(topic: HelpTopic): Promise<Result<void>>;
  updateSettings(settings: Pick<Settings, 'autoSyncMinutes' | 'theme'>): Promise<Result<Settings>>;
  onSyncStatus(listener: (status: SyncStatus) => void): () => void;
  onSyncRequested(listener: () => void): () => void;
  onSaveBeforeClose(listener: () => void): () => void;
  finishClose(): void;
  cancelClose(): void;
}

export const EMPTY_DOCUMENT: RichDocument = { type: 'doc', content: [{ type: 'paragraph' }] };

export function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
