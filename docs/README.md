# Still Diary reference guide

[Back to the quick start](../README.md)

- [Installation and troubleshooting](#install-from-a-release)
- [Build from source](#build-from-source)
- [Writing and settings](#first-use)
- [Private GitHub backup](#connect-github-using-ssh)
- [Sync conflicts](#concurrent-edits-and-conflicts)
- [Privacy and recovery](#recovery-and-privacy)
- [Encrypted file format and configuration](#repository-schema)
- [Development](#development)
- [CI/CD and releases](#cicd-and-releases)

**Open source. Your data stays with you. Encrypted before it leaves your device.**

A local-first desktop diary with a quiet, paper-like interface, encrypted entries and images, and backups to your own **private GitHub repository**. Built with Electron, React, TypeScript and Tiptap. MIT licensed; no bundled proprietary fonts, hosted backend, analytics or subscription.

The layout has dated entries on the left, an optional title and rich-text page on the right, and separate local-save and GitHub-sync indicators at the bottom.

**This public repository contains only the app.** Every user's diary data belongs in a **different, private repository** owned by that user. Never upload diary files, recovery keys, or credentials here.

## Install from a release

**[Download the latest release](https://github.com/adityagesh/still-diary/releases/latest)**. You do not need Node.js, npm, or the source code to use the app.

| Platform | Download v0.1.0 | Installation |
| --- | --- | --- |
| Windows 10/11, x64 | [Portable `.exe`](https://github.com/adityagesh/still-diary/releases/download/v0.1.0/Still-Diary-0.1.0-Windows-x64.exe) | Download and open the executable. No installer is needed. |
| Ubuntu/Debian Linux, x64 | [Installable `.deb`](https://github.com/adityagesh/still-diary/releases/download/v0.1.0/Still-Diary-0.1.0-Linux-x64.deb) | Open it with your software installer, or use the command below. |
| Linux, x64 | [Portable `.AppImage`](https://github.com/adityagesh/still-diary/releases/download/v0.1.0/Still-Diary-0.1.0-Linux-x64.AppImage) | Make it executable, then run it as described below. |

The diary stays in the separate folder you select, not inside the executable or installation directory. Updating the app does not require creating a new diary.

<details>
<summary>Linux installation commands</summary>

Ubuntu/Debian, from the folder containing the download:

```bash
sudo apt install ./Still-Diary-0.1.0-Linux-x64.deb
still-diary
```

For the portable AppImage:

```bash
chmod +x Still-Diary-0.1.0-Linux-x64.AppImage
./Still-Diary-0.1.0-Linux-x64.AppImage
```

Run as your normal user, not root. If your distribution reports a missing `libfuse.so.2`, install its FUSE 2 compatibility package (for example, `libfuse2` on Ubuntu 22.04 or `libfuse2t64` on Ubuntu 24.04), or use the `.deb` on a supported distribution. Chromium sandbox support must be available; do not disable the app's sandbox to work around an unsupported environment.

</details>

<details>
<summary>Verify downloads and understand unsigned builds</summary>

Download [SHA256SUMS.txt](https://github.com/adityagesh/still-diary/releases/download/v0.1.0/SHA256SUMS.txt) from the same release.

On Windows, compare this result with the matching filename in that file:

```powershell
Get-FileHash '.\Still-Diary-0.1.0-Windows-x64.exe' -Algorithm SHA256
```

On Linux, place the checksum file next to your downloaded asset:

```bash
sha256sum --ignore-missing --check SHA256SUMS.txt
```

Checksums detect download corruption; they do not replace code signing. Builds are currently **unsigned**, and the encryption has not undergone an independent audit. If your operating system blocks an untrusted build, do not bypass its security warning. Use your normal approved development/signing process instead.

</details>

Git and GitHub CLI are optional for offline writing and required for GitHub backup. The first-login setup popup has expandable **Install** instructions and official download links. Choose **I'll set this up later** to start writing offline.

## Build from source

Install a supported [Node.js LTS release](https://nodejs.org/) (Node 24 recommended) and [Git](https://git-scm.com/downloads). Clone **the app repository**, not your private diary repository:

```powershell
git clone https://github.com/adityagesh/still-diary.git
Set-Location '.\still-diary'
npm ci
npm run dev
```

On Linux, use `cd still-diary` instead of `Set-Location`; the npm commands are the same.

For a production build:

```powershell
npm run build
npm start
```

<details>
<summary>Build Windows or Linux release packages</summary>

Create a distributable Windows executable:

```powershell
npm run package:win
```

The portable executable is written to `release\Still-Diary-0.1.0-Windows-x64.exe`. `npm run pack` creates the unpacked application in `release\win-unpacked`.

On Linux:

```bash
npm run package:linux
```

The AppImage and Debian package are written to `release`. Build each platform on its native OS, or use the GitHub Actions workflow. Windows and Ubuntu 22.04 x64 are the release CI targets; ARM and macOS downloads are not currently published.

</details>

## First use

1. Choose **Create a diary** and an empty local directory, for example `C:\Diaries\Personal`. Keep this **separate from the application's source directory**. An empty Git repository containing only `.git` is also supported.
2. Choose a passphrase of at least 12 characters. This is a local encryption passphrase, not your GitHub password.
3. Save the displayed recovery key in a password manager or on paper, **outside the diary directory and GitHub**. The app shows an always-visible warning and requires you to confirm you have saved it and understand the risk. **If you forget your passphrase and lose the recovery key, your diary cannot be recovered. There is no email reset, support override, or other recovery method.**
4. Your diary opens with today's entry, using your computer's local date. Signing in again reopens the same daily entry instead of duplicating it.

**Night is the default theme.** Switch to Paper or Follow device in preferences if you prefer.

On your first sign-in for a diary, a **Set up your private backup** popup explains GitHub in three expandable steps: **Install**, **Connect your GitHub account**, and **Choose your private backup**. Installation links and commands appear only when you expand their heading. Choose **I'll set this up later** to start writing immediately; return through **Settings & GitHub** whenever ready. Troubleshooting and optional explanations are collapsed by default.

### Where is the encryption passphrase?

It is the clearly labeled **Encryption passphrase** field under **Create a diary**, and the same field on each later sign-in. You use **one everyday passphrase**. The separately generated **emergency recovery key** is not another daily passcode: save it once and use it only if you forget your passphrase.

<details>
<summary>Why not recover through email?</summary>

A purely local app cannot safely reset encryption through an email address alone. That would require a trusted recovery service or an additional recovery secret stored in email. Still deliberately keeps one sign-in passphrase and a separately saved emergency recovery key: no email reset, hosted recovery account, or hidden access. GitHub account recovery restores access to the repository, not the ability to decrypt its contents.

</details>

### Writing and saving

Write using bold, italic, underline, lists, quotes, font sizes and text colors. **Add image** accepts PNG, JPEG, GIF and WebP files up to 20 MB, encrypting them before use. SVG, remote-image URLs, inline base64 images, and pasted/dropped image files are intentionally unsupported. Use the image picker instead.

The app autosaves after a 650 ms pause and flushes the current draft before switching entries, syncing, locking or closing. `Ctrl+S` saves immediately; `Ctrl+Shift+S` syncs. A power failure or forced process termination can lose text typed since the last completed save. Disk errors remain visible, and unsaved drafts stay in the editor rather than being silently discarded.

The lock button saves and locks the diary. Each launch requires sign-in. Keep the app locked and use your operating system's screen lock when leaving your computer.

## Connect GitHub using SSH

The app provides these commands in **Settings & GitHub**, with fields for your repository owner and name. Run them yourself; Still does not create accounts, repositories, keys or permissions automatically.

### 1. Authenticate GitHub

Check the prerequisites:

```powershell
git --version
gh --version
ssh -V
```

Authenticate interactively, choosing SSH and following GitHub CLI's SSH-key prompts:

```powershell
gh auth login --hostname github.com --git-protocol ssh --web
gh auth status --hostname github.com
ssh -T git@github.com
```

Before accepting a new SSH host, compare its fingerprint with GitHub's published fingerprints:
<https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints>

GitHub's successful SSH greeting says you have authenticated but shell access is unavailable. It normally exits with status **1**; the greeting, not exit code zero, indicates success.

<details>
<summary>Optional: manual SSH keys and background SSH agents</summary>

If you need to create a key manually, first check for an existing key. Do **not** overwrite an existing private key:

```powershell
Test-Path "$HOME\.ssh\id_ed25519"
# Run the next command only if the path does not already exist.
ssh-keygen -t ed25519 -C "still-diary" -f "$HOME\.ssh\id_ed25519"
```

Use a passphrase for your SSH key. Upload only `id_ed25519.pub`, never the private key. GitHub CLI's login flow can register the public key; alternatively use GitHub's SSH-key settings following its official instructions:
<https://docs.github.com/en/authentication/connecting-to-github-with-ssh>

For background sync, load a passphrase-protected key into an SSH agent:

```powershell
ssh-add "$HOME\.ssh\id_ed25519"
ssh-add -l
```

An agent must already be running. Windows OpenSSH may require enabling/starting the `ssh-agent` service through your administrator or your normal Windows setup process. Git for Windows can use a different SSH implementation: use the same SSH executable and agent for your shell and Git. Test `git ls-remote git@github.com:OWNER/REPO.git` without an interactive passphrase prompt before expecting automatic sync to work.

Still uses SSH batch mode: it never prompts in the background, creates a credential, or silently trusts a new host. GitHub CLI authentication is also required to independently verify repository visibility through GitHub's API.

For predictable background behavior, sync ignores custom SSH configuration (`-F none`). Use a default SSH identity filename or load your key into the matching SSH agent; SSH host aliases and custom `IdentityFile` settings are not used.

</details>

### 2A. Create a new private repository

After creating the local diary, replace the path and `OWNER/REPO`:

```powershell
Set-Location -LiteralPath 'C:\Diaries\Personal'
git init --initial-branch=main
gh repo create OWNER/REPO --private --source . --remote origin
```

Do not initialize the remote with a README, license, `.gitignore`, or other files. This is a dedicated encrypted-data repository, not the app's source repository.

Return to Still, click **Check connection**, then **Sync now**. The app stages only its schema files, creates a local commit as `Still Diary <diary@localhost>`, fetches, reconciles compatible history and pushes the selected branch. It does not alter your global Git identity.

If you already created an **empty private repository** on GitHub, use this instead of `gh repo create`:

```powershell
Set-Location -LiteralPath 'C:\Diaries\Personal'
git init --initial-branch=main
git remote add origin git@github.com:OWNER/REPO.git
```

### 2B. Restore a previous diary

On a new installation, authenticate as above, then clone:

```powershell
git clone git@github.com:OWNER/REPO.git "$HOME\Documents\Restored Diary"
```

Choose **Open an existing diary**, select `Restored Diary`, and sign in with the original passphrase. If forgotten, select **Forgot your passphrase?** and use the recovery key.

Do not create a new diary inside an existing diary clone. Never copy the application source or your recovery key into the diary repository.

## Autosave and sync are different

**Saved on this device** means the current entry has been encrypted and written locally. It does not mean a GitHub backup exists.

**Synced** is reported only after GitHub synchronization succeeds. The default automatic interval is five minutes, configurable to one minute, fifteen minutes or manual-only. Automatic sync runs while the app is open and unlocked; it is not a Windows background service. Sync briefly pauses editing to flush and reconcile the current page without racing autosave.

Every sync verifies that the SSH origin identifies a repository on `github.com` and that GitHub's API reports it as private. An unavailable API, missing authentication or a public repository blocks network Git synchronization. HTTPS remotes, custom SSH hosts, nonstandard ports, alternate push destinations, hooks and unrelated repository contents are intentionally unsupported.

Offline writing continues normally. Retry sync after reconnecting. A failure never force-pushes, resets your history or discards a committed local entry.

### Concurrent edits and conflicts

Encrypted files cannot be text-merged. Different nonconflicting files can merge normally, but editing the same daily entry on two devices can create a conflict. Still stops, aborts the attempted merge and preserves the local commit and fetched remote branch rather than guessing which diary is correct.

<details>
<summary>Advanced: inspect and reconcile conflicting versions without discarding either copy</summary>

To inspect both versions safely, keep the original diary intact and create two detached worktree copies. Replace `main` if your diary uses a different branch and use new, unused destination directories:

```powershell
Set-Location -LiteralPath 'C:\Diaries\Personal'
git status
git worktree add --detach "$HOME\Documents\Diary-local-copy" HEAD
git worktree add --detach "$HOME\Documents\Diary-remote-copy" origin/main
```

Lock Still and open each copy separately to review it with your passphrase. Detached copies are for inspection, not sync. **Opening a copy may create today's blank entry locally.** Preserve these copies until reconciliation is finished.

Reconciliation currently requires a deliberate Git merge by someone familiar with Git: select the desired encrypted file version for each conflict, open the merged working copy in Still to combine any text you wish to retain, stage the resolved schema files, and finish the merge commit before syncing again. Metadata (`diary.json`) conflicts are especially sensitive: preserve the version corresponding to the intended passphrase/recovery wrappers. Do not attempt to merge JSON inside ciphertext, delete one version without a backup, or use force-push/hard-reset as a shortcut.

</details>

## Recovery and privacy

The app generates a random 256-bit master key. AES-256-GCM protects entries and assets with authenticated, purpose-specific associated data. A scrypt-derived key wraps the master key for passphrase access. An independent randomly generated recovery key wraps the same master key.

Recovering the diary:

1. Choose **Forgot your passphrase?**.
2. Enter your saved recovery key and choose a new passphrase.
3. Save the newly generated recovery key. The previous key no longer opens the current metadata.
4. Sync the changed metadata when ready, and use the new passphrase on other devices after they receive it.

Recovery changes the key wrappers, not the master key. **Someone who has an old recovery key and old Git history, or already has the master key, may still decrypt the diary.** Resetting a passphrase cannot revoke that access or erase downloaded history. There is no recovery email, administrator reset or hidden backdoor. If both your passphrase and recovery key are lost, the contents are unrecoverable.

Encryption protects content, not every detail. GitHub and someone with file access can see entry dates, paths, approximate sizes and commit times. The app holds plaintext in memory while unlocked. It does not protect against malware, a compromised OS, screen capture, copied text, memory dumps or OS swap. Key buffers are cleared on lock, but JavaScript strings and operating-system caches cannot be guaranteed securely erased. Spelling services, remote fonts and telemetry are disabled/not included.

This is a working initial implementation, not an independently audited encryption product. Maintain backups of the repository and recovery key before relying on it for irreplaceable material.

## Repository schema

```text
diary.json                          versioned metadata, KDF and wrapped keys
entries\
  2026\
    09\
      2026-09-18.entry               authenticated encrypted entry envelope
assets\
  <random-uuid>.asset                authenticated encrypted image envelope
.git\                               normal Git history
```

Inside an encrypted entry: the local calendar date, optional title, Tiptap JSON document, creation timestamp and modification timestamp. Inside an encrypted asset: its supported MIME type and image data. Inline image references use `diary-asset://vault/<uuid>`; Electron decrypts those images through a restricted local protocol, without writing plaintext image files.

<details>
<summary>Version 1 metadata and encryption envelope</summary>

`diary.json` contains `version: 1`, a lowercase UUIDv4 `diaryId`, `kdf`, `passphraseWrap`, and `recoveryWrap`. The fixed scrypt KDF uses a random 32-byte base64 salt, `N: 32768`, `r: 8`, `p: 1`, and `maxmem: 67108864`.

Each wrapped key, entry and asset uses an envelope with these fields:

```json
{
  "version": 1,
  "algorithm": "aes-256-gcm",
  "iv": "<12 random bytes, base64>",
  "tag": "<16-byte authentication tag, base64>",
  "ciphertext": "<encrypted bytes, base64>"
}
```

Authenticated associated data binds each envelope to its diary ID, purpose and logical path: UTF-8 `JSON.stringify(["still-diary", 1, diaryId, purpose, logicalPath])`. Purposes are `passphrase-wrap`, `recovery-wrap`, `entry`, and `asset`. Key wrappers use `diary.json` as their logical path. Both wrappers protect the same random 32-byte master key. `SDRK1` emergency recovery keys contain grouped random hexadecimal data and a checksum.

The 20 MB image upload limit is for the original file; base64 encoding and encryption envelopes increase the stored size to approximately 35.6 MB at that limit.

</details>

The app uses a ciphertext revision to reject stale writes, authenticated encryption to detect tampering and atomic file replacement for saves. Schema, dates, paths, rich-text nodes, image types and input sizes are validated. Symlink descendants and arbitrary remote assets are rejected.

Local application preferences store only the diary directory, theme and sync interval in Electron's per-user application-data directory. Passwords, recovery keys and decrypted entries are not stored in preferences or browser local storage.

Keep all other files out of the data repository. App source code and its MIT license belong in a separate repository if you choose to publish it.

## Development

```powershell
npm run typecheck
npm test
npm run test:e2e
npm run pack
```

Unit tests cover encryption, recovery, storage validation, sync guards and autosave ordering. Electron end-to-end tests use temporary diary directories and isolated application profiles; they exercise real desktop creation, editing, image loading, restart, recovery and close-time saving without contacting GitHub.

```text
electron\         trusted main process, restricted preload, vault and Git sync
shared\           typed IPC contracts and calendar helpers
src\              React UI and rich-text editor
tests\            unit and local Git integration tests
e2e\              real Electron workflow tests
```

The renderer has no Node.js integration. It communicates through narrowly scoped preload methods; main-process IPC verifies the sender and serializes storage operations with sync. External navigation, window creation, webviews and permission prompts are denied. The app loads no remote application code.

## CI/CD and releases

The [CI and release workflow](https://github.com/adityagesh/still-diary/actions/workflows/ci-release.yml) runs on pull requests, pushes to `main`, and version tags. Each Windows/Linux job installs locked dependencies, checks that no diary data is tracked, runs unit and desktop tests, and builds its native packages.

<details>
<summary>Maintainers: publish a new release</summary>

Update `package.json` and `package-lock.json` to the new version, update the direct-download links here and in the root README, and commit those changes. Push a matching version tag, for example:

```powershell
git tag v0.1.1
git push origin main v0.1.1
```

The tag must exactly match the package version. A release is published only after **both** platform jobs pass and all three expected downloads are present. The final job computes SHA-256 checksums, uploads a draft release, then publishes it. Build jobs have read-only repository access; only the publishing job receives `contents: write`. No personal access token or signing secret is stored in this repository.

Published releases are not silently overwritten on rerun. If a publishing attempt leaves a draft, review that draft and its assets before retrying. Prefer a new version tag for changes to an already published release.

</details>
