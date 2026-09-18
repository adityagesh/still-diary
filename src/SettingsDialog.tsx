import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Github, LockKeyhole, ShieldCheck, X } from 'lucide-react';
import type { DesktopPlatform, HelpTopic, RepositoryInfo, Settings, SyncStatus } from '../shared/types';
import { api, message, unwrap } from './api';
import { setupCommands } from './setup-commands';

export function SettingsDialog({ platform, settings, sync, firstRun, onSettings, onClose, onSync }: {
  platform: DesktopPlatform;
  settings: Settings;
  sync: SyncStatus;
  firstRun: boolean;
  onSettings: (settings: Settings) => void;
  onClose: () => Promise<void>;
  onSync: () => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<'github' | 'preferences'>('github');
  const [owner, setOwner] = useState('YOUR-USERNAME');
  const [repository, setRepository] = useState('my-private-diary');
  const [route, setRoute] = useState<'create' | 'existing'>('create');
  const [info, setInfo] = useState<RepositoryInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { ref.current?.showModal(); }, []);

  async function checkRepository() {
    setBusy(true); setError('');
    try { setInfo(unwrap(await api().repositoryInfo())); } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }

  async function openHelp(topic: HelpTopic) {
    try { unwrap(await api().openHelp(topic)); } catch (cause) { setError(message(cause)); }
  }

  async function close(syncAfter = false) {
    try {
      await onClose();
      if (syncAfter) await onSync();
    } catch (cause) { setError(message(cause)); }
  }

  const safeOwner = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(owner) ? owner : 'YOUR-USERNAME';
  const safeRepo = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(repository) ? repository : 'my-private-diary';
  const repo = `${safeOwner}/${safeRepo}`;
  const commands = setupCommands(platform, settings.vaultPath ?? '', repo);

  async function changePreferences(change: Partial<Pick<Settings, 'autoSyncMinutes' | 'theme'>>) {
    setError(''); setBusy(true);
    try { onSettings(unwrap(await api().updateSettings({ autoSyncMinutes: settings.autoSyncMinutes, theme: settings.theme, ...change }))); }
    catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }

  return <dialog ref={ref} className="settings-dialog" aria-label={firstRun ? 'Set up your private backup' : 'Settings & connections'} onCancel={(event) => { event.preventDefault(); void close(); }}>
    <div className="dialog-heading"><div><span className="eyebrow">{firstRun ? 'ONE LAST THING. ONLY IF YOU WANT TO.' : 'MAKE YOURSELF AT HOME'}</span><h2>{firstRun ? 'Set up your private backup.' : 'Settings & connections'}</h2></div><button className="icon-button" aria-label="Close settings" onClick={() => void close()}><X size={20} /></button></div>
    <div className="settings-tabs" role="tablist"><button role="tab" aria-selected={tab === 'github'} className={tab === 'github' ? 'selected' : ''} onClick={() => setTab('github')}><Github size={16} /> GitHub sync</button><button role="tab" aria-selected={tab === 'preferences'} className={tab === 'preferences' ? 'selected' : ''} onClick={() => setTab('preferences')}>Preferences & privacy</button></div>
    <div className="dialog-body">
      {tab === 'github' ? <>
        <div className="connection-summary"><ShieldCheck size={23} /><div><strong>Your diary is encrypted on this device.</strong><p>GitHub can keep a private backup so you can restore it on another computer. It receives encrypted files, not your readable diary. You can set this up now or write first.</p></div></div>
        <div className="setup-steps">
          <details className="setup-step">
            <summary><span className="step-number">1</span><span><strong>Install</strong><small>Get the two free tools. Already installed? Skip this step.</small></span></summary>
            <div className="step-content">
              <p><strong>Git</strong> keeps your diary's history. <strong>GitHub CLI</strong> connects it to your GitHub account. Download and install each from its official website, then reopen Still.</p>
              <div className="install-links"><button className="secondary" onClick={() => void openHelp('install-git')}>Install Git <ArrowUpRight size={14} /></button><button className="secondary" onClick={() => void openHelp('install-github')}>Install GitHub CLI <ArrowUpRight size={14} /></button></div>
              <details className="restore-help"><summary>Check whether they are installed</summary><p>{commands.openShell} Paste these commands; both should print a version number.</p><pre>git --version{'\n'}gh --version</pre></details>
            </div>
          </details>
          <details className="setup-step">
            <summary><span className="step-number">2</span><span><strong>Connect your GitHub account</strong><small>A one-time sign-in in your browser.</small></span></summary>
            <div className="step-content"><p>{commands.openShell} Paste the first line below and press Enter. Follow the prompts, choose SSH, and finish signing in through your browser. Then run the second line to check the connection.</p><pre>{commands.auth}</pre>
              <p>These are GitHub's sign-in prompts, not your diary's encryption passphrase. Never enter your diary passphrase or recovery key here.</p>
              <details className="restore-help"><summary>SSH keys & host verification</summary><p>SSH is how this computer proves it can access your repository. GitHub CLI can guide you through setting up a key. Before accepting a new host, check its fingerprint using GitHub's official page.</p><div className="help-links"><button className="text-button" onClick={() => void openHelp('ssh-keys')}>SSH setup guide <ArrowUpRight size={12} /></button><button className="text-button" onClick={() => void openHelp('host-fingerprints')}>GitHub fingerprints <ArrowUpRight size={12} /></button></div><p>A successful <code>ssh -T</code> greeting normally exits with code 1 because GitHub does not provide shell access.</p></details>
            </div>
          </details>
          <details className="setup-step">
            <summary><span className="step-number">3</span><span><strong>Choose your private backup</strong><small>Create a repository, or restore one you already have.</small></span></summary>
            <div className="step-content">
              <p>A repository is simply your diary's private folder on GitHub. Only you and people you grant access can access it; its contents stay encrypted.</p>
              <div className="segmented"><button className={route === 'create' ? 'selected' : ''} onClick={() => setRoute('create')}>Create new backup</button><button className={route === 'existing' ? 'selected' : ''} onClick={() => setRoute('existing')}>Restore existing diary</button></div>
              <div className="repo-fields"><div className="field"><label htmlFor="github-owner">Your GitHub username</label><input id="github-owner" value={owner} onChange={(event) => setOwner(event.target.value)} spellCheck={false} /></div><div className="field"><label htmlFor="github-repo">Name for your backup</label><input id="github-repo" value={repository} onChange={(event) => setRepository(event.target.value)} spellCheck={false} /></div></div>
              <p>{route === 'create' ? `Fill in your username above, then paste these commands into ${commands.shellName}. They create a private repository for this diary.` : `Fill in your existing repository details, then paste this command into ${commands.shellName} to download it into a new folder.`}</p>
              <pre>{route === 'create' ? commands.create : commands.restore}</pre>
              <p>{route === 'create' ? 'Return here, check the connection below, then choose Sync now. Keep this repository only for your diary.' : `Lock Still, choose Open an existing diary, and select the new ${commands.restoredFolder} folder. Use its original encryption passphrase or recovery key.`}</p>
            </div>
          </details>
        </div>
        <div className="repo-check"><div><span className="field-hint">READY TO CONNECT?</span><p>{info?.message ?? (sync.repository || 'Finish the steps above, then check your connection.')}</p></div><button className="secondary" disabled={busy} onClick={() => void checkRepository()}>{busy ? 'Checking...' : 'Check connection'}</button></div>
        {info?.isPrivate && <p className="success-message"><Check size={15} /> Verified private: {info.repository}</p>}
        <details className="restore-help"><summary>Troubleshooting & advanced details</summary>
          <p>For a passphrase-protected SSH key, unlock it in an SSH agent before syncing. Use the same SSH installation for your agent and Git. Background sync never prompts for credentials or accepts unknown host keys.</p>
          <p>Offline? Your diary keeps saving locally. A failed sync never means a failed local save. Retry when your connection returns.</p>
          <p>If two devices edit the same encrypted file, Still stops and preserves both Git versions instead of choosing one. Do not force push or reset. See the README's conflict recovery instructions.</p>
          <p>Automatic sync runs only while this app is open and unlocked. It briefly pauses editing to flush and reconcile the current page safely.</p>
        </details>
      </> : <>
        <div className="preference-row"><div><strong>Appearance</strong><p>A quiet, paper-like palette.</p></div><select aria-label="Appearance" value={settings.theme} disabled={busy} onChange={(event) => void changePreferences({ theme: event.target.value as Settings['theme'] })}><option value="light">Paper</option><option value="dark">Night</option><option value="system">Follow device</option></select></div>
        <div className="preference-row"><div><strong>Automatic sync</strong><p>Only while Still is open and unlocked.</p></div><select aria-label="Automatic sync interval" value={settings.autoSyncMinutes} disabled={busy} onChange={(event) => void changePreferences({ autoSyncMinutes: Number(event.target.value) as Settings['autoSyncMinutes'] })}><option value={0}>Manual only</option><option value={1}>Every minute</option><option value={5}>Every 5 minutes</option><option value={15}>Every 15 minutes</option></select></div>
        <div className="preference-row"><div><strong>Local autosave</strong><p>Encrypted after a 650 ms pause, and before changing pages, syncing, locking or closing.</p></div><span className="pill">Always on</span></div>
        <div className="privacy-card"><LockKeyhole size={21} /><h3>Open source. Your data stays with you.</h3><p>One encryption passphrase for sign-in. One emergency recovery key, stored separately. No email reset, hosted account service or hidden access.</p>
          <details className="restore-help"><summary>How encryption protects your diary</summary><p>Your passphrase unlocks a random encryption key. Your emergency recovery key can reset a forgotten passphrase. Neither secret is sent to GitHub.</p><p>GitHub can still see filenames, entry dates, file sizes and commit times. Private repositories are not a substitute for encryption.</p><p>Recovery resets the current diary's sign-in, but cannot revoke a key that someone already holds or erase old Git history.</p><p>Locking clears the diary from the app and its key buffers. An unlocked device, malware, screenshots, OS swap, and copied text are outside this app's protection.</p></details>
        </div>
        <div className="field"><label>Local diary folder</label><code className="folder-display">{settings.vaultPath}</code></div>
      </>}
      {error && <div className="error-message" role="alert">{error}</div>}
    </div>
    <div className="dialog-footer">{firstRun ? <button className="text-button" onClick={() => void close()}>I'll set this up later</button> : <span><LockKeyhole size={13} /> No telemetry. No hosted backend.</span>}<button className="primary" disabled={busy} onClick={() => void close(true)}>Sync now</button></div>
  </dialog>;
}
