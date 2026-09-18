import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  EMPTY_DOCUMENT, localDate,
  type AddedImage, type DiaryEntry, type EntrySummary, type RichDocument, type RichNode, type SaveEntryInput,
} from '../shared/types';
import {
  decodeBase64, decrypt, derivePassphraseKey, encodeRecoveryKey, encrypt, fields, FORMAT_VERSION,
  type Envelope, type Kdf, newKdf, parseRecoveryKey, record, UUID_PATTERN, validateEnvelope,
  validateKdf, validatePassphrase,
} from './crypto';

const METADATA_FILE = 'diary.json';
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_ASSET_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1024;
const MAX_ENTRIES = 100_000;
const TITLE_LIMIT = 256;
const MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
const SEMANTIC_COLORS = new Set([
  'var(--cp-text)', 'var(--cp-text-muted)', 'var(--cp-accent)', 'var(--cp-link)',
]);
const ENVELOPE_OVERHEAD = 1024;

interface Metadata {
  version: 1;
  diaryId: string;
  kdf: Kdf;
  passphraseWrap: Envelope;
  recoveryWrap: Envelope;
}

interface StoredEntry {
  version: 1;
  date: string;
  title: string;
  document: RichDocument;
  createdAt: string;
  updatedAt: string;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function validateDate(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/.test(value)) {
    throw new Error('Entry dates must use YYYY-MM-DD.');
  }
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || day > days[month - 1]) throw new Error('Invalid calendar date.');
}

function entryPath(date: string): string {
  validateDate(date);
  return `entries/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.entry`;
}

function assetPath(id: unknown): string {
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw new Error('Invalid image ID.');
  return `assets/${id}.asset`;
}

function validateTimestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('Invalid entry timestamp.');
  }
}

function validateTitle(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > TITLE_LIMIT || value.includes('\0')) {
    throw new Error(`Entry titles must be text of at most ${TITLE_LIMIT} characters.`);
  }
}

function boundedString(value: unknown, maximum: number): boolean {
  return typeof value === 'string' && value.length <= maximum && !value.includes('\0');
}

function validateColor(value: unknown): boolean {
  // Tiptap's HTML parser represents a missing inline style as an empty string.
  if (value === null || value === '') return true;
  if (typeof value !== 'string' || value.length > 48) return false;
  if (SEMANTIC_COLORS.has(value)) return true;
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) return true;
  const match = /^rgba?\((\d{1,3}), ?(\d{1,3}), ?(\d{1,3})(?:, ?(0(?:\.\d{1,3})?|1(?:\.0{1,3})?))?\)$/.exec(value);
  return !!match && match.slice(1, 4).every(channel => Number(channel) <= 255)
    && (value.startsWith('rgba(') === (match[4] !== undefined));
}

function validateFontSize(value: unknown): boolean {
  if (value === null || value === '') return true;
  if (typeof value !== 'string' || value.length > 12) return false;
  const match = /^(\d{1,3}(?:\.\d{1,2})?)(px|em|rem|%)$/.exec(value);
  if (!match) return false;
  const size = Number(match[1]);
  return size > 0 && size <= (match[2] === 'px' ? 160 : match[2] === '%' ? 999 : 10);
}

const BLOCKS = new Set([
  'paragraph', 'heading', 'codeBlock', 'bulletList', 'orderedList', 'blockquote', 'horizontalRule', 'image',
]);
const INLINE = new Set(['text', 'hardBreak']);
const MARKS = new Set(['bold', 'italic', 'underline', 'strike', 'code', 'textStyle']);

