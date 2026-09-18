import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronRight, Cloud, CloudOff, LockKeyhole, Moon, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sun, X } from 'lucide-react';
import type { BootState, DiaryEntry, DiarySession, EntrySummary, RichDocument, RichNode, Settings } from '../shared/types';
import { localDate } from '../shared/types';
import { api, message, unwrap } from './api';
import { Brand } from './App';
import { DiaryEditor } from './Editor';
import { SettingsDialog } from './SettingsDialog';
import { SaveCoordinator } from './save-coordinator';

export function plainText(node: RichNode): string {
  return node.text ?? node.content?.map(plainText).join(node.type === 'paragraph' ? '' : ' ') ?? '';
}

function asSummary(entry: DiaryEntry): EntrySummary {
  return { date: entry.date, title: entry.title, preview: plainText(entry.document).slice(0, 160), updatedAt: entry.updatedAt, revision: entry.revision };
}

function readableDate(value: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, options);
}

export function Workspace({ initial, boot, onLocked, onSettings }: {
  initial: DiarySession;
  boot: BootState;
  onLocked: () => Promise<void>;
  onSettings: (settings: Settings) => void;
}) {
  const [entry, setEntry] = useState(initial.today);
  const [entries, setEntries] = useState(initial.entries);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState<'saved' | 'pending' | 'saving' | 'error'>('saved');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(!boot.settings.githubSetupComplete);
  const [sync, setSync] = useState(boot.sync);
  const [contentVersion, setContentVersion] = useState(0);
  const busyRef = useRef(false);
  const modelRef = useRef<SaveCoordinator | null>(null);
  if (!modelRef.current) {
    modelRef.current = new SaveCoordinator(initial.today,
      async (input) => unwrap(await api().saveEntry(input)),
      (saved) => setEntries((current) => current.map((item) => item.date === saved.date ? asSummary(saved) : item)),
    );
  }
  const model = modelRef.current;

  const flush = useCallback(async () => {
    if (model.dirty) setSaving('saving');
    try {
      await model.flush();
      setEntry(model.current);
      setSaving('saved');
      setError((current) => current.startsWith('Local save failed:') ? '' : current);
    } catch (cause) {
      setSaving('error');
      setError(`Local save failed: ${message(cause)} Your draft is still open. Keep the app open until it is saved.`);
      throw cause;
    }
  }, [model]);

  const exclusive = useCallback(async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try { await action(); } catch (cause) { setError(message(cause)); } finally { busyRef.current = false; setBusy(false); }
  }, []);

  const syncNow = useCallback(async () => {
    await exclusive(async () => {
      await flush();
      const status = unwrap(await api().sync());
      setSync(status);
      if (status.phase === 'synced') {
        const current = unwrap(await api().readEntry(model.current.date));
        model.replace(current);
        setEntry(current);
        setContentVersion((value) => value + 1);
        setEntries(unwrap(await api().listEntries()));
      }
    });
  }, [exclusive, flush, model]);

  useEffect(() => {
    if (!model.dirty) return;
    const timer = window.setTimeout(() => { void flush().catch(() => { /* flush exposes the error and preserves the draft. */ }); }, 650);
    return () => window.clearTimeout(timer);
  }, [entry.title, entry.document, flush, model]);

  useEffect(() => api().onSyncStatus(setSync), []);
  useEffect(() => api().onSyncRequested(() => {
    if (!settingsOpen) void syncNow();
  }), [settingsOpen, syncNow]);
  useEffect(() => api().onSaveBeforeClose(() => {
    void flush().then(() => api().finishClose()).catch(() => api().cancelClose());
  }), [flush]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (event.shiftKey) void syncNow();
        else void flush().catch(() => { /* The save error remains visible. */ });
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [flush, syncNow]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!entries.some((item) => item.date === localDate()) && !busyRef.current && !model.dirty) {
        void exclusive(async () => {
          unwrap(await api().ensureToday());
          setEntries(unwrap(await api().listEntries()));
        });
      }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [entries, exclusive, model]);

  const change = (update: { title?: string; document?: RichDocument }) => {
    setEntry(model.update(update));
    setSaving('pending');
  };

  const selectEntry = (date: string) => {
    if (date === model.current.date) return;
    void exclusive(async () => {
      await flush();
      const next = unwrap(await api().readEntry(date));
      model.replace(next); setEntry(next); setSaving('saved');
    });
  };

  const openToday = () => void exclusive(async () => {
    await flush();
    const next = unwrap(await api().ensureToday());
    model.replace(next); setEntry(next); setSaving('saved'); setQuery('');
    setEntries(unwrap(await api().listEntries()));
  });

  const lock = () => void exclusive(async () => {
    await flush();
    unwrap(await api().lock());
    await onLocked();
  });

  const toggleTheme = () => void exclusive(async () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    onSettings(unwrap(await api().updateSettings({ autoSyncMinutes: boot.settings.autoSyncMinutes, theme })));
  });

  const closeSettings = async () => {
    if (!boot.settings.githubSetupComplete) onSettings(unwrap(await api().completeGithubSetup()));
    setSettingsOpen(false);
  };

  const needle = query.trim().toLocaleLowerCase();
  const filtered = [...entries].sort((a, b) => b.date.localeCompare(a.date))
    .filter((item) => `${item.date} ${item.title} ${item.preview}`.toLocaleLowerCase().includes(needle));
  const groups = filtered.reduce<Record<string, EntrySummary[]>>((result, item) => {
    const key = item.date.slice(0, 7); (result[key] ??= []).push(item); return result;
  }, {});
  const words = plainText(entry.document).trim().split(/\s+/).filter(Boolean).length;
  const localStatus = saving === 'saved' ? 'Saved on this device' : saving === 'error' ? 'Not saved - retry' : 'Saving locally...';
  const failedSync = ['blocked', 'error', 'offline'].includes(sync.phase);
  const night = boot.settings.theme === 'dark'
    || (boot.settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="sidebar-brand"><Brand /><span className="eyebrow">YOUR PRIVATE JOURNAL</span></div>
      <button className="today-button" disabled={busy} onClick={openToday}><Plus size={17} /> Today's page <span>{new Date().getDate()}</span></button>
      <div className="search-field"><Search size={15} /><input aria-label="Search entries" placeholder="Find a memory..." value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button aria-label="Clear search" onClick={() => setQuery('')}><X size={14} /></button>}</div>
      <div className="entries-label"><span>ENTRIES</span><span>{entries.length.toString().padStart(2, '0')}</span></div>
      <nav className="entry-list" aria-label="Diary entries">
        {Object.entries(groups).map(([month, items]) => <div className="month-group" key={month}>
          <h2>{readableDate(`${month}-01`, { month: 'long', year: 'numeric' })}</h2>
          {items.map((item) => <button key={item.date} disabled={busy} onClick={() => selectEntry(item.date)} className={`entry-card ${entry.date === item.date ? 'selected' : ''}`} aria-current={entry.date === item.date ? 'page' : undefined}>
            <div className="entry-card-date"><span>{readableDate(item.date, { weekday: 'short', day: 'numeric', month: 'short' })}</span>{item.date === localDate() && <span className="today-tag">TODAY</span>}</div>
            <strong>{item.title || 'Untitled day'}</strong><p>{item.preview || 'A fresh page, waiting for you.'}</p>
          </button>)}
        </div>)}
        {!filtered.length && <p className="empty-search">No entries found.<br />Try a different word.</p>}
      </nav>
      <div className="sidebar-bottom">
        <div className="private-badge"><ShieldCheck size={16} /><div><strong>Just between you & you.</strong><span>Encrypted on your device</span></div></div>
        <button className="sidebar-settings" onClick={() => setSettingsOpen(true)} disabled={busy}><Settings2 size={16} /><span>Settings & GitHub</span><ChevronRight size={14} /></button>
      </div>
    </aside>
    <section className="journal">
      <header className="journal-topbar"><div className="breadcrumb"><span>My diary</span><ChevronRight size={12} /><strong>{entry.date === localDate() ? 'Today' : readableDate(entry.date, { month: 'short', day: 'numeric' })}</strong></div>
        <div className="topbar-actions"><span className="local-only"><LockKeyhole size={12} /> Private space</span>
          <button className="icon-button" aria-label="Toggle light or dark theme" title="Toggle theme" disabled={busy} onClick={toggleTheme}>{night ? <Sun size={17} /> : <Moon size={17} />}</button>
          <button className="icon-button" aria-label="Lock diary" title="Save and lock diary" disabled={busy} onClick={lock}><LockKeyhole size={17} /></button></div>
      </header>
      {error && <div className="workspace-error" role="alert"><span>{error}</span>{saving === 'error' && <button onClick={() => void flush().catch(() => {})}>Retry save</button>}<button aria-label="Dismiss error" onClick={() => setError('')}><X size={15} /></button></div>}
      <div className="page-scroll">
        <article className="diary-page">
          <div className="page-heading"><div><div className="date-eyebrow"><span className="date-line" />{readableDate(entry.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
            <input className="entry-title" aria-label="Entry title" placeholder="Give today a title..." value={entry.title} maxLength={200} disabled={busy} onChange={(event) => change({ title: event.target.value })} /></div>
            <span className="page-number">NO. {String(entries.length - [...entries].sort((a, b) => b.date.localeCompare(a.date)).findIndex((item) => item.date === entry.date)).padStart(3, '0')}</span>
          </div>
          <DiaryEditor key={`${entry.date}:${contentVersion}`} entry={entry} disabled={busy} onChange={(document) => change({ document })} onError={(cause) => setError(message(cause))} onAddImage={(insert) => {
            void exclusive(async () => {
              const image = unwrap(await api().addImage());
              if (image) insert(image);
              await flush();
            });
          }} />
          <div className="page-end" aria-hidden="true"><span /> <span className="end-dot">.</span> <span /></div>
        </article>
      </div>
      <footer className="journal-footer">
        <div className="footer-left"><span>{words} {words === 1 ? 'word' : 'words'}</span><span className="footer-separator" /><span>{Math.max(1, Math.ceil(words / 200))} min read</span></div>
        <div className="save-sync">
          <span className={`save-status ${saving === 'error' ? 'failed' : ''}`} role="status">{saving === 'saved' ? <Check size={14} /> : <span className="status-dot" />}{localStatus}</span>
          <span className="footer-separator" />
          <button className={`sync-button ${failedSync ? 'needs-attention' : ''}`} disabled={busy} onClick={() => void syncNow()} title={sync.message}>
            <RefreshCw size={14} className={sync.phase === 'syncing' ? 'spinning' : ''} />{sync.phase === 'syncing' ? 'Syncing...' : 'Sync now'}
          </button>
        </div>
      </footer>
      <div className={`sync-detail ${failedSync ? 'needs-attention' : ''}`} role="status">
        {failedSync ? <CloudOff size={13} /> : <Cloud size={13} />}<span>{sync.phase === 'synced' && sync.lastSyncedAt ? `Encrypted backup synced at ${new Date(sync.lastSyncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${sync.repository}` : sync.message}</span>
        {(failedSync || sync.phase === 'idle') && <button onClick={() => setSettingsOpen(true)}>Setup & help <ArrowUpRight size={12} /></button>}
      </div>
    </section>
    {settingsOpen && <SettingsDialog platform={boot.platform} settings={boot.settings} sync={sync} firstRun={!boot.settings.githubSetupComplete} onSettings={onSettings} onClose={closeSettings} onSync={syncNow} />}
  </main>;
}
