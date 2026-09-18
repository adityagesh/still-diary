import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let application: ElectronApplication;
let root: string;
let vaultFolder: string;
let profile: string;

async function launch(): Promise<Page> {
  application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, STILL_E2E: '1', STILL_USER_DATA: profile, ELECTRON_DEV: '0' },
  });
  const page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return page;
}

async function setPicker(folder: string) {
  await application.evaluate(({ dialog }, value) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [value] });
  }, folder);
}

async function storedToday(page: Page) {
  return page.evaluate(async () => {
    const result = await window.diary!.session();
    if (!result.ok) throw new Error(result.error);
    return result.value.today;
  });
}

test.beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'still-e2e-'));
  vaultFolder = path.join(root, 'vault');
  profile = path.join(root, 'profile');
  await mkdir(vaultFolder);
  await mkdir(profile);
});

test.afterEach(async () => {
  if (application && application.process().exitCode === null) {
    await application.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
    });
    await application.close();
  }
  await rm(root, { recursive: true, force: true });
});

test('creates an encrypted diary, autosaves formatting and images, restores and recovers it', async () => {
  let page = await launch();
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await expect(page.getByRole('heading', { name: 'A place just for you.' })).toBeVisible();
  await page.getByRole('button', { name: 'Create a diary', exact: true }).click();
  await setPicker(vaultFolder);
  await page.getByRole('button', { name: 'Choose an empty folder' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByLabel('Encryption passphrase', { exact: true }).fill('test-only memorable diary phrase');
  await page.getByLabel('Confirm passphrase').fill('test-only memorable diary phrase');
  await page.getByRole('button', { name: 'Create encrypted diary' }).click();
  const recoveryKey = await page.getByTestId('recovery-key').innerText();
  expect(recoveryKey.length).toBeGreaterThan(40);
  await expect(page.getByTestId('recovery-warning')).toContainText('There is no email reset, support override, or other recovery method.');
  await expect(page.getByRole('button', { name: 'Open my diary' })).toBeDisabled();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Open my diary' }).click();
  await expect(page.getByRole('dialog', { name: 'Set up your private backup' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Install Git', exact: true })).not.toBeVisible();
  await page.locator('.setup-step > summary').filter({ hasText: 'Install' }).click();
  await expect(page.getByRole('button', { name: 'Install Git', exact: true })).toBeVisible();
  await page.getByRole('button', { name: "I'll set this up later" }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByLabel('Entry title').fill('A small beginning');
  const body = page.getByRole('textbox', { name: 'Diary entry', exact: true });
  await body.pressSequentially('Today I made a little space for reflection.');
  await body.press('End');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(body).toBeFocused();
  await page.keyboard.type(' A thought worth keeping.');
  await expect(page.locator('.diary-prose strong')).toContainText('A thought worth keeping.');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByLabel('Font size').selectOption('22px');
  await page.getByLabel('Text color').selectOption('var(--cp-accent)');
  await expect(body).toBeFocused();
  await page.keyboard.type(' A bright moment.');
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  expect((await storedToday(page)).title).toBe('A small beginning');

  const imagePath = path.join(root, 'pixel.png');
  await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'));
  await setPicker(imagePath);
  await page.getByRole('button', { name: 'Add image' }).click();
  await expect(page.locator('.diary-prose img')).toBeVisible();
  await expect.poll(() => page.locator('.diary-prose img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: "Today's page" }).click();
  await expect(page.getByRole('navigation', { name: 'Diary entries' }).getByRole('button')).toHaveCount(1);
  await expect(page.getByLabel('Entry title')).toHaveValue('A small beginning');
  await page.screenshot({ path: 'test-results/diary-dark.png', fullPage: true });
  await page.getByRole('button', { name: 'Toggle light or dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: 'test-results/diary-light.png', fullPage: true });
  await page.getByRole('button', { name: 'Lock diary' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.getByLabel('Encryption passphrase', { exact: true }).fill('incorrect passphrase');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();

  await application.close();
  page = await launch();
  await page.getByLabel('Encryption passphrase', { exact: true }).fill('test-only memorable diary phrase');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Entry title')).toBeVisible();
  expect((await storedToday(page)).title).toBe('A small beginning');
  await expect(page.getByLabel('Entry title')).toHaveValue('A small beginning');
  await expect(page.locator('.diary-prose')).toContainText('A thought worth keeping.');
  await expect(page.locator('.diary-prose strong')).toContainText('A thought worth keeping.');
  await expect(page.locator('.diary-prose img')).toBeVisible();
  await page.getByRole('button', { name: 'Lock diary' }).click();
  await page.getByRole('button', { name: 'Forgot your passphrase?' }).click();
  await page.getByLabel('Recovery key', { exact: true }).fill(recoveryKey);
  await page.getByLabel('New encryption passphrase', { exact: true }).fill('replacement test-only passphrase');
  await page.getByLabel('Confirm passphrase').fill('replacement test-only passphrase');
  await page.getByRole('button', { name: 'Reset passphrase' }).click();
  const nextRecoveryKey = await page.getByTestId('recovery-key').innerText();
  expect(nextRecoveryKey).not.toBe(recoveryKey);
  await expect(page.getByTestId('recovery-warning')).toBeVisible();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Open my diary' }).click();
  await expect(page.getByLabel('Entry title')).toHaveValue('A small beginning');
  await page.getByRole('button', { name: 'Lock diary' }).click();
  await page.getByLabel('Encryption passphrase', { exact: true }).fill('replacement test-only passphrase');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Entry title')).toHaveValue('A small beginning');
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await expect(page.locator('.sync-detail')).toContainText(/Git|repository|repo/i);

  for (const file of await readdir(vaultFolder, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    const data = await readFile(path.join(file.parentPath, file.name), 'utf8');
    expect(data).not.toContain('A small beginning');
    expect(data).not.toContain('Today I made');
    expect(data).not.toContain('replacement test-only passphrase');
    expect(data).not.toContain(recoveryKey);
  }
  expect(consoleErrors).toEqual([]);
});

test('flushes the final keystroke on window close and locks on restart', async () => {
  let page = await launch();
  await page.getByRole('button', { name: 'Create a diary', exact: true }).click();
  await setPicker(vaultFolder);
  await page.getByRole('button', { name: 'Choose an empty folder' }).click();
  await page.getByLabel('Encryption passphrase', { exact: true }).fill('close-test long passphrase');
  await page.getByLabel('Confirm passphrase').fill('close-test long passphrase');
  await page.getByRole('button', { name: 'Create encrypted diary' }).click();
  await expect(page.getByTestId('recovery-warning')).toContainText('It is your only way to recover a forgotten passphrase.');
  await expect(page.getByRole('button', { name: 'Open my diary' })).toBeDisabled();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Open my diary' }).click();
  await page.getByRole('button', { name: "I'll set this up later" }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Diary entry', exact: true }).pressSequentially('These final words must survive.');
  await expect(page.locator('.footer-left')).toContainText('5 words');
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  await application.waitForEvent('close');
  page = await launch();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.getByLabel('Encryption passphrase', { exact: true }).fill('close-test long passphrase');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Diary entry', exact: true })).toContainText('These final words must survive.');
});