export function validateDocument(value: unknown): asserts value is RichDocument {
  let count = 0;
  let textLength = 0;
  const seen = new Set<object>();
  function node(input: unknown, parent: string | null, depth: number): void {
    if (depth > 32 || ++count > 25_000) throw new Error('The entry document is too deeply nested or has too many nodes.');
    const item = record(input, 'Document node');
    if (seen.has(item)) throw new Error('The entry document must not contain cycles or shared nodes.');
    seen.add(item);
    fields(item, ['type', 'text', 'attrs', 'marks', 'content'], ['type']);
    if (typeof item.type !== 'string') throw new Error('Invalid document node type.');
    const type = item.type;
    const allowed = parent === null ? type === 'doc'
      : parent === 'doc' || parent === 'blockquote' || parent === 'listItem' ? BLOCKS.has(type)
        : parent === 'bulletList' || parent === 'orderedList' ? type === 'listItem'
          : parent === 'paragraph' || parent === 'heading' ? INLINE.has(type)
            : parent === 'codeBlock' ? type === 'text' : false;
    if (!allowed) throw new Error('Unsupported document node or invalid document structure.');
    if (item.text !== undefined) {
      if (type !== 'text' || typeof item.text !== 'string' || item.text.length === 0 || item.text.includes('\0')) {
        throw new Error('Invalid document text.');
      }
      textLength += item.text.length;
      if (textLength > 1_000_000) throw new Error('Entry text is too large.');
    } else if (type === 'text') {
      throw new Error('Text nodes require text.');
    }
    if (item.attrs !== undefined) {
      const attrs = record(item.attrs, 'Node attributes');
      const allowedAttrs = type === 'heading' ? ['level']
        : type === 'orderedList' ? ['start', 'type']
          : type === 'codeBlock' ? ['language']
            : type === 'image' ? ['src', 'alt', 'title', 'width', 'height'] : [];
      fields(attrs, allowedAttrs, type === 'image' ? ['src'] : []);
      if (attrs.level !== undefined && (!Number.isInteger(attrs.level) || Number(attrs.level) < 1 || Number(attrs.level) > 6)) {
        throw new Error('Heading levels must be between 1 and 6.');
      }
      if (attrs.start !== undefined && (!Number.isInteger(attrs.start) || Number(attrs.start) < 1 || Number(attrs.start) > 1_000_000)) {
        throw new Error('Invalid ordered-list start.');
      }
      if (attrs.type !== undefined && attrs.type !== null
        && (typeof attrs.type !== 'string' || !['1', 'a', 'A', 'i', 'I'].includes(attrs.type))) {
        throw new Error('Invalid ordered-list style.');
      }
      if (attrs.language !== undefined && attrs.language !== null
        && (typeof attrs.language !== 'string' || !/^[a-zA-Z0-9_+#.-]{1,40}$/.test(attrs.language))) {
        throw new Error('Invalid code-block language.');
      }
      if (type === 'image') {
        if (typeof attrs.src !== 'string' || !attrs.src.startsWith('diary-asset://vault/')) {
          throw new Error('Images must use a local diary-asset://vault/<uuid> source.');
        }
        assetPath(attrs.src.slice('diary-asset://vault/'.length));
        for (const name of ['alt', 'title']) {
          if (attrs[name] !== undefined && attrs[name] !== null && !boundedString(attrs[name], 1000)) {
            throw new Error('Image descriptions must be at most 1000 characters.');
          }
        }
        for (const name of ['width', 'height']) {
          if (attrs[name] !== undefined && attrs[name] !== null
            && (!Number.isInteger(attrs[name]) || Number(attrs[name]) < 1 || Number(attrs[name]) > 16384)) {
            throw new Error('Invalid image dimensions.');
          }
        }
      }
    } else if (type === 'image') {
      throw new Error('Image nodes require a local image source.');
    }
    if (item.marks !== undefined) {
      if (!INLINE.has(type) || parent === 'codeBlock' || !Array.isArray(item.marks) || item.marks.length > MARKS.size) {
        throw new Error('Invalid document marks.');
      }
      const used = new Set<string>();
      for (const inputMark of item.marks) {
        const mark = record(inputMark, 'Text mark');
        fields(mark, ['type', 'attrs'], ['type']);
        if (typeof mark.type !== 'string' || !MARKS.has(mark.type) || used.has(mark.type)) {
          throw new Error('Unsupported or duplicate text mark.');
        }
        used.add(mark.type);
        if (mark.attrs !== undefined) {
          const attrs = record(mark.attrs, 'Mark attributes');
          fields(attrs, mark.type === 'textStyle' ? ['color', 'fontSize'] : [], []);
          if (attrs.color !== undefined && !validateColor(attrs.color)) throw new Error('Invalid text color.');
          if (attrs.fontSize !== undefined && !validateFontSize(attrs.fontSize)) throw new Error('Invalid text font size.');
        }
      }
    }
    if (item.content !== undefined) {
      if (type === 'text' || type === 'hardBreak' || type === 'horizontalRule' || type === 'image'
        || !Array.isArray(item.content) || item.content.length > 25_000) {
        throw new Error('Invalid document children.');
      }
      for (const child of item.content) node(child, type, depth + 1);
    }
    if (type === 'doc' && (!Array.isArray(item.content) || item.content.length === 0)) {
      throw new Error('The document requires at least one block.');
    }
    if ((type === 'bulletList' || type === 'orderedList')
      && (!Array.isArray(item.content) || item.content.length === 0)) throw new Error('Lists require a list item.');
    if (type === 'listItem'
      && (!Array.isArray(item.content) || record(item.content[0], 'List item').type !== 'paragraph')) {
      throw new Error('List items must begin with a paragraph.');
    }
    if (type === 'blockquote' && (!Array.isArray(item.content) || item.content.length === 0)) {
      throw new Error('Blockquotes require a block.');
    }
  }
  node(value, null, 0);
}

function validateStoredEntry(value: unknown, date: string): StoredEntry {
  const item = record(value, 'Entry');
  fields(item, ['version', 'date', 'title', 'document', 'createdAt', 'updatedAt']);
  if (item.version !== FORMAT_VERSION) throw new Error('Unsupported entry schema version.');
  validateDate(item.date);
  if (item.date !== date) throw new Error('The entry date does not match its encrypted path.');
  validateTitle(item.title);
  validateTimestamp(item.createdAt);
  validateTimestamp(item.updatedAt);
  if (item.updatedAt < item.createdAt) throw new Error('The entry update predates its creation.');
  validateDocument(item.document);
  return item as unknown as StoredEntry;
}

function parseJson(bytes: Buffer): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('The vault contains invalid JSON or UTF-8 data. Restore an intact encrypted copy.');
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function preview(document: RichDocument): string {
  let result = '';
  const visit = (item: RichNode): void => {
    if (result.length >= 200) return;
    if (item.text) result += item.text.slice(0, 200 - result.length);
    for (const child of item.content ?? []) visit(child);
    if (BLOCKS.has(item.type) && result.length < 200 && result && !result.endsWith(' ')) result += ' ';
  };
  visit(document);
  return result.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function imageMime(data: Buffer): string {
  if (!Buffer.isBuffer(data) || data.length === 0 || data.length > MAX_IMAGE_BYTES) {
    throw new Error('Images must be nonempty and no larger than 20 MB.');
  }
  const fail = (): never => { throw new Error('Unsupported or malformed image. Select a PNG, JPEG, GIF, or WebP image; SVG is not allowed.'); };
  if (data.length >= 45 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    if (data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR'
      || !data.readUInt32BE(16) || !data.readUInt32BE(20)) return fail();
    let offset = 8;
    let hasImage = false;
    while (offset + 12 <= data.length) {
      const length = data.readUInt32BE(offset);
      const type = data.toString('ascii', offset + 4, offset + 8);
      if (length > data.length - offset - 12) return fail();
      if (type === 'IDAT' && length > 0) hasImage = true;
      offset += 12 + length;
      if (type === 'IEND') return length === 0 && offset === data.length && hasImage ? 'image/png' : fail();
    }
    return fail();
  }
  if (data.length >= 12 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    if (data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) return fail();
    let offset = 2;
    let frame = false;
    while (offset < data.length - 2) {
      if (data[offset++] !== 0xff) return fail();
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xda) return frame ? 'image/jpeg' : fail();
      if (marker === 0xd9 || marker === 0 || offset + 2 > data.length) return fail();
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) return fail();
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8 || !data.readUInt16BE(offset + 3) || !data.readUInt16BE(offset + 5)) return fail();
        frame = true;
      }
      offset += length;
    }
    return fail();
  }
  if (data.length >= 14 && ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) {
    if (!data.readUInt16LE(6) || !data.readUInt16LE(8) || data[data.length - 1] !== 0x3b) return fail();
    let offset = 13 + ((data[10] & 0x80) ? 3 * 2 ** ((data[10] & 7) + 1) : 0);
    let hasImage = false;
    while (offset < data.length - 1) {
      const marker = data[offset++];
      if (marker === 0x2c) {
        if (offset + 9 > data.length || !data.readUInt16LE(offset + 4) || !data.readUInt16LE(offset + 6)) return fail();
        const packed = data[offset + 8];
        offset += 9 + ((packed & 0x80) ? 3 * 2 ** ((packed & 7) + 1) : 0);
        if (offset >= data.length || data[offset] < 2 || data[offset] > 8) return fail();
        offset++;
        hasImage = true;
      } else if (marker === 0x21) {
        if (offset >= data.length - 1) return fail();
        offset++;
      } else return fail();
      for (;;) {
        if (offset >= data.length) return fail();
        const length = data[offset++];
        if (length === 0) break;
        offset += length;
        if (offset > data.length) return fail();
      }
    }
    return hasImage && offset === data.length - 1 ? 'image/gif' : fail();
  }
  if (data.length >= 26 && data.toString('ascii', 0, 4) === 'RIFF'
    && data.toString('ascii', 8, 12) === 'WEBP') {
    if (data.readUInt32LE(4) !== data.length - 8) return fail();
    let offset = 12;
    let hasImage = false;
    while (offset + 8 <= data.length) {
      const type = data.toString('ascii', offset, offset + 4);
      const length = data.readUInt32LE(offset + 4);
      if (length > data.length - offset - 8) return fail();
      if (type === 'VP8 ' && length >= 10
        && data.subarray(offset + 11, offset + 14).equals(Buffer.from('9d012a', 'hex'))) hasImage = true;
      if (type === 'VP8L' && length >= 5 && data[offset + 8] === 0x2f) hasImage = true;
      if (type === 'ANMF' && length >= 24) hasImage = true;
      offset += 8 + length + (length % 2);
    }
    return hasImage && offset === data.length ? 'image/webp' : fail();
  }
  return fail();
}

