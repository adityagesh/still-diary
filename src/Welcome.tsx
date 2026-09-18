import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, FolderOpen, KeyRound, LockKeyhole, ShieldCheck } from 'lucide-react';
import type { BootState, DiarySession } from '../shared/types';
import { api, message, unwrap } from './api';
import { Brand } from './App';
import { setupCommands } from './setup-commands';

type Screen = 'home' | 'create' | 'unlock' | 'recover' | 'recovery-key';

export function Welcome({ boot, onReload, onSignedIn }: {
  boot: BootState;
  onReload: () => Promise<BootState>;
  onSignedIn: (session: DiarySession) => Promise<void>;
}) {
  const [screen, setScreen] = useState<Screen>(boot.hasVault ? 'unlock' : 'home');
  const [folder, setFolder] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [recoveryInput, setRecoveryInput] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(boot.error ?? '');
  const commands = setupCommands(boot.platform, boot.settings.vaultPath ?? '', 'OWNER/REPO');

  useEffect(() => api().onSaveBeforeClose(() => {
    if (screen === 'recovery-key' && !acknowledged) {
      setError('Save your recovery key and check the confirmation before closing. It cannot be shown again.');
      api().cancelClose();
      return;
    }
    void api().lock().then((result) => {
      unwrap(result);
      api().finishClose();
    }).catch((cause) => {
      setError(message(cause));
      api().cancelClose();
    });
  }), [screen, acknowledged]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }

  function navigate(next: Screen) {
    setScreen(next); setError(''); setPassphrase(''); setConfirmation(''); setRecoveryInput('');
  }

  function checkPassphrase() {
    if (passphrase.length < 12) throw new Error('Use at least 12 characters. A few memorable words work well.');
    if (passphrase !== confirmation) throw new Error('The passphrases do not match.');
  }

  async function openExisting() {
    await run(async () => {
      const selected = unwrap(await api().chooseFolder());
      if (!selected) return;
      unwrap(await api().open(selected));
      await onReload();
      navigate('unlock');
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      if (screen === 'unlock') {
        const next = unwrap(await api().unlock(passphrase));
        setPassphrase('');
        await onSignedIn(next);
      } else if (screen === 'create') {
        checkPassphrase();
        if (!folder) throw new Error('Choose an empty folder for your encrypted diary.');
        const result = unwrap(await api().create({ folder, passphrase }));
        setRecoveryKey(result.recoveryKey); setPassphrase(''); setConfirmation(''); setScreen('recovery-key');
      } else if (screen === 'recover') {
        checkPassphrase();
        const result = unwrap(await api().recover({ recoveryKey: recoveryInput, newPassphrase: passphrase }));
        setRecoveryKey(result.recoveryKey); setPassphrase(''); setConfirmation(''); setRecoveryInput(''); setScreen('recovery-key');
      }
    });
  }

  return <main className="welcome">
    <aside className="welcome-story">
      <Brand large />
      <div className="welcome-copy"><span className="eyebrow">PERSONAL. PRIVATE. YOURS.</span>
        <h1>Make room<br />for a little<br /><em>reflection.</em></h1>
        <p>Your days, in your words.<br />A quiet diary that lives on your device<br />and travels with your private GitHub repo.</p>
        <div className="paper-lines" aria-hidden="true"><i /><i /><i /><i /></div>
      </div>
      <div className="welcome-foot"><ShieldCheck size={17} /><span>Encrypted here. Private everywhere.</span></div>
    </aside>
    <section className="welcome-form-panel">
      <div className="welcome-form">
        {screen !== 'home' && screen !== 'recovery-key' && <button className="text-button back" disabled={busy} onClick={() => navigate('home')}><ArrowLeft size={15} /> Back</button>}
        {screen === 'home' && <>
          <div className="small-emblem"><BookOpen size={25} strokeWidth={1.4} /></div>
          <span className="eyebrow">A FRESH PAGE</span><h2>A place just for you.</h2>
          <p className="muted">Start a new diary, or bring your existing one home. No subscription. No account to create.</p>
          <button className="primary wide" disabled={busy} onClick={() => navigate('create')}>Create a diary <ArrowRight size={17} /></button>
          <button className="secondary wide" disabled={busy} onClick={() => void openExisting()}><FolderOpen size={17} /> Open an existing diary</button>
          {boot.hasVault && <button className="text-button centered" onClick={() => navigate('unlock')}>Sign in to your current diary</button>}
          <details className="restore-help"><summary>Restoring from GitHub?</summary><p>Install Git and GitHub CLI, then run these commands in {commands.shellName}. Choose the cloned folder above.</p>
            <pre>{commands.auth}{'\n'}{commands.restore}</pre>
            <p>Replace OWNER/REPO with your private repository. You will need its passphrase or recovery key.</p></details>
          <p className="tiny muted">Open source. Your files, your keys, your history.</p>
        </>}
        {screen === 'recovery-key' ? <>
          <div className="small-emblem"><KeyRound size={25} strokeWidth={1.4} /></div>
          <span className="eyebrow">KEEP THIS SOMEWHERE SAFE</span><h2>Your way back in.</h2>
          <p className="muted">This is your emergency recovery key, not a second sign-in passcode. Save it once; use it only if you forget your encryption passphrase.</p>
          <code className="recovery-key" data-testid="recovery-key">{recoveryKey}</code>
          <div className="notice" data-testid="recovery-warning"><strong>Save this key safely. It is your only way to recover a forgotten passphrase.</strong><p>This key is shown only now. Store it in a password manager or keep a printed copy somewhere safe, outside your diary folder. Never commit it to GitHub.</p><p>If you forget your passphrase and lose this key, your diary cannot be recovered. There is no email reset, support override, or other recovery method.</p></div>
          <label className="checkbox-label"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /> I have saved my recovery key safely and understand there is no other recovery method.</label>
          <button className="primary wide" disabled={!acknowledged || busy} onClick={() => void run(async () => {
            await onSignedIn(unwrap(await api().session()));
            setRecoveryKey('');
          })}>Open my diary <ArrowRight size={16} /></button>
        </> : screen !== 'home' && <form onSubmit={submit}>
          <div className="small-emblem">{screen === 'recover' ? <KeyRound size={24} /> : <LockKeyhole size={24} strokeWidth={1.4} />}</div>
          <span className="eyebrow">{screen === 'create' ? 'THE BEGINNING OF SOMETHING' : screen === 'recover' ? 'A WAY BACK IN' : 'YOUR QUIET SPACE AWAITS'}</span>
          <h2>{screen === 'create' ? 'Start your diary.' : screen === 'recover' ? 'Recover your diary.' : 'Welcome back.'}</h2>
          <p className="muted">{screen === 'create' ? 'Choose a folder and your encryption passphrase. This is the one passphrase you will use to sign in.' : screen === 'recover' ? 'Use your saved emergency recovery key to choose a new encryption passphrase.' : 'Enter your encryption passphrase to unlock your diary on this device.'}</p>
          {screen === 'create' && <div className="field"><label>Diary folder</label>
            <button type="button" className="folder-picker" disabled={busy} onClick={() => void run(async () => {
              const selected = unwrap(await api().chooseFolder()); if (selected) setFolder(selected);
            })}><FolderOpen size={18} /><span>{folder || 'Choose an empty folder'}</span></button>
            <span className="field-hint">Keep this separate from the app's source code.</span>
          </div>}
          {screen === 'unlock' && <p className="vault-path" title={boot.settings.vaultPath ?? ''}><FolderOpen size={14} />{boot.settings.vaultPath}</p>}
          {screen === 'recover' && <div className="field"><label htmlFor="recovery">Recovery key</label><input id="recovery" value={recoveryInput} onChange={(event) => setRecoveryInput(event.target.value)} autoComplete="off" spellCheck={false} required /></div>}
          <div className="field"><label htmlFor="passphrase">{screen === 'recover' ? 'New encryption passphrase' : 'Encryption passphrase'}</label>
            <input id="passphrase" type="password" autoFocus autoComplete={screen === 'unlock' ? 'current-password' : 'new-password'} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} minLength={screen === 'unlock' ? 1 : 12} maxLength={1024} required />
            {screen !== 'unlock' && <span className="field-hint">At least 12 characters. Make it memorable, not guessable.</span>}
          </div>
          {screen !== 'unlock' && <div className="field"><label htmlFor="confirmation">Confirm passphrase</label><input id="confirmation" type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} maxLength={1024} required /></div>}
          {screen === 'create' && <details className="restore-help"><summary>How encryption & recovery work</summary><p>Your passphrase protects every entry and image, even on GitHub. Next, you will receive an emergency recovery key to save separately. There is no email reset or hidden recovery service.</p></details>}
          <button type="submit" className="primary wide" disabled={busy}>{busy ? 'One moment...' : screen === 'create' ? 'Create encrypted diary' : screen === 'recover' ? 'Reset passphrase' : 'Sign in'}<ArrowRight size={16} /></button>
          {screen === 'unlock' && <button type="button" className="text-button centered" disabled={busy} onClick={() => navigate('recover')}>Forgot your passphrase?</button>}
        </form>}
        {error && <div role="alert" className="error-message">{error}</div>}
      </div>
      <div className="auth-footer"><LockKeyhole size={13} /> Local sign-in &nbsp; / &nbsp; End-to-end encrypted sync</div>
    </section>
  </main>;
}
