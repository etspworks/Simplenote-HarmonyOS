// Port of Simplenote/Classes/SPObjectManager.m (+ SPObjectManager+Simplenote.swift).
// The ONLY writer of Note / Tag state. Persistence + Simperium change enqueueing sit behind
// NoteStoreBackend: the Core Data context + Simperium buckets in the source.
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Note } from '../model/Note';
import { Tag } from '../model/Tag';
import { Options } from './OptionsStore';

/// What SPObjectManager reaches through `SPAppDelegate.simperium` / `managedObjectContext`.
/// Implemented by the Simperium/Database layer and attached once at launch.
export interface NoteStoreBackend {
  /// fetchAllObjectsForEntityName:@"Note"
  fetchNotes(): Note[];
  /// fetchAllObjectsForEntityName:@"Tag"
  fetchTags(): Tag[];
  /// NSEntityDescription.insertNewObject(forEntityName: "Note") (bucket assigns the simperiumKey)
  insertNote(): Note;
  /// [tagBucket insertNewObjectForKey:]
  insertTag(simperiumKey: string): Tag;
  /// managedObjectContext deleteObject:
  deleteNote(note: Note): void;
  deleteTag(tag: Tag): void;
  /// [simperium save]: persist to relationalStore and enqueue the sync changes
  save(): Promise<void>;
}

const DOMAIN: number = 0x0001;
const LOG_TAG: string = 'NoteStore';
const EMAIL_REGEX: RegExp = new RegExp('^.+@([A-Za-z0-9-]+\\.)+[A-Za-z]{2}[A-Za-z]*$');
const UNTAGGED_REGEX: RegExp = new RegExp('^(()|(null)|(\\s*\\[\\s*]\\s*))$');
const ALPHANUMERIC_REGEX: RegExp = new RegExp('^[\\p{L}\\p{M}\\p{N}]$', 'u');
const CONTENT_SAVE_DEBOUNCE_MS: number = 2000;
const CONTENT_SAVE_GUARANTEED_MS: number = 21000;

/// NSString.byEncodingAsTagHash: NFC, lowercased, percent-encoded outside `.alphanumerics`.
export function tagHash(name: string): string {
  const normalized: string = name.normalize('NFC').toLowerCase();
  const encoder: util.TextEncoder = new util.TextEncoder();
  let out: string = '';
  for (const ch of normalized) {
    if (ALPHANUMERIC_REGEX.test(ch)) {
      out += ch;
      continue;
    }
    const bytes: Uint8Array = encoder.encodeInto(ch);
    for (const b of bytes) {
      out += '%' + (b < 16 ? '0' : '') + b.toString(16).toUpperCase();
    }
  }
  return out;
}

/// NSString.isValidEmailAddress
export function isValidEmailAddress(text: string): boolean {
  return EMAIL_REGEX.test(text);
}

/// NSPredicate.predicateForNotes(tag:) — `tags CONTAINS[c] "\"<tag>\""` over the JSON tags field.
export function noteHasTagNamed(note: Note, tagName: string): boolean {
  const filtered: string = tagName.replace(new RegExp('\\\\', 'g'), '\\\\').replace(new RegExp('/', 'g'), '\\/');
  const needle: string = ('"' + filtered + '"').toLowerCase();
  const tags: string = note.tags === undefined || note.tags === null ? '' : note.tags;
  return tags.toLowerCase().indexOf(needle) >= 0;
}

/// NSPredicate.predicateForUntaggedNotes()
export function noteIsUntagged(note: Note): boolean {
  const tags: string = note.tags === undefined || note.tags === null ? '' : note.tags;
  return UNTAGGED_REGEX.test(tags);
}

export class NoteStore {
  private static instance: NoteStore | null = null;

  private backend: NoteStoreBackend | null = null;
  private listeners: Array<() => void> = [];
  private readyWaiters: Array<() => void> = [];
  private pendingContentNote: Note | null = null;
  private pendingContent: string = '';
  private debounceTimer: number = -1;
  private guaranteedTimer: number = -1;

  static sharedManager(): NoteStore {
    if (NoteStore.instance === null) {
      NoteStore.instance = new NoteStore();
    }
    return NoteStore.instance as NoteStore;
  }

