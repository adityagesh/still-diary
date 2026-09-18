import { describe, expect, it } from 'vitest';
import { SaveCoordinator } from '../src/save-coordinator';
import type { DiaryEntry, SaveEntryInput } from '../shared/types';
import { EMPTY_DOCUMENT } from '../shared/types';

const entry: DiaryEntry = {
  date: '2026-09-18', title: '', document: EMPTY_DOCUMENT,
  createdAt: '2026-09-18T10:00:00Z', updatedAt: '2026-09-18T10:00:00Z', revision: 'first',
};

describe('autosave coordination', () => {
  it('does not save an unchanged entry', async () => {
    let calls = 0;
    const model = new SaveCoordinator(entry, async () => { calls++; return entry; }, () => {});
    await model.flush();
    expect(calls).toBe(0);
  });

  it('serializes edits made during an in-flight save using the new revision', async () => {
    const requests: SaveEntryInput[] = [];
    let release!: (entry: DiaryEntry) => void;
    const model = new SaveCoordinator(entry, async (input) => {
      requests.push(input);
      if (requests.length === 1) return new Promise<DiaryEntry>((resolve) => { release = resolve; });
      return { ...entry, ...input, revision: 'third' };
    }, () => {});
    model.update({ title: 'First edit' });
    const pending = model.flush();
    model.update({ title: 'Second edit' });
    expect(model.flush()).toBe(pending);
    release({ ...entry, title: 'First edit', revision: 'second' });
    await pending;
    expect(requests.map(({ title, expectedRevision }) => ({ title, expectedRevision }))).toEqual([
      { title: 'First edit', expectedRevision: 'first' }, { title: 'Second edit', expectedRevision: 'second' },
    ]);
    expect(model.current.title).toBe('Second edit');
    expect(model.current.revision).toBe('third');
    expect(model.dirty).toBe(false);
  });

  it('keeps unsaved text and permits retry after a disk failure', async () => {
    let fails = true;
    const model = new SaveCoordinator(entry, async (input) => {
      if (fails) throw new Error('Disk full');
      return { ...entry, ...input, revision: 'second' };
    }, () => {});
    model.update({ title: 'Never lose this' });
    await expect(model.flush()).rejects.toThrow('Disk full');
    expect(model.dirty).toBe(true);
    expect(model.current.title).toBe('Never lose this');
    fails = false;
    await model.flush();
    expect(model.dirty).toBe(false);
  });

  it('refuses switching away from dirty or in-flight text', async () => {
    let release!: (saved: DiaryEntry) => void;
    const model = new SaveCoordinator(entry, () => new Promise((resolve) => { release = resolve; }), () => {});
    model.update({ title: 'Draft' });
    expect(() => model.replace({ ...entry, date: '2026-09-19' })).toThrow('Save the current entry');
    const pending = model.flush();
    expect(() => model.replace(entry)).toThrow();
    release({ ...entry, title: 'Draft', revision: 'second' });
    await pending;
    model.replace({ ...entry, date: '2026-09-19' });
    expect(model.current.date).toBe('2026-09-19');
  });
});
