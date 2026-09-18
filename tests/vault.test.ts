import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getAttributesFromExtensions, getSchema } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { Color, FontSize, TextStyle } from '@tiptap/extension-text-style';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultStore, validateDocument } from '../electron/vault';
import { decrypt, derivePassphraseKey, encrypt } from '../electron/crypto';
import { EMPTY_DOCUMENT, localDate, type RichDocument } from '../shared/types';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) };
});

const PASSWORD = 'correct horse battery diary';
const NEW_PASSWORD = 'my replacement diary passphrase';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5b8AAAAASUVORK5CYII=', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const WEBP = Buffer.from('UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAA=', 'base64');
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x7f, 0xff, 0xd9,
]);

let sandbox: string;
let directory: string;
let vault: VaultStore;
const stores: VaultStore[] = [];

function anotherStore(folder = directory): VaultStore {
  const store = new VaultStore(folder);
  stores.push(store);
  return store;
}

function filename(date: string): string {
  return path.join(directory, 'entries', date.slice(0, 4), date.slice(5, 7), `${date}.entry`);
}

async function json(file: string): Promise<any> {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function document(text: string): RichDocument {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

async function recursiveFiles(folder: string): Promise<string[]> {
  const children = await fs.readdir(folder, { withFileTypes: true });
  return (await Promise.all(children.map(async child => {
    const name = path.join(folder, child.name);
    return child.isDirectory() ? recursiveFiles(name) : [name];
  }))).flat();
}

async function rewriteAuthenticatedEntry(date: string, update: (value: any) => void): Promise<void> {
  const metadata = await json(path.join(directory, 'diary.json'));
  const passwordKey = await derivePassphraseKey(PASSWORD, metadata.kdf);
  const master = decrypt(passwordKey, metadata.passphraseWrap, metadata.diaryId, 'passphrase-wrap', 'diary.json', 32);
  const logicalPath = `entries/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.entry`;
  const plaintext = decrypt(master, await json(filename(date)), metadata.diaryId, 'entry', logicalPath, 2 * 1024 * 1024);
  let changed: Buffer | undefined;
  try {
    const entry = JSON.parse(plaintext.toString('utf8'));
    update(entry);
    changed = Buffer.from(JSON.stringify(entry));
    const envelope = encrypt(master, changed, metadata.diaryId, 'entry', logicalPath);
    await fs.writeFile(filename(date), JSON.stringify(envelope));
  } finally {
    passwordKey.fill(0);
    master.fill(0);
    plaintext.fill(0);
    changed?.fill(0);
  }
}

beforeEach(async () => {
  sandbox = path.join(process.cwd(), `.vault-test-${randomUUID()}`);
  directory = path.join(sandbox, 'vault');
  await fs.mkdir(sandbox);
  vault = anotherStore();
});

afterEach(async () => {
  for (const store of stores.splice(0)) store.lock();
  vi.restoreAllMocks();
  vi.mocked(fs.rename).mockReset();
  vi.mocked(fs.open).mockReset();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(fs.rename).mockImplementation(actual.rename);
  vi.mocked(fs.open).mockImplementation(actual.open);
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe('vault lifecycle and recovery', () => {
  it('creates in an empty folder, persists only wrapped keys, and reopens after locking', async () => {
    expect(await vault.exists()).toBe(false);
    expect(vault.isUnlocked).toBe(false);
    const { recoveryKey } = await vault.create(PASSWORD);
    expect(vault.isUnlocked).toBe(true);
    expect(await vault.exists()).toBe(true);
    const metadata = await json(path.join(directory, 'diary.json'));
    expect(metadata).toMatchObject({ version: 1, kdf: { name: 'scrypt', N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } });
    expect(metadata.diaryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(metadata.passphraseWrap.ciphertext).not.toEqual(metadata.recoveryWrap.ciphertext);
    const persisted = JSON.stringify(metadata);
    expect(persisted).not.toContain(PASSWORD);
    expect(persisted).not.toContain(recoveryKey);
    expect(persisted).not.toContain(recoveryKey.split('-').slice(1, 9).join(''));
    vault.lock();
    const reopened = anotherStore();
    await reopened.unlock(PASSWORD);
    expect(reopened.isUnlocked).toBe(true);
    expect(await reopened.listEntries()).toEqual([]);
  });

  it('permits a .git-only folder, but never overwrites an existing diary or other files', async () => {
    await fs.mkdir(path.join(directory, '.git'), { recursive: true });
    await fs.writeFile(path.join(directory, '.git', 'config'), 'git settings');
    await vault.create(PASSWORD);
    const before = await fs.readFile(path.join(directory, 'diary.json'));
    await expect(vault.create(PASSWORD)).rejects.toThrow(/empty/);
    expect(await fs.readFile(path.join(directory, 'diary.json'))).toEqual(before);
    const other = path.join(sandbox, 'nonempty');
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, 'precious.txt'), 'keep me');
    await expect(anotherStore(other).create(PASSWORD)).rejects.toThrow(/empty/);
    expect(await fs.readFile(path.join(other, 'precious.txt'), 'utf8')).toBe('keep me');
    expect(await fs.readdir(other)).toEqual(['precious.txt']);
  });

  it('rejects a short or huge passphrase without creating metadata', async () => {
    await expect(vault.create('short')).rejects.toThrow(/12/);
    await expect(vault.create('a'.repeat(1025))).rejects.toThrow(/1024/);
    expect(await vault.exists()).toBe(false);
    expect(vault.isUnlocked).toBe(false);
  });

  it('wrong passphrases clear the session, and all content operations require unlock', async () => {
    await vault.create(PASSWORD);
    const key = (vault as unknown as { masterKey: Buffer }).masterKey;
    await expect(vault.unlock('wrong but sufficiently long')).rejects.toThrow(/Authentication/);
    expect(vault.isUnlocked).toBe(false);
    expect(key.every(byte => byte === 0)).toBe(true);
    await expect(vault.listEntries()).rejects.toThrow(/locked/);
    await expect(vault.readEntry('2026-09-18')).rejects.toThrow(/locked/);
    await expect(vault.ensureToday()).rejects.toThrow(/locked/);
    await expect(vault.saveEntry({ date: '2026-09-18', title: '', document: EMPTY_DOCUMENT, expectedRevision: '0'.repeat(64) })).rejects.toThrow(/locked/);
    await expect(vault.addImage(PNG, 'image.png')).rejects.toThrow(/locked/);
    await expect(vault.readImage(randomUUID())).rejects.toThrow(/locked/);
    await vault.unlock(PASSWORD);
    const nextKey = (vault as unknown as { masterKey: Buffer }).masterKey;
    vault.lock();
    vault.lock();
    expect(nextKey.every(byte => byte === 0)).toBe(true);
  });

  it('recovery rotates both wrappers and salt, retains content, and invalidates old credentials', async () => {
    const first = await vault.create(PASSWORD);
    const entry = await vault.ensureToday(new Date(2026, 8, 18));
    const saved = await vault.saveEntry({
      date: entry.date, title: 'my private thought', document: document('still here'), expectedRevision: entry.revision,
    });
    const image = await vault.addImage(PNG, 'image.png');
    const before = await json(path.join(directory, 'diary.json'));
    const entryBefore = await fs.readFile(filename(entry.date));
    vault.lock();
    const second = await vault.recover(first.recoveryKey, NEW_PASSWORD);
    expect(second.recoveryKey).not.toBe(first.recoveryKey);
    expect(vault.isUnlocked).toBe(true);
    const after = await json(path.join(directory, 'diary.json'));
    expect(after.diaryId).toBe(before.diaryId);
    expect(after.kdf.salt).not.toBe(before.kdf.salt);
    expect(after.passphraseWrap).not.toEqual(before.passphraseWrap);
    expect(after.recoveryWrap).not.toEqual(before.recoveryWrap);
    expect(await fs.readFile(filename(entry.date))).toEqual(entryBefore);
    expect(await vault.readEntry(entry.date)).toEqual(saved);
    expect((await vault.readImage(image.id)).data).toEqual(PNG);
    await expect(vault.unlock(PASSWORD)).rejects.toThrow(/Authentication/);
    await expect(vault.recover(first.recoveryKey, PASSWORD)).rejects.toThrow(/Authentication/);
    expect(vault.isUnlocked).toBe(false);
    await vault.unlock(NEW_PASSWORD);
    const third = await vault.recover(second.recoveryKey, PASSWORD);
    expect(third.recoveryKey).not.toBe(second.recoveryKey);
    expect((await vault.readEntry(entry.date)).title).toBe(saved.title);
  });

  it('failed recovery leaves metadata intact and the vault locked', async () => {
    const created = await vault.create(PASSWORD);
    const before = await fs.readFile(path.join(directory, 'diary.json'));
    await expect(vault.recover(created.recoveryKey, 'short')).rejects.toThrow(/12/);
    await expect(vault.recover('not a key', NEW_PASSWORD)).rejects.toThrow(/Recovery/);
    expect(await fs.readFile(path.join(directory, 'diary.json'))).toEqual(before);
    expect(vault.isUnlocked).toBe(false);
  });

  it('cannot finish unlocking after a concurrent lock request', async () => {
    await vault.create(PASSWORD);
    vault.lock();
    const pending = vault.unlock(PASSWORD);
    vault.lock();
    await expect(pending).rejects.toThrow(/locked while/);
    expect(vault.isUnlocked).toBe(false);
  });

  it.each([
    ['version', 2], ['diaryId', '../invalid'], ['unexpected', 'value'],
  ])('rejects invalid metadata %s', async (field, value) => {
    await vault.create(PASSWORD);
    const metadata = await json(path.join(directory, 'diary.json'));
    metadata[field] = value;
    await fs.writeFile(path.join(directory, 'diary.json'), JSON.stringify(metadata));
    await expect(vault.unlock(PASSWORD)).rejects.toThrow();
    expect(vault.isUnlocked).toBe(false);
  });

  it('refuses malicious KDF costs and authenticated diary identity substitution', async () => {
    await vault.create(PASSWORD);
    const file = path.join(directory, 'diary.json');
    const metadata = await json(file);
    await fs.writeFile(file, JSON.stringify({ ...metadata, kdf: { ...metadata.kdf, N: 2 ** 30 } }));
    await expect(vault.unlock(PASSWORD)).rejects.toThrow(/KDF/);
    await fs.writeFile(file, JSON.stringify({ ...metadata, diaryId: randomUUID() }));
    await expect(vault.unlock(PASSWORD)).rejects.toThrow(/Authentication/);
    await fs.writeFile(file, JSON.stringify({ ...metadata, passphraseWrap: metadata.recoveryWrap }));
    await expect(vault.unlock(PASSWORD)).rejects.toThrow(/Authentication/);
  });
});

describe('encrypted diary entries', () => {
  it('creates one blank entry per local day, never resets it, and lists newest-first previews', async () => {
    await vault.create(PASSWORD);
    const now = new Date(2026, 8, 18, 23, 58);
    const first = await vault.ensureToday(now);
    expect(first.date).toBe(localDate(now));
    expect(first.document).toEqual(EMPTY_DOCUMENT);
    const saved = await vault.saveEntry({ date: first.date, title: 'A title', document: document('The only decrypted preview'), expectedRevision: first.revision });
    expect(await vault.ensureToday(now)).toEqual(saved);
    expect(await vault.ensureToday(new Date(2026, 8, 18, 0, 1))).toEqual(saved);
    const next = await vault.ensureToday(new Date(2026, 8, 19));
    const summaries = await vault.listEntries();
    expect(summaries.map(summary => summary.date)).toEqual([next.date, first.date]);
    expect(summaries[1]).toMatchObject({ title: 'A title', preview: 'The only decrypted preview', revision: saved.revision });
    expect(summaries[1]).not.toHaveProperty('document');
  });

  it('does not leave titles, entry text, images, or original filenames in any persisted file', async () => {
    const { recoveryKey } = await vault.create(PASSWORD);
    const entry = await vault.ensureToday();
    await vault.saveEntry({ date: entry.date, title: 'UNIQUE SECRET TITLE', document: document('UNIQUE SECRET BODY'), expectedRevision: entry.revision });
    const image = await vault.addImage(PNG, 'sensitive-person-name.png');
    const files = await recursiveFiles(directory);
    expect(files.some(file => file.endsWith(`${image.id}.asset`))).toBe(true);
    for (const file of files) {
      const bytes = await fs.readFile(file);
      const text = bytes.toString('utf8');
      for (const secret of [PASSWORD, recoveryKey, 'UNIQUE SECRET TITLE', 'UNIQUE SECRET BODY', 'sensitive-person-name', PNG.toString('base64')]) {
        expect(text).not.toContain(secret);
      }
      expect(bytes.indexOf(PNG)).toBe(-1);
      expect(file).not.toContain('sensitive-person-name');
      expect(file).not.toMatch(/\.tmp$/);
    }
  });

  it('requires exact current revisions and preserves the newer content on stale writes', async () => {
    await vault.create(PASSWORD);
    const original = await vault.ensureToday();
    const input = { date: original.date, title: 'first save', document: document('first version'), expectedRevision: original.revision };
    const saved = await vault.saveEntry(input);
    expect(saved.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.revision).not.toBe(original.revision);
    expect(saved.createdAt).toBe(original.createdAt);
    expect(saved.updatedAt > original.updatedAt).toBe(true);
    await expect(vault.saveEntry({ ...input, title: 'stale save' })).rejects.toThrow(/changed since/);
    expect(await vault.readEntry(original.date)).toEqual(saved);
    await expect(vault.saveEntry({ ...input, expectedRevision: '' })).rejects.toThrow(/expectedRevision/);
    await expect(vault.saveEntry({ ...input, title: 'a'.repeat(257) })).rejects.toThrow(/256/);
    await expect(vault.saveEntry({ ...input, extra: 'disallowed' } as any)).rejects.toThrow(/fields/);
  });

  it.each(['../2026-09-18', '2026-02-29', '2026-04-31', '2026-00-01', '2026-13-01', '2026-01-00', '0000-01-01', '2026-9-18', '2026-09-18\\file'])('rejects unsafe or impossible date %s', async (date) => {
    await vault.create(PASSWORD);
    await expect(vault.readEntry(date)).rejects.toThrow(/date|calendar|YYYY/);
    await expect(vault.saveEntry({ date, title: '', document: EMPTY_DOCUMENT, expectedRevision: '0'.repeat(64) })).rejects.toThrow(/date|calendar|YYYY/);
  });

  it('accepts real leap dates and rejects an invalid Date', async () => {
    await vault.create(PASSWORD);
    expect((await vault.ensureToday(new Date(2024, 1, 29))).date).toBe('2024-02-29');
    expect((await vault.ensureToday(new Date(2000, 1, 29))).date).toBe('2000-02-29');
    await expect(vault.readEntry('1900-02-29')).rejects.toThrow(/calendar/);
    await expect(vault.ensureToday(new Date('invalid'))).rejects.toThrow(/valid local date/);
  });

  it('rejects ciphertext tampering and never replaces a corrupted current-day entry', async () => {
    await vault.create(PASSWORD);
    const day = new Date(2026, 8, 18);
    const entry = await vault.ensureToday(day);
    const envelope = await json(filename(entry.date));
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    ciphertext[0] ^= 1;
    envelope.ciphertext = ciphertext.toString('base64');
    const changed = JSON.stringify(envelope);
    await fs.writeFile(filename(entry.date), changed);
    await expect(vault.readEntry(entry.date)).rejects.toThrow(/Authentication/);
    await expect(vault.ensureToday(day)).rejects.toThrow(/Authentication/);
    await expect(vault.listEntries()).rejects.toThrow(/Authentication/);
    expect(await fs.readFile(filename(entry.date), 'utf8')).toEqual(changed);
  });

  it('binds entries to their date paths and diary identity', async () => {
    await vault.create(PASSWORD);
    const first = await vault.ensureToday(new Date(2026, 8, 18));
    const second = await vault.ensureToday(new Date(2026, 8, 19));
    await fs.copyFile(filename(first.date), filename(second.date));
    await expect(vault.readEntry(second.date)).rejects.toThrow(/Authentication/);
    const secondDirectory = path.join(sandbox, 'other-vault');
    const other = anotherStore(secondDirectory);
    await other.create(PASSWORD);
    await other.ensureToday(new Date(2026, 8, 18));
    await fs.copyFile(filename(first.date), path.join(secondDirectory, 'entries', '2026', '09', `${first.date}.entry`));
    await expect(other.readEntry(first.date)).rejects.toThrow(/Authentication/);
  });

  it.each([
    (entry: any) => { entry.version = 2; },
    (entry: any) => { entry.date = '2026-09-19'; },
    (entry: any) => { entry.updatedAt = 'not a timestamp'; },
    (entry: any) => { entry.createdAt = '9999-12-31T23:59:59.999Z'; },
    (entry: any) => { entry.document = { type: 'doc', content: [{ type: 'script', text: 'bad' }] }; },
    (entry: any) => { entry.extra = 'not supported'; },
  ])('validates the serialized document even after successful decryption', async (update) => {
    await vault.create(PASSWORD);
    const entry = await vault.ensureToday(new Date(2026, 8, 18));
    await rewriteAuthenticatedEntry(entry.date, update);
    await expect(vault.readEntry(entry.date)).rejects.toThrow();
  });

  it('rejects invalid JSON and oversized files rather than silently ignoring them', async () => {
    await vault.create(PASSWORD);
    const entry = await vault.ensureToday();
    await fs.writeFile(filename(entry.date), 'not json');
    await expect(vault.readEntry(entry.date)).rejects.toThrow(/JSON/);
    await fs.writeFile(filename(entry.date), Buffer.alloc(3 * 1024 * 1024));
    await expect(vault.readEntry(entry.date)).rejects.toThrow(/size limit/);
    await fs.writeFile(path.join(directory, 'diary.json'), Buffer.alloc(17 * 1024));
    await expect(vault.unlock(PASSWORD)).rejects.toThrow(/size limit/);
  });
});

describe('rich document validation', () => {
  it('round trips empty style attributes emitted by actual Tiptap HTML attribute parsers', async () => {
    const extensions = [StarterKit.configure({ link: false }), TextStyle, Color, FontSize];
    const schema = getSchema(extensions);
    const attributes = getAttributesFromExtensions([TextStyle, Color, FontSize]);
    const parseMark = (inlineStyle: string, color: string, fontSize: string) => {
      const element = {
        getAttribute: (name: string) => name === 'style' ? inlineStyle : null,
        style: { color, fontSize },
      } as unknown as HTMLElement;
      return schema.marks.textStyle.create(Object.fromEntries(attributes.map(attribute => [
        attribute.name, attribute.attribute.parseHTML!(element),
      ])));
    };
    const sizeOnly = parseMark('font-size: 22px;', '', '22px');
    const colorOnly = parseMark('color: var(--cp-accent);', 'var(--cp-accent)', '');
    expect(sizeOnly.toJSON()).toEqual({ type: 'textStyle', attrs: { color: '', fontSize: '22px' } });
    expect(colorOnly.toJSON()).toEqual({ type: 'textStyle', attrs: { color: 'var(--cp-accent)', fontSize: '' } });
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text('Parsed font size', [sizeOnly]),
        schema.text('Parsed color', [colorOnly]),
      ]),
    ]).toJSON() as RichDocument;
    await vault.create(PASSWORD);
    const entry = await vault.ensureToday();
    await vault.saveEntry({ date: entry.date, title: '', document: doc, expectedRevision: entry.revision });
    vault.lock();
    await vault.unlock(PASSWORD);
    expect((await vault.readEntry(entry.date)).document).toEqual(doc);
  });

  it('round trips real Tiptap textStyle marks with null color and fontSize defaults', async () => {
    const schema = getSchema([StarterKit.configure({ link: false }), TextStyle, Color, FontSize]);
    const sizeOnly = schema.marks.textStyle.create({ fontSize: '22px' });
    const colorOnly = schema.marks.textStyle.create({ color: 'var(--cp-accent)' });
    const defaults = schema.marks.textStyle.create();
    expect(sizeOnly.toJSON()).toEqual({ type: 'textStyle', attrs: { color: null, fontSize: '22px' } });
    expect(colorOnly.toJSON()).toEqual({ type: 'textStyle', attrs: { color: 'var(--cp-accent)', fontSize: null } });
    expect(defaults.toJSON()).toEqual({ type: 'textStyle', attrs: { color: null, fontSize: null } });
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text('Size only', [sizeOnly]),
        schema.text('Color only', [colorOnly]),
        schema.text('Default attributes', [defaults]),
        schema.text('Bold, size, and color', [
          schema.marks.bold.create(),
          schema.marks.textStyle.create({ color: 'var(--cp-accent)', fontSize: '28px' }),
        ]),
      ]),
    ]).toJSON() as RichDocument;
    await vault.create(PASSWORD);
    const entry = await vault.ensureToday();
    await vault.saveEntry({ date: entry.date, title: '', document: doc, expectedRevision: entry.revision });
    vault.lock();
    await vault.unlock(PASSWORD);
    expect((await vault.readEntry(entry.date)).document).toEqual(doc);
  });

  it('accepts installed Tiptap v3 default paragraph, heading, and image attributes', () => {
    const schema = getSchema([StarterKit.configure({ link: false }), Image]);
    const paragraph = schema.nodes.paragraph.create();
    const heading = schema.nodes.heading.create();
    const source = `diary-asset://vault/${randomUUID()}`;
    const image = schema.nodes.image.create({ src: source });
    expect(paragraph.toJSON()).toEqual({ type: 'paragraph' });
    expect(heading.toJSON()).toEqual({ type: 'heading', attrs: { level: 1 } });
    expect(image.toJSON()).toEqual({
      type: 'image', attrs: { src: source, alt: null, title: null, width: null, height: null },
    });
    expect(schema.marks.underline).toBeDefined();
    expect(schema.marks.link).toBeUndefined();
    expect(() => validateDocument(schema.nodes.doc.create(null, [paragraph, heading, image]).toJSON())).not.toThrow();
    const resizedImage = schema.nodes.image.create({ src: source, width: 320, height: 200, alt: 'private', title: 'Image' });
    expect(() => validateDocument(schema.nodes.doc.create(null, [resizedImage]).toJSON())).not.toThrow();
  });

  it('round trips every approved semantic color and editor font size through encrypted storage', async () => {
    await vault.create(PASSWORD);
    const entry = await vault.ensureToday();
    const colors = ['var(--cp-text)', 'var(--cp-text-muted)', 'var(--cp-accent)', 'var(--cp-link)'];
    const fontSizes = ['16px', '18px', '22px', '28px'];
    const doc: RichDocument = {
      type: 'doc',
      content: colors.flatMap(color => fontSizes.map(fontSize => ({
        type: 'paragraph',
        content: [{
          type: 'text', text: 'Semantic formatting',
          marks: [{ type: 'textStyle', attrs: { color, fontSize } }, { type: 'underline' }],
        }],
      }))),
    };
    await vault.saveEntry({ date: entry.date, title: '', document: doc, expectedRevision: entry.revision });
    vault.lock();
    await vault.unlock(PASSWORD);
    expect((await vault.readEntry(entry.date)).document).toEqual(doc);
  });

  it('rejects arbitrary CSS variables, fallbacks, and injected declarations', () => {
    for (const color of [
      'var(--unknown)', 'var(--cp-text, red)', 'var(--cp-text, url(x))',
      'var(--cp-text);color:red', 'var(--cp-accent);background:url(x)',
      'var( --cp-text )', 'VAR(--cp-text)', 'var(--cp-link) extra',
    ]) {
      const doc: RichDocument = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{
            type: 'text', text: 'Untrusted styling', marks: [{ type: 'textStyle', attrs: { color } }],
          }],
        }],
      };
      expect(() => validateDocument(doc)).toThrow(/text color/);
    }
  });

  it('accepts the allowed Tiptap structures, formatting, and only local images', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Heading' }] },
        { type: 'paragraph', content: [
          { type: 'text', text: 'formatted', marks: [
            ...['bold', 'italic', 'underline', 'strike', 'code'].map(type => ({ type })),
            { type: 'textStyle', attrs: { color: '#1133FF', fontSize: '18px' } },
          ] },
          { type: 'hardBreak' },
        ] },
        { type: 'orderedList', attrs: { start: 1, type: null }, content: [
          { type: 'listItem', content: [{ type: 'paragraph' }] },
        ] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
        { type: 'blockquote', content: [{ type: 'paragraph' }] },
        { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: 'const a = 1;' }] },
        { type: 'horizontalRule' },
        { type: 'image', attrs: { src: `diary-asset://vault/${randomUUID()}`, alt: 'private', title: null } },
      ],
    };
    expect(() => validateDocument(doc)).not.toThrow();
  });

  it.each([
    { type: 'doc', content: [{ type: 'image', attrs: { src: 'https://tracker.example/image.png' } }] },
    { type: 'doc', content: [{ type: 'image', attrs: { src: 'file:///private/image.png' } }] },
    { type: 'doc', content: [{ type: 'image', attrs: { src: 'data:image/svg+xml,<svg/>' } }] },
    { type: 'doc', content: [{ type: 'image', attrs: { src: 'diary-asset://vault/../secret' } }] },
    { type: 'doc', content: [{ type: 'image', attrs: { src: `diary-asset://vault/${randomUUID()}?query=1` } }] },
    { type: 'doc', content: [{ type: 'paragraph', attrs: { onclick: 'doSomething()' } }] },
    { type: 'doc', content: [{ type: 'heading', attrs: { level: 7 } }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:bad' } }] }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'textStyle', attrs: { color: 'url(https://tracker)' } }] }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'textStyle', attrs: { fontSize: '12px; background:url(x)' } }] }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'textStyle', attrs: { color: 'rgb(300,0,0)' } }] }] }] },
    { type: 'doc', content: [{ type: 'text', text: 'not a block' }] },
    { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'paragraph' }] }] },
    { type: 'doc', content: [{ type: 'orderedList', content: [] }] },
    { type: 'doc', content: [] },
  ])('rejects untrusted rich content %#', (doc) => {
    expect(() => validateDocument(doc)).toThrow();
  });

  it('bounds nesting, node count, text length, and cycles', () => {
    let nested: any = { type: 'paragraph' };
    for (let i = 0; i < 34; i++) nested = { type: 'blockquote', content: [nested] };
    expect(() => validateDocument({ type: 'doc', content: [nested] })).toThrow(/deeply nested/);
    expect(() => validateDocument({ type: 'doc', content: Array.from({ length: 25_001 }, () => ({ type: 'paragraph' })) })).toThrow();
    expect(() => validateDocument(document('a'.repeat(1_000_001)))).toThrow(/too large/);
    const cyclic: any = { type: 'blockquote', content: [] };
    cyclic.content.push(cyclic);
    expect(() => validateDocument({ type: 'doc', content: [cyclic] })).toThrow(/cycles/);
  });
});

