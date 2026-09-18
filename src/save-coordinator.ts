import type { DiaryEntry, RichDocument, SaveEntryInput } from '../shared/types';

export class SaveCoordinator {
  private entry: DiaryEntry;
  private version = 0;
  private savedVersion = 0;
  private flight: Promise<void> | null = null;

  constructor(
    initial: DiaryEntry,
    private readonly save: (input: SaveEntryInput) => Promise<DiaryEntry>,
    private readonly onSaved: (saved: DiaryEntry) => void,
  ) {
    this.entry = initial;
  }

  get current(): DiaryEntry { return this.entry; }
  get dirty(): boolean { return this.version !== this.savedVersion; }

  update(change: { title?: string; document?: RichDocument }): DiaryEntry {
    this.entry = { ...this.entry, ...change };
    this.version += 1;
    return this.entry;
  }

  replace(entry: DiaryEntry): void {
    if (this.dirty || this.flight) throw new Error('Save the current entry before switching.');
    this.entry = entry;
    this.version = 0;
    this.savedVersion = 0;
  }

  flush(): Promise<void> {
    if (this.flight) return this.flight;
    this.flight = this.persist().finally(() => { this.flight = null; });
    return this.flight;
  }

  private async persist(): Promise<void> {
    while (this.dirty) {
      const version = this.version;
      const snapshot = this.entry;
      const saved = await this.save({
        date: snapshot.date, title: snapshot.title, document: snapshot.document,
        expectedRevision: snapshot.revision,
      });
      this.entry = { ...this.entry, revision: saved.revision, updatedAt: saved.updatedAt };
      this.savedVersion = version;
      this.onSaved(saved);
    }
  }
}