export class VaultStore {
  private readonly directory: string;
  private masterKey: Buffer | undefined;
  private diaryId: string | undefined;
  private generation = 0;

  constructor(directory: string) {
    if (typeof directory !== 'string' || !directory || directory.includes('\0')) throw new Error('Choose a valid vault directory.');
    this.directory = path.resolve(directory);
  }

  get isUnlocked(): boolean {
    return this.masterKey !== undefined;
  }

  lock(): void {
    this.generation++;
    this.masterKey?.fill(0);
    this.masterKey = undefined;
    this.diaryId = undefined;
  }

  private credentials(): { key: Buffer; diaryId: string; generation: number } {
    if (!this.masterKey || !this.diaryId) throw new Error('The diary is locked. Unlock it first.');
    return { key: this.masterKey, diaryId: this.diaryId, generation: this.generation };
  }

  private checkGeneration(generation: number): void {
    if (generation !== this.generation) throw new Error('The diary was locked while the operation was in progress. Unlock it and retry.');
  }

  private async root(create = false): Promise<void> {
    if (create) {
      try { await fs.mkdir(this.directory, { recursive: true, mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const info = await fs.lstat(this.directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('The vault directory must be a real directory, not a symbolic link.');
  }

  private components(logicalPath: string): string[] {
    const parts = logicalPath.split('/');
    if (parts.length === 0 || parts.some(part => !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(part) || part === '.' || part === '..')) {
      throw new Error('Unsafe vault path.');
    }
    return parts;
  }

  private async parent(logicalPath: string, create = false): Promise<string> {
    await this.root();
    const parts = this.components(logicalPath);
    let current = this.directory;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      if (create) {
        try { await fs.mkdir(current, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      const info = await fs.lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Unsafe vault path: symbolic links and non-directory parents are not allowed.');
    }
    return path.join(current, parts[parts.length - 1]);
  }

  private async regularFile(filename: string, maximum: number): Promise<Stats> {
    const info = await fs.lstat(filename);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error('Unsafe vault file: symbolic links, hard links, and special files are not allowed.');
    }
    if (info.size > maximum) throw new Error('The vault file exceeds the supported size limit.');
    return info;
  }

  private async readFile(logicalPath: string, maximum: number): Promise<Buffer> {
    const filename = await this.parent(logicalPath);
    const before = await this.regularFile(filename, maximum);
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer | undefined;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev || opened.size > maximum) {
        throw new Error('The vault file changed while opening it. Retry after synchronization finishes.');
      }
      // Bound the allocation even if another process grows the file after stat().
      bytes = Buffer.alloc(opened.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== opened.size) throw new Error('The vault file changed while reading it. Retry after synchronization finishes.');
      await this.parent(logicalPath);
      const after = await this.regularFile(filename, maximum);
      if (after.ino !== opened.ino || after.dev !== opened.dev || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
        throw new Error('The vault file changed while reading it. Retry after synchronization finishes.');
      }
      return bytes.subarray(0, offset);
    } catch (error) {
      bytes?.fill(0);
      throw error;
    } finally {
      await handle.close();
    }
  }

  private async atomicWrite(logicalPath: string, bytes: Buffer, generation: number, newOnly = false): Promise<void> {
    const filename = await this.parent(logicalPath, true);
    const temporary = path.join(path.dirname(filename), `.still-diary-${randomUUID()}.tmp`);
    let exists = false;
    let handle: fs.FileHandle | undefined;
    try {
      this.checkGeneration(generation);
      handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      exists = true;
      await handle.writeFile(bytes);
      await handle.sync();
      const written = await handle.stat();
      await handle.close();
      handle = undefined;
      await this.parent(logicalPath);
      const staged = await this.regularFile(temporary, bytes.length);
      if (staged.ino !== written.ino || staged.dev !== written.dev || staged.size !== bytes.length) {
        throw new Error('The staged vault file changed before publication. Retry after synchronization finishes.');
      }
      try {
        await this.regularFile(filename, Number.MAX_SAFE_INTEGER);
        if (newOnly) throw new Error('The vault file already exists; refusing to overwrite it.');
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      this.checkGeneration(generation);
      await fs.rename(temporary, filename);
      exists = false;
      if (process.platform !== 'win32') {
        const directory = await fs.open(path.dirname(filename), constants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (handle) {
        try { await handle.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      }
      if (exists) {
        try { await fs.unlink(temporary); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      }
      if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], 'The write failed and its temporary file could not be fully cleaned up.');
      throw error;
    }
  }

  async exists(): Promise<boolean> {
    try {
      const filename = await this.parent(METADATA_FILE);
      await this.regularFile(filename, MAX_METADATA_BYTES);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  private async readMetadata(): Promise<Metadata> {
    let bytes: Buffer;
    try { bytes = await this.readFile(METADATA_FILE, MAX_METADATA_BYTES); }
    catch (error) {
      if (isMissing(error)) throw new Error('No diary.json was found. Choose an existing vault or create a new diary.');
      throw error;
    }
    const value = record(parseJson(bytes), 'Vault metadata');
    fields(value, ['version', 'diaryId', 'kdf', 'passphraseWrap', 'recoveryWrap']);
    if (value.version !== FORMAT_VERSION) throw new Error('Unsupported diary metadata version.');
    if (typeof value.diaryId !== 'string' || !UUID_PATTERN.test(value.diaryId)) throw new Error('Invalid diary identity.');
    validateKdf(value.kdf);
    validateEnvelope(value.passphraseWrap, 32, 32);
    validateEnvelope(value.recoveryWrap, 32, 32);
    return value as unknown as Metadata;
  }

  private async wrapKeys(master: Buffer, diaryId: string, passphrase: string, recovery: Buffer): Promise<Metadata> {
    const kdf = newKdf();
    const passwordKey = await derivePassphraseKey(passphrase, kdf);
    try {
      return {
        version: FORMAT_VERSION, diaryId, kdf,
        passphraseWrap: encrypt(passwordKey, master, diaryId, 'passphrase-wrap', METADATA_FILE),
        recoveryWrap: encrypt(recovery, master, diaryId, 'recovery-wrap', METADATA_FILE),
      };
    } finally {
      passwordKey.fill(0);
    }
  }

  async create(passphrase: string): Promise<{ recoveryKey: string }> {
    this.lock();
    validatePassphrase(passphrase);
    const generation = this.generation;
    let master: Buffer | undefined;
    let recovery: Buffer | undefined;
    try {
      await this.root(true);
      const children = await fs.readdir(this.directory);
      if (children.some(name => name !== '.git')) throw new Error('Create a diary in an empty folder or a folder containing only .git. Existing files will not be overwritten.');
      if (children.includes('.git')) {
        const git = await fs.lstat(path.join(this.directory, '.git'));
        if (git.isSymbolicLink() || !git.isDirectory()) throw new Error('The .git entry must be a real directory.');
      }
      master = randomBytes(32);
      recovery = randomBytes(32);
      const diaryId = randomUUID();
      const metadata = await this.wrapKeys(master, diaryId, passphrase, recovery);
      this.checkGeneration(generation);
      const currentChildren = await fs.readdir(this.directory);
      if (currentChildren.some(name => name !== '.git')) throw new Error('The selected folder is no longer empty. No diary was created.');
      await this.atomicWrite(METADATA_FILE, Buffer.from(JSON.stringify(metadata)), generation, true);
      this.checkGeneration(generation);
      const recoveryKey = encodeRecoveryKey(recovery);
      this.masterKey = master;
      this.diaryId = diaryId;
      master = undefined;
      return { recoveryKey };
    } finally {
      master?.fill(0);
      recovery?.fill(0);
    }
  }

  async unlock(passphrase: string): Promise<void> {
    this.lock();
    validatePassphrase(passphrase);
    const generation = this.generation;
    let passwordKey: Buffer | undefined;
    let master: Buffer | undefined;
    try {
      const metadata = await this.readMetadata();
      passwordKey = await derivePassphraseKey(passphrase, metadata.kdf);
      master = decrypt(passwordKey, metadata.passphraseWrap, metadata.diaryId, 'passphrase-wrap', METADATA_FILE, 32);
      this.checkGeneration(generation);
      this.masterKey = master;
      this.diaryId = metadata.diaryId;
      master = undefined;
    } finally {
      passwordKey?.fill(0);
      master?.fill(0);
    }
  }

  async recover(recoveryKey: string, newPassphrase: string): Promise<{ recoveryKey: string }> {
    this.lock();
    validatePassphrase(newPassphrase);
    const generation = this.generation;
    const oldRecovery = parseRecoveryKey(recoveryKey);
    let master: Buffer | undefined;
    let recovery: Buffer | undefined;
    try {
      const metadata = await this.readMetadata();
      master = decrypt(oldRecovery, metadata.recoveryWrap, metadata.diaryId, 'recovery-wrap', METADATA_FILE, 32);
      recovery = randomBytes(32);
      const next = await this.wrapKeys(master, metadata.diaryId, newPassphrase, recovery);
      this.checkGeneration(generation);
      // Do not overwrite credentials that a sync or another process replaced during scrypt.
      if (JSON.stringify(await this.readMetadata()) !== JSON.stringify(metadata)) {
        throw new Error('The vault credentials changed during recovery. Retry with the current recovery key.');
      }
      await this.atomicWrite(METADATA_FILE, Buffer.from(JSON.stringify(next)), generation);
      this.checkGeneration(generation);
      const nextRecoveryKey = encodeRecoveryKey(recovery);
      this.masterKey = master;
      this.diaryId = metadata.diaryId;
      master = undefined;
      return { recoveryKey: nextRecoveryKey };
    } finally {
      oldRecovery.fill(0);
      recovery?.fill(0);
      master?.fill(0);
    }
  }

  async readEntry(date: string): Promise<DiaryEntry> {
    const credentials = this.credentials();
    const logicalPath = entryPath(date);
    const bytes = await this.readFile(logicalPath, Math.ceil(MAX_ENTRY_BYTES / 3) * 4 + ENVELOPE_OVERHEAD);
    this.checkGeneration(credentials.generation);
    const plaintext = decrypt(credentials.key, parseJson(bytes), credentials.diaryId, 'entry', logicalPath, MAX_ENTRY_BYTES);
    try {
      const { version: _version, ...entry } = validateStoredEntry(parseJson(plaintext), date);
      return { ...entry, revision: sha256(bytes) };
    } finally {
      plaintext.fill(0);
    }
  }

  private async writeEntry(entry: StoredEntry, newOnly: boolean): Promise<DiaryEntry> {
    const credentials = this.credentials();
    const logicalPath = entryPath(entry.date);
    validateStoredEntry(entry, entry.date);
    const plaintext = Buffer.from(JSON.stringify(entry), 'utf8');
    try {
      if (plaintext.length > MAX_ENTRY_BYTES) throw new Error('The entry is too large; use fewer than 2 MB of text and formatting.');
      const bytes = Buffer.from(JSON.stringify(encrypt(credentials.key, plaintext, credentials.diaryId, 'entry', logicalPath)));
      await this.atomicWrite(logicalPath, bytes, credentials.generation, newOnly);
      this.checkGeneration(credentials.generation);
      const { version: _version, ...result } = entry;
      return { ...result, revision: sha256(bytes) };
    } finally {
      plaintext.fill(0);
    }
  }

  async ensureToday(now = new Date()): Promise<DiaryEntry> {
    this.credentials();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('A valid local date is required.');
    const date = localDate(now);
    validateDate(date);
    try { return await this.readEntry(date); }
    catch (error) { if (!isMissing(error)) throw error; }
    const timestamp = new Date().toISOString();
    return this.writeEntry({
      version: FORMAT_VERSION, date, title: '', document: structuredClone(EMPTY_DOCUMENT),
      createdAt: timestamp, updatedAt: timestamp,
    }, true);
  }

  async saveEntry(input: SaveEntryInput): Promise<DiaryEntry> {
    const credentials = this.credentials();
    const value = record(input, 'Entry changes');
    fields(value, ['date', 'title', 'document', 'expectedRevision']);
    validateDate(value.date);
    validateTitle(value.title);
    validateDocument(value.document);
    if (typeof value.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(value.expectedRevision)) {
      throw new Error('A valid expectedRevision is required. Reload the entry before saving.');
    }
    const snapshot = structuredClone(input);
    const existing = await this.readEntry(snapshot.date);
    this.checkGeneration(credentials.generation);
    if (existing.revision !== snapshot.expectedRevision) {
      throw new Error('This entry changed since it was opened. Reload it before saving to avoid overwriting newer changes.');
    }
    return this.writeEntry({
      version: FORMAT_VERSION, date: snapshot.date, title: snapshot.title, document: snapshot.document,
      createdAt: existing.createdAt,
      updatedAt: new Date(Math.max(Date.now(), Date.parse(existing.updatedAt) + 1)).toISOString(),
    }, false);
  }

  async listEntries(): Promise<EntrySummary[]> {
    const credentials = this.credentials();
    const summaries: EntrySummary[] = [];
    const entriesDirectory = path.join(this.directory, 'entries');
    await this.root();
    try {
      const info = await fs.lstat(entriesDirectory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('The entries directory must not be a symbolic link.');
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const years = await fs.readdir(entriesDirectory);
    for (const year of years) {
      if (!/^[0-9]{4}$/.test(year) || Number(year) < 1) throw new Error('Unexpected filename in entries; move unrelated files out of the vault.');
      const yearDirectory = await this.parent(`entries/${year}/placeholder`);
      const months = await fs.readdir(path.dirname(yearDirectory));
      for (const month of months) {
        if (!/^(?:0[1-9]|1[0-2])$/.test(month)) throw new Error('Unexpected entry month directory.');
        const monthDirectory = await this.parent(`entries/${year}/${month}/placeholder`);
        const filenames = await fs.readdir(path.dirname(monthDirectory));
        for (const filename of filenames) {
          if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}\.entry$/.test(filename)) throw new Error('Unexpected filename in the entry directory.');
          const date = filename.slice(0, -6);
          if (date.slice(0, 4) !== year || date.slice(5, 7) !== month) throw new Error('Entry path does not match its date.');
          if (summaries.length >= MAX_ENTRIES) throw new Error('The vault contains too many entries.');
          this.checkGeneration(credentials.generation);
          const entry = await this.readEntry(date);
          summaries.push({ date, title: entry.title, preview: preview(entry.document), updatedAt: entry.updatedAt, revision: entry.revision });
        }
      }
    }
    this.checkGeneration(credentials.generation);
    return summaries.sort((a, b) => b.date.localeCompare(a.date));
  }

  async addImage(data: Buffer, originalName: string): Promise<AddedImage> {
    const credentials = this.credentials();
    if (!boundedString(originalName, 255) || !originalName || /[\\/]/.test(originalName)) {
      throw new Error('Image names must be a filename of at most 255 characters, without a path.');
    }
    const mimeType = imageMime(data);
    const extension = path.extname(originalName).toLowerCase();
    const extensions: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    if (extension && extensions[extension] !== mimeType) throw new Error('The image filename extension does not match its actual image format.');
    const id = randomUUID();
    const logicalPath = assetPath(id);
    const plaintext = Buffer.from(JSON.stringify({ version: FORMAT_VERSION, mimeType, data: data.toString('base64') }));
    try {
      const bytes = Buffer.from(JSON.stringify(encrypt(credentials.key, plaintext, credentials.diaryId, 'asset', logicalPath)));
      await this.atomicWrite(logicalPath, bytes, credentials.generation, true);
      this.checkGeneration(credentials.generation);
      return { id, mimeType };
    } finally {
      plaintext.fill(0);
    }
  }

  async readImage(id: string): Promise<{ data: Buffer; mimeType: string }> {
    const credentials = this.credentials();
    const logicalPath = assetPath(id);
    const bytes = await this.readFile(logicalPath, Math.ceil(MAX_ASSET_BYTES / 3) * 4 + ENVELOPE_OVERHEAD);
    this.checkGeneration(credentials.generation);
    const plaintext = decrypt(credentials.key, parseJson(bytes), credentials.diaryId, 'asset', logicalPath, MAX_ASSET_BYTES);
    let data: Buffer | undefined;
    try {
      const asset = record(parseJson(plaintext), 'Image');
      fields(asset, ['version', 'mimeType', 'data']);
      if (asset.version !== FORMAT_VERSION || typeof asset.mimeType !== 'string'
        || !MIME_TYPES.includes(asset.mimeType as typeof MIME_TYPES[number])) throw new Error('Unsupported encrypted image format.');
      data = decodeBase64(asset.data, MAX_IMAGE_BYTES);
      if (imageMime(data) !== asset.mimeType) throw new Error('The encrypted image MIME type does not match its contents.');
      return { data, mimeType: asset.mimeType };
    } catch (error) {
      data?.fill(0);
      throw error;
    } finally {
      plaintext.fill(0);
    }
  }
}
