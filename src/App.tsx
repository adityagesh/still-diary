import { useCallback, useEffect, useState } from 'react';
import type { BootState, DiarySession, Settings } from '../shared/types';
import { BookOpen, ShieldCheck } from 'lucide-react';
import { api, message, unwrap } from './api';
import { Welcome } from './Welcome';
import { Workspace } from './Workspace';

export function Brand({ large = false }: { large?: boolean }) {
  return <div className={`brand ${large ? 'brand-large' : ''}`}><BookOpen strokeWidth={1.4} /><span>still<span className="brand-period">.</span></span></div>;
}

export function App() {
  const [boot, setBoot] = useState<BootState | null>(null);
  const [session, setSession] = useState<DiarySession | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    const state = unwrap(await api().boot());
    setBoot(state);
    return state;
  }, []);

  useEffect(() => {
    if (window.diary) void reload().catch((cause) => setError(message(cause)));
  }, [reload]);

  useEffect(() => {
    if (!boot) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.setAttribute('data-theme',
      boot.settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : boot.settings.theme);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [boot?.settings.theme]);

  const signedIn = async (next: DiarySession) => {
    await reload();
    setSession(next);
  };

  const locked = async () => {
    setSession(null);
    await reload();
  };

  const updateSettings = (settings: Settings) => {
    setBoot((current) => current ? { ...current, settings } : current);
  };

  if (!window.diary) return <main className="desktop-required"><Brand large /><h1>A private place, on your device.</h1>
    <p>Still is a desktop app, not a website. Its encryption keys and Git access stay on your computer.</p>
    <pre>npm install{'\n'}npm run dev</pre><p>Run these commands from the <code>still-diary</code> folder.</p>
    <span className="privacy-note"><ShieldCheck size={16} /> No account service. No analytics. No hosted backend.</span></main>;

  if (!boot) return <main className="loading-screen"><Brand large /><p role={error ? 'alert' : 'status'}>{error || 'Opening your quiet space...'}</p></main>;

  return session
    ? <Workspace initial={session} boot={boot} onLocked={locked} onSettings={updateSettings} />
    : <Welcome boot={boot} onReload={reload} onSignedIn={signedIn} />;
}