  attachBackend(backend: NoteStoreBackend): void {
    this.backend = backend;
    const waiters: Array<() => void> = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) {
      w();
    }
    this.notifyChanged();
  }

  /// True once the Simperium backend is attached (the source's Core Data stack exists before any UI;
  /// here it is built asynchronously at launch, so a cold deep link can reach a page first).
  get isReady(): boolean {
    return this.backend !== null;
  }

  /// Resolves as soon as the backend is attached (immediately when it already is).
  whenReady(): Promise<void> {
    if (this.backend !== null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve: () => void): void => {
      this.readyWaiters.push(resolve);
    });
  }

  /// Local + remote change listener (the ResultsController refresh path for list screens).
  addChangeListener(listener: () => void): void {
    this.listeners.push(listener);
  }

  removeChangeListener(listener: () => void): void {
    const i: number = this.listeners.indexOf(listener);
    if (i >= 0) {
      this.listeners.splice(i, 1);
    }
  }

  /// Called by the backend when a sync delivers remote changes.
  notifyChanged(): void {
    for (const l of this.listeners) {
      l();
    }
  }

  async save(): Promise<void> {
    if (this.backend === null) {
      hilog.error(DOMAIN, LOG_TAG, 'save without an attached backend');
      return;
    }
    try {
      await this.backend.save();
    } catch (e) {
      hilog.error(DOMAIN, LOG_TAG, 'save failed: %{public}s', JSON.stringify(e));
    }
    this.notifyChanged();
  }

  notes(): Note[] {
    return this.backend === null ? [] : this.backend.fetchNotes();
  }

  tags(): Tag[] {
    if (this.backend === null) {
      return [];
    }
    const allTags: Tag[] = this.backend.fetchTags().slice();
    allTags.sort((a: Tag, b: Tag): number => NoteStore.tagIndex(a) - NoteStore.tagIndex(b));
    return allTags;
  }

  tagExists(tagName: string): boolean {
    return this.tagForName(tagName) !== null;
  }

  /// Compares the encoded tag hash, isolating from Unicode normalization issues.
  tagForName(tagName: string): Tag | null {
    const targetTagHash: string = tagHash(tagName);
    for (const tag of this.tags()) {
      if (tagHash(tag.name) === targetTagHash) {
        return tag;
      }
    }
    return null;
  }

  async editTag(tag: Tag, newTitle: string): Promise<void> {
    this.createTagFromStringAtIndex(newTitle, this.indexOfTag(tag));

    // Brute force renaming of all notes with this tag
    const notes: Note[] = this.notesWithTag(tag, false);
    for (const note of notes) {
      note.stripTag(tag.name);
      note.addTag(newTitle);
    }
    if (this.backend !== null) {
      this.backend.deleteTag(tag);
    }
    await this.save();
  }

  async removeTagName(tagName: string): Promise<boolean> {
    return this.removeTag(this.tagForName(tagName));
  }

  async removeTag(tag: Tag | null): Promise<boolean> {
    const tagList: Tag[] = this.tags();
    if (tag === null || this.backend === null) {
      hilog.error(DOMAIN, LOG_TAG, 'Critical error: tried to remove a tag that does not exist');
      return false;
    }
    const target: Tag = tag as Tag;

    // Strip this tag from all notes
    const notes: Note[] = this.notesWithTag(target, true);
    for (const note of notes) {
      note.stripTag(target.name);
    }

    // Decrement the index of all tags after this one
    const position: number = tagList.indexOf(target);
    if (position >= 0) {
      for (let i: number = position + 1; i < tagList.length; i++) {
        const tagToUpdate: Tag = tagList[i];
        tagToUpdate.index = NoteStore.tagIndex(tagToUpdate) - 1;
      }
    }
    this.backend.deleteTag(target);
    await this.save();
    return true;
  }

  createTagFromString(tagName: string): Tag | null {
    // Add tag at end
    return this.createTagFromStringAtIndex(tagName, this.tags().length);
  }

  createTagFromStringAtIndex(tagName: string, index: number): Tag | null {
    if (tagName === null || tagName === undefined || tagName.length === 0 || tagName === ' ') {
      hilog.warn(DOMAIN, LOG_TAG, 'Attempted to create empty tag');
      return null;
    }

    // Make sure email addresses don't get added as proper tags
    if (isValidEmailAddress(tagName)) {
      return null;
    }

    // Ensure the new tag has no spaces
    const newTagName: string = tagName.split(new RegExp('\\s')).join('');

    // Check for duplicate
    if (this.tagExists(newTagName) || this.backend === null) {
      return null;
    }

    // Update indexes depending on where the tag will be inserted
    let tagIndex: number = index;
    const tagList: Tag[] = this.tags();
    while (tagIndex < tagList.length) {
      tagList[tagIndex].index = tagIndex + 1;
      tagIndex++;
    }

    // Finally Insert the new Tag
    const newTag: Tag = this.backend.insertTag(tagHash(newTagName));
    newTag.index = index;
    newTag.name = newTagName;
    this.notifyChanged();
    return newTag;
  }

  indexOfTag(tag: Tag): number {
    return this.tags().indexOf(tag);
  }

  async moveTagFromIndex(fromIndex: number, toIndex: number): Promise<void> {
    const tagList: Tag[] = this.tags();
    if (fromIndex < 0 || fromIndex >= tagList.length) {
      return;
    }
    const tagListCopy: Tag[] = tagList.slice();
    const fromTag: Tag = tagList[fromIndex];

    tagListCopy.splice(toIndex + (fromIndex < toIndex ? 1 : 0), 0, fromTag);
    tagListCopy.splice(fromIndex + (fromIndex > toIndex ? 1 : 0), 1);

    for (const tag of tagList) {
      tag.index = tagListCopy.indexOf(tag);
    }
    await this.save();
  }

  async trashNote(note: Note): Promise<void> {
    note.deleted = true;
    note.modificationDate = new Date();
    await this.save();
  }

  async restoreNote(note: Note): Promise<void> {
    note.deleted = false;
    note.modificationDate = new Date();
    await this.save();
  }

  async permenentlyDeleteNote(note: Note): Promise<void> {
    if (this.backend !== null) {
      this.backend.deleteNote(note);
    }
    await this.save();
  }

  async emptyTrash(): Promise<void> {
    const notesToDelete: Note[] = this.notes().filter((n: Note): boolean => n.deleted === true);
    if (this.backend !== null) {
      for (const note of notesToDelete) {
        this.backend.deleteNote(note);
      }
    }
    await this.save();
  }

  // MARK: - Sharing

  async insertTagNamed(tagName: string, note: Note): Promise<void> {
    note.addTag(tagName);
    note.modificationDate = new Date();
    await this.save();
  }

  async removeTagNamed(tagName: string, note: Note): Promise<void> {
    note.stripTag(tagName);
    note.modificationDate = new Date();
    await this.save();
  }

  // MARK: - Updating Notes

  async updateMarkdownState(markdown: boolean, note: Note): Promise<void> {
    if (note.markdown === markdown) {
      return;
    }
    note.markdown = markdown;
    note.modificationDate = new Date();
    await this.save();
  }

  async updatePublishedState(published: boolean, note: Note): Promise<void> {
    if (note.published === published) {
      return;
    }
    note.published = published;
    note.modificationDate = new Date();
    await this.save();
  }

  async updatePinnedState(pinned: boolean, note: Note): Promise<void> {
    if (note.pinned === pinned) {
      return;
    }
    note.pinned = pinned;
    note.modificationDate = new Date();
    await this.save();
  }

  // MARK: - SPObjectManager+Simplenote.swift

  newDefaultNote(): Note | null {
    if (this.backend === null) {
      hilog.error(DOMAIN, LOG_TAG, 'newDefaultNote without an attached backend');
      return null;
    }
    const note: Note = this.backend.insertNote();
    note.modificationDate = new Date();
    note.creationDate = new Date();
    // Markdown follows the global preference (defaults NO for new accounts)
    note.markdown = Options.shared.markdown;
    return note;
  }

  newNoteWithContent(content: string | null, tags: string[] | null): Note | null {
    const newNote: Note | null = this.newDefaultNote();
    if (newNote === null) {
      return null;
    }
    const note: Note = newNote as Note;
    if (content !== null) {
      note.content = content;
    }
    if (tags !== null) {
      for (const raw of tags) {
        const tag: string = raw.split(new RegExp('\\s')).join('');
        if (tag.length === 0) {
          continue;
        }
        note.addTag(tag);
        this.createTagFromString(tag);
      }
    }
    return note;
  }

  notesWithTag(tag: Tag | null, includeDeleted: boolean): Note[] {
    if (tag === null) {
      return [];
    }
    const tagName: string = (tag as Tag).name;
    return this.notes().filter((note: Note): boolean =>
      noteHasTagNamed(note, tagName) && (includeDeleted || note.deleted !== true));
  }

  /// Editor autosave: 2 s debounce after the last keystroke, guaranteed save every 21 s while typing.
  updateContent(note: Note, content: string): void {
    this.pendingContentNote = note;
    this.pendingContent = content;
    if (this.debounceTimer >= 0) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout((): void => {
      this.flushPendingContent();
    }, CONTENT_SAVE_DEBOUNCE_MS);
    if (this.guaranteedTimer < 0) {
      this.guaranteedTimer = setTimeout((): void => {
        this.flushPendingContent();
      }, CONTENT_SAVE_GUARANTEED_MS);
    }
  }

  /// Drops the debounced editor write: the editor already put its text into the note (willReceiveNewContent),
  /// and a late flush would put that pre-merge text back over the merged remote change.
  cancelPendingContent(): void {
    clearTimeout(this.debounceTimer);
    clearTimeout(this.guaranteedTimer);
    this.debounceTimer = -1;
    this.guaranteedTimer = -1;
    this.pendingContentNote = null;
  }

  /// Saves any pending editor content immediately (resign-active / terminate / editor close).
  flushPendingContent(): void {
    if (this.debounceTimer >= 0) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = -1;
    }
    if (this.guaranteedTimer >= 0) {
      clearTimeout(this.guaranteedTimer);
      this.guaranteedTimer = -1;
    }
    if (this.pendingContentNote === null) {
      return;
    }
    const note: Note = this.pendingContentNote as Note;
    this.pendingContentNote = null;
    if (note.content === this.pendingContent) {
      return;
    }
    note.content = this.pendingContent;
    note.modificationDate = new Date();
    this.save();
  }

  private static tagIndex(tag: Tag): number {
    return tag.index === undefined || tag.index === null ? 0 : tag.index;
  }
}

// Source-symbol alias (SPObjectManager.sharedManager()).
export { NoteStore as SPObjectManager };