describe('encrypted image assets', () => {
  it.each([
    ['png', PNG, 'image/png'], ['gif', GIF, 'image/gif'], ['webp', WEBP, 'image/webp'], ['jpg', JPEG, 'image/jpeg'],
  ] as const)('round trips actual %s bytes and authenticated MIME', async (extension, bytes, mimeType) => {
    await vault.create(PASSWORD);
    const image = await vault.addImage(bytes, `private-name.${extension}`);
    expect(image.mimeType).toBe(mimeType);
    expect(image.id).toMatch(/^[0-9a-f-]{36}$/);
    const returned = await vault.readImage(image.id);
    expect(returned).toEqual({ data: bytes, mimeType });
    returned.data.fill(0);
  });

  it('rejects SVG, renamed non-images, truncated files, unsafe names, extension mismatches, and images over 20 MB', async () => {
    await vault.create(PASSWORD);
    for (const [bytes, name] of [
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'not.png'],
      [Buffer.from('hello world'), 'fake.jpg'], [PNG.subarray(0, 30), 'truncated.png'],
      [Buffer.concat([PNG, Buffer.from('<svg/>')]), 'polyglot.png'],
      [GIF.subarray(0, 13), 'truncated.gif'], [WEBP.subarray(0, 20), 'truncated.webp'],
      [JPEG.subarray(0, -2), 'truncated.jpg'], [PNG, 'image.svg'], [PNG, 'image.jpg'],
      [PNG, '../image.png'], [PNG, 'path\\image.png'], [Buffer.alloc(0), 'empty.png'],
      [Buffer.alloc(20 * 1024 * 1024 + 1), 'big.png'],
    ] as Array<[Buffer, string]>) {
      await expect(vault.addImage(bytes, name)).rejects.toThrow();
    }
    expect(await fs.readdir(directory)).toEqual(['diary.json']);
  });

  it('rejects unsafe image IDs and asset substitution', async () => {
    await vault.create(PASSWORD);
    const first = await vault.addImage(PNG, 'first.png');
    const second = await vault.addImage(GIF, 'second.gif');
    for (const id of ['../diary.json', 'bad', `${first.id}.asset`, first.id.toUpperCase(), `${first.id}?x=1`]) {
      await expect(vault.readImage(id)).rejects.toThrow(/ID/);
    }
    await fs.copyFile(path.join(directory, 'assets', `${first.id}.asset`), path.join(directory, 'assets', `${second.id}.asset`));
    await expect(vault.readImage(second.id)).rejects.toThrow(/Authentication/);
  });

  it('authenticates asset MIME and bytes, including schema validation on decryption', async () => {
    await vault.create(PASSWORD);
    const image = await vault.addImage(PNG, 'image.png');
    const file = path.join(directory, 'assets', `${image.id}.asset`);
    const metadata = await json(path.join(directory, 'diary.json'));
    const passwordKey = await derivePassphraseKey(PASSWORD, metadata.kdf);
    const master = decrypt(passwordKey, metadata.passphraseWrap, metadata.diaryId, 'passphrase-wrap', 'diary.json', 32);
    const logicalPath = `assets/${image.id}.asset`;
    const plaintext = Buffer.from(JSON.stringify({ version: 1, mimeType: 'image/jpeg', data: PNG.toString('base64') }));
    try {
      await fs.writeFile(file, JSON.stringify(encrypt(master, plaintext, metadata.diaryId, 'asset', logicalPath)));
      await expect(vault.readImage(image.id)).rejects.toThrow(/MIME/);
    } finally {
      master.fill(0);
      passwordKey.fill(0);
      plaintext.fill(0);
    }
  });
});

describe('atomic writes and filesystem containment', () => {
  it('cleans the named temporary file and preserves the entry if rename fails', async () => {
    await vault.create(PASSWORD);
    const entry = await vault.ensureToday();
    const before = await fs.readFile(filename(entry.date));
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('Simulated disk failure'), { code: 'EIO' }));
    await expect(vault.saveEntry({ date: entry.date, title: 'unsaved', document: EMPTY_DOCUMENT, expectedRevision: entry.revision })).rejects.toThrow(/disk failure/);
    expect(await fs.readFile(filename(entry.date))).toEqual(before);
    expect((await recursiveFiles(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('propagates fsync failure without publishing a partial metadata file', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actual.open(...args);
      vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('Simulated fsync failure'));
      return handle;
    });
    await expect(vault.create(PASSWORD)).rejects.toThrow(/fsync/);
    expect(vault.isUnlocked).toBe(false);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('failed recovery writes leave old credentials usable and do not retain decrypted keys', async () => {
    const { recoveryKey } = await vault.create(PASSWORD);
    const before = await fs.readFile(path.join(directory, 'diary.json'));
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('Simulated metadata rename failure'));
    await expect(vault.recover(recoveryKey, NEW_PASSWORD)).rejects.toThrow(/rename failure/);
    expect(vault.isUnlocked).toBe(false);
    expect(await fs.readFile(path.join(directory, 'diary.json'))).toEqual(before);
    await vault.unlock(PASSWORD);
    expect((await recursiveFiles(directory)).some(file => file.endsWith('.tmp'))).toBe(false);
  });

  it('rejects symlinked root, metadata, descendants, and image directories where supported', async (context) => {
    await vault.create(PASSWORD);
    const outside = path.join(sandbox, 'outside');
    await fs.mkdir(outside);
    const linkedRoot = path.join(sandbox, 'linked-root');
    try { await fs.symlink(directory, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
      throw error;
    }
    await expect(anotherStore(linkedRoot).exists()).rejects.toThrow(/symbolic/);
    await expect(anotherStore(linkedRoot).create(PASSWORD)).rejects.toThrow(/symbolic/);
    await fs.symlink(outside, path.join(directory, 'entries'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(vault.ensureToday()).rejects.toThrow(/symbolic/);
    await expect(vault.listEntries()).rejects.toThrow(/symbolic/);
    await fs.symlink(outside, path.join(directory, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(vault.addImage(PNG, 'image.png')).rejects.toThrow(/symbolic/);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('rejects a symlinked year/month or entry file without reading the target where supported', async (context) => {
    await vault.create(PASSWORD);
    const day = new Date(2026, 8, 18);
    const entry = await vault.ensureToday(day);
    const month = path.join(directory, 'entries', '2026', '09');
    const outside = path.join(sandbox, 'outside-month');
    await fs.rename(month, outside);
    try { await fs.symlink(outside, month, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
      throw error;
    }
    await expect(vault.readEntry(entry.date)).rejects.toThrow(/symbolic/);
    await expect(vault.listEntries()).rejects.toThrow(/symbolic/);
    await fs.unlink(month);
    await fs.rename(outside, month);
    const externalFile = path.join(sandbox, 'outside.entry');
    await fs.rename(filename(entry.date), externalFile);
    try { await fs.symlink(externalFile, filename(entry.date), 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
      throw error;
    }
    await expect(vault.readEntry(entry.date)).rejects.toThrow(/symbolic/);
    await expect(vault.ensureToday(day)).rejects.toThrow(/symbolic/);
  });

  it('rejects linked metadata and a symlinked .git directory where supported', async (context) => {
    const other = path.join(sandbox, 'outside-git');
    await fs.mkdir(other);
    await fs.mkdir(directory);
    try { await fs.symlink(other, path.join(directory, '.git'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
      throw error;
    }
    await expect(vault.create(PASSWORD)).rejects.toThrow(/real directory/);
    await fs.unlink(path.join(directory, '.git'));
    await vault.create(PASSWORD);
    const externalFile = path.join(sandbox, 'outside-metadata.json');
    await fs.link(path.join(directory, 'diary.json'), externalFile);
    await expect(vault.exists()).rejects.toThrow(/hard links/);
    await expect(vault.unlock(PASSWORD)).rejects.toThrow(/hard links/);
  });
});
