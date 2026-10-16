// Port of Simplenote/Classes/NotesListController.swift (+ NotesListState.swift, NotesListFilter.swift,
// NSSortDescriptor+Simplenote.swift, SimplenoteSearch NSPredicate+Search / SearchQuery).
// The NSFetchedResultsController pair becomes two in-memory result sets refetched from NoteStore
// whenever NoteStore reports a change.
import { Note } from '../model/Note';
import { Tag } from '../model/Tag';
import { SortMode } from '../model/SortMode';
import { NoteStore, noteHasTagNamed, noteIsUntagged } from './NoteStore';

export const SIMPLENOTE_TRASH_KEY: string = '__##__trash__##__';
export const SIMPLENOTE_UNTAGGED_KEY: string = '__##__untagged__##__';
const TAGS_KEYWORD: string = 'tag:';

// MARK: - NotesListState

export enum NotesListMode {
  RESULTS = 'results',
  SEARCHING = 'searching'
}

// MARK: - NotesListFilter

export enum ListFilterKind {
  EVERYTHING = 'everything',
  DELETED = 'deleted',
  UNTAGGED = 'untagged',
  TAG = 'tag'
}

export class ListFilter {
  kind: ListFilterKind = ListFilterKind.EVERYTHING;
  tagName: string = '';

  constructor(kind: ListFilterKind, tagName: string) {
    this.kind = kind;
    this.tagName = tagName;
  }

  /// NotesListFilter(selectedTag:)
  static fromSelectedTag(selectedTag: string | null | undefined): ListFilter {
    if (selectedTag === null || selectedTag === undefined || selectedTag.length === 0) {
      return new ListFilter(ListFilterKind.EVERYTHING, '');
    }
    if (selectedTag === SIMPLENOTE_TRASH_KEY) {
      return new ListFilter(ListFilterKind.DELETED, '');
    }
    if (selectedTag === SIMPLENOTE_UNTAGGED_KEY) {
      return new ListFilter(ListFilterKind.UNTAGGED, '');
    }
    return new ListFilter(ListFilterKind.TAG, selectedTag);
  }

  get title(): string {
    if (this.kind === ListFilterKind.DELETED) {
      return 'Trash';
    }
    if (this.kind === ListFilterKind.UNTAGGED) {
      return 'Untagged';
    }
    if (this.kind === ListFilterKind.TAG) {
      return this.tagName;
    }
    return 'All Notes';
  }

  equals(other: ListFilter): boolean {
    return this.kind === other.kind && this.tagName === other.tagName;
  }
}

// MARK: - SearchQuery (SimplenoteSearch)

export enum SearchItemKind {
  KEYWORD = 'keyword',
  TAG = 'tag'
}

export class SearchItem {
  kind: SearchItemKind;
  value: string;

  constructor(kind: SearchItemKind, value: string) {
    this.kind = kind;
    this.value = value;
  }
}

export class ListSearchQuery {
  searchText: string;
  items: SearchItem[] = [];

  constructor(searchText: string) {
    this.searchText = searchText;
    const keywords: string[] = searchText.trim().split(new RegExp('\\s'));
    for (const keyword of keywords) {
      if (keyword.length === 0) {
        continue;
      }
      const lowered: string = keyword.toLowerCase();
      if (lowered.startsWith(TAGS_KEYWORD)) {
        this.items.push(new SearchItem(SearchItemKind.TAG, lowered.substring(TAGS_KEYWORD.length)));
      } else {
        this.items.push(new SearchItem(SearchItemKind.KEYWORD, keyword));
      }
    }
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  equals(other: ListSearchQuery): boolean {
    if (this.items.length !== other.items.length) {
      return false;
    }
    for (let i: number = 0; i < this.items.length; i++) {
      if (this.items[i].kind !== other.items[i].kind || this.items[i].value !== other.items[i].value) {
        return false;
      }
    }
    return true;
  }
}

// MARK: - Sections / IndexPath

export type ListObject = Note | Tag;

export class ListIndexPath {
  section: number;
  row: number;

  constructor(row: number, section: number) {
    this.row = row;
    this.section = section;
  }
}

export class NotesListSection {
  title: string | null;
  objects: ListObject[];

  constructor(title: string | null, objects: ListObject[]) {
    this.title = title;
    this.objects = objects;
  }

  get numberOfObjects(): number {
    return this.objects.length;
  }

  get displaysTitle(): boolean {
    return this.title !== null && this.numberOfObjects > 0;
  }
}

// MARK: - Matching helpers ([cd] = case + diacritic insensitive)

function fold(text: string): string {
  return text.normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toLowerCase();
}

function containsCD(haystack: string | null | undefined, needle: string): boolean {
  if (haystack === null || haystack === undefined) {
    return false;
  }
  return fold(haystack).indexOf(fold(needle)) >= 0;
}

function caseInsensitiveCompare(a: string | null | undefined, b: string | null | undefined): number {
  const x: string = a === null || a === undefined ? '' : a.toLowerCase();
  const y: string = b === null || b === undefined ? '' : b.toLowerCase();
  return x < y ? -1 : (x > y ? 1 : 0);
}

function dateValue(d: Date | null | undefined): number {
  return d === null || d === undefined ? 0 : d.getTime();
}

// MARK: - NotesListController

export class NotesListController {
  /// Indicates the maximum number of Tag results we'll yield
  readonly limitForTagResults: number = 5;

  private store: NoteStore;
  private stateValue: NotesListMode = NotesListMode.RESULTS;
  private query: ListSearchQuery | null = null;
  private filterValue: ListFilter = new ListFilter(ListFilterKind.EVERYTHING, '');
  private sortModeValue: SortMode = SortMode.ALPHABETICALLY_ASCENDING;
  private fetchedNotes: Note[] = [];
  private fetchedTags: Tag[] = [];
  private notesPredicate: (note: Note) => boolean = (note: Note): boolean => note.deleted !== true;
  private tagsPredicate: ((tag: Tag) => boolean) | null = null;
  private notesComparators: Array<(a: Note, b: Note) => number> = [];
  private readonly storeListener: () => void;

  /// Executed whenever the notes or tags results changed, as long as the current state renders them.
  onBatchChanges: (() => void) | null = null;

  constructor(store: NoteStore) {
    this.store = store;
    this.storeListener = (): void => {
      this.onStoreDidChange();
    };
    this.refreshPredicates();
    this.refreshSortDescriptors();
    this.startListeningToNoteEvents();
    this.startListeningToTagEvents();
  }

  /// Detaches from NoteStore. Call from the owning page's aboutToDisappear.
  destroy(): void {
    this.store.removeChangeListener(this.storeListener);
  }

  // MARK: - State / filter / sort

  get state(): NotesListMode {
    return this.stateValue;
  }

  private setState(newState: NotesListMode, newQuery: ListSearchQuery | null): void {
    const sameQuery: boolean = (this.query === null && newQuery === null) ||
      (this.query !== null && newQuery !== null && (this.query as ListSearchQuery).equals(newQuery as ListSearchQuery));
    if (this.stateValue === newState && sameQuery) {
      return;
    }
    this.stateValue = newState;
    this.query = newQuery;
    this.refreshEverything();
  }

  get searchQuery(): ListSearchQuery | null {
    return this.query;
  }

  get filter(): ListFilter {
    return this.filterValue;
  }

  set filter(newValue: ListFilter) {
    if (this.filterValue.equals(newValue)) {
      return;
    }
    this.filterValue = newValue;
    this.refreshPredicates();
  }

  get sortMode(): SortMode {
    return this.sortModeValue;
  }

  set sortMode(newValue: SortMode) {
    if (this.sortModeValue === newValue) {
      return;
    }
    this.sortModeValue = newValue;
    this.refreshSortDescriptors();
  }

  // MARK: - NotesListState properties

  get displaysNotes(): boolean {
    return true;
  }

  get displaysTags(): boolean {
    return this.stateValue === NotesListMode.SEARCHING;
  }

  get sectionIndexForNotes(): number {
    return this.stateValue === NotesListMode.SEARCHING ? 1 : 0;
  }

  get sectionIndexForTags(): number {
    return 0;
  }

  get sectionTitleForNotes(): string | null {
    return this.stateValue === NotesListMode.SEARCHING ? 'Notes' : null;
  }

  get sectionTitleForTags(): string | null {
    return this.stateValue === NotesListMode.SEARCHING ? 'Search by Tag' : null;
  }

  get requiresNoteSectionIndexAdjustments(): boolean {
    return this.stateValue === NotesListMode.SEARCHING;
  }

  // MARK: - Public API

  get numberOfObjects(): number {
    if (this.stateValue === NotesListMode.SEARCHING) {
      return this.fetchedTags.length + this.fetchedNotes.length;
    }
    return this.fetchedNotes.length;
  }

  get sections(): NotesListSection[] {
    if (this.stateValue === NotesListMode.SEARCHING) {
      return [
        new NotesListSection(this.sectionTitleForTags, this.fetchedTags),
        new NotesListSection(this.sectionTitleForNotes, this.fetchedNotes)
      ];
    }
    return [new NotesListSection(this.sectionTitleForNotes, this.fetchedNotes)];
  }

  /// Notes of the current results, in display order (convenience for list data sources).
  get notes(): Note[] {
    return this.fetchedNotes;
  }

  /// Tag results (search mode only).
  get tags(): Tag[] {
    return this.fetchedTags;
  }

  object(indexPath: ListIndexPath): ListObject | null {
    if (this.stateValue === NotesListMode.RESULTS) {
      return indexPath.section === 0 && indexPath.row < this.fetchedNotes.length ? this.fetchedNotes[indexPath.row] : null;
    }
    if (indexPath.section === this.sectionIndexForTags) {
      return indexPath.row < this.fetchedTags.length ? this.fetchedTags[indexPath.row] : null;
    }
    if (indexPath.section === this.sectionIndexForNotes) {
      return indexPath.row < this.fetchedNotes.length ? this.fetchedNotes[indexPath.row] : null;
    }
    return null;
  }

  indexPath(forObject: ListObject): ListIndexPath | null {
    if (forObject instanceof Tag) {
      if (this.stateValue !== NotesListMode.SEARCHING) {
        return null;
      }
      const tagRow: number = this.fetchedTags.indexOf(forObject as Tag);
      return tagRow >= 0 ? new ListIndexPath(tagRow, this.sectionIndexForTags) : null;
    }
    const row: number = this.fetchedNotes.indexOf(forObject as Note);
    return row >= 0 ? new ListIndexPath(row, this.sectionIndexForNotes) : null;
  }

  /// Reloads all of the FetchedObjects, as needed
  performFetch(): void {
    if (this.displaysNotes) {
      const notes: Note[] = this.store.notes().filter(this.notesPredicate);
      const comparators: Array<(a: Note, b: Note) => number> = this.notesComparators;
      notes.sort((a: Note, b: Note): number => {
        for (const cmp of comparators) {
          const r: number = cmp(a, b);
          if (r !== 0) {
            return r;
          }
        }
        return 0;
      });
      this.fetchedNotes = notes;
    }

    if (this.displaysTags && this.tagsPredicate !== null) {
      const predicate: (tag: Tag) => boolean = this.tagsPredicate as (tag: Tag) => boolean;
      const tags: Tag[] = this.store.tags().filter(predicate);
      tags.sort((a: Tag, b: Tag): number => caseInsensitiveCompare(a.name, b.name));
      this.fetchedTags = tags.slice(0, this.limitForTagResults);
    } else {
      this.fetchedTags = [];
    }
  }

  // MARK: - Search API

  beginSearch(): void {
    // Initially meant for History; kept for parity. Search state starts on the first keyword.
    this.query = null;
  }

  /// Whenever the Keyword is actually empty, we fall back to regular results.
  refreshSearchResults(keyword: string): void {
    const query: ListSearchQuery = new ListSearchQuery(keyword);
    if (query.isEmpty) {
      this.setState(NotesListMode.RESULTS, null);
      return;
    }
    this.setState(NotesListMode.SEARCHING, query);
  }

  endSearch(): void {
    this.setState(NotesListMode.RESULTS, null);
  }

  // MARK: - Convenience

  note(forSimperiumKey: string): Note | null {
    for (const n of this.fetchedNotes) {
      if (n.simperiumKey === forSimperiumKey) {
        return n;
      }
    }
    return null;
  }

  // MARK: - ResultsController refreshing

  refreshPredicates(): void {
    this.notesPredicate = this.predicateForNotes(this.filterValue);
    this.tagsPredicate = this.predicateForTags();
  }

  refreshSortDescriptors(): void {
    this.notesComparators = this.descriptorsForNotes(this.sortModeValue);
  }

  refreshEverything(): void {
    this.refreshPredicates();
    this.refreshSortDescriptors();
    this.performFetch();
  }

  predicateForNotes(filter: ListFilter): (note: Note) => boolean {
    if (this.stateValue === NotesListMode.SEARCHING && this.query !== null) {
      const items: SearchItem[] = (this.query as ListSearchQuery).items;
      return (note: Note): boolean => {
        if (note.deleted === true) {
          return false;
        }
        for (const item of items) {
          if (item.kind === SearchItemKind.KEYWORD && !containsCD(note.content, item.value)) {
            return false;
          }
          if (item.kind === SearchItemKind.TAG && item.value.length > 0 && !noteHasTagNamed(note, item.value)) {
            return false;
          }
        }
        return true;
      };
    }
    const wantDeleted: boolean = filter.kind === ListFilterKind.DELETED;
    if (filter.kind === ListFilterKind.TAG) {
      const name: string = filter.tagName;
      return (note: Note): boolean => (note.deleted === true) === wantDeleted && noteHasTagNamed(note, name);
    }
    if (filter.kind === ListFilterKind.UNTAGGED) {
      return (note: Note): boolean => (note.deleted === true) === wantDeleted && noteIsUntagged(note);
    }
    return (note: Note): boolean => (note.deleted === true) === wantDeleted;
  }

  predicateForTags(): ((tag: Tag) => boolean) | null {
    if (this.stateValue !== NotesListMode.SEARCHING || this.query === null) {
      return null;
    }
    const items: SearchItem[] = (this.query as ListSearchQuery).items;
    if (items.length === 0) {
      return (tag: Tag): boolean => true;
    }
    const lastItem: SearchItem = items[items.length - 1];
    const value: string = lastItem.value;
    if (lastItem.kind === SearchItemKind.KEYWORD) {
      return (tag: Tag): boolean => containsCD(tag.name, value);
    }
    if (value.length === 0) {
      return (tag: Tag): boolean => true;
    }
    return (tag: Tag): boolean => containsCD(tag.name, value) && caseInsensitiveCompare(tag.name, value) !== 0;
  }

  descriptorsForNotes(sortMode: SortMode): Array<(a: Note, b: Note) => number> {
    const descriptors: Array<(a: Note, b: Note) => number> = [];
    if (this.stateValue === NotesListMode.RESULTS) {
      // Pinned first; search isn't affected by pinned notes
      descriptors.push((a: Note, b: Note): number => (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0));
    }
    descriptors.push(NotesListController.descriptorForNotes(sortMode));
    return descriptors;
  }

  private static descriptorForNotes(sortMode: SortMode): (a: Note, b: Note) => number {
    if (sortMode === SortMode.ALPHABETICALLY_ASCENDING) {
      return (a: Note, b: Note): number => caseInsensitiveCompare(a.content, b.content);
    }
    if (sortMode === SortMode.ALPHABETICALLY_DESCENDING) {
      return (a: Note, b: Note): number => caseInsensitiveCompare(b.content, a.content);
    }
    if (sortMode === SortMode.CREATED_NEWEST) {
      return (a: Note, b: Note): number => dateValue(b.creationDate) - dateValue(a.creationDate);
    }
    if (sortMode === SortMode.CREATED_OLDEST) {
      return (a: Note, b: Note): number => dateValue(a.creationDate) - dateValue(b.creationDate);
    }
    if (sortMode === SortMode.MODIFIED_NEWEST) {
      return (a: Note, b: Note): number => dateValue(b.modificationDate) - dateValue(a.modificationDate);
    }
    return (a: Note, b: Note): number => dateValue(a.modificationDate) - dateValue(b.modificationDate);
  }

  // MARK: - Realtime refreshing

  startListeningToNoteEvents(): void {
    this.store.addChangeListener(this.storeListener);
  }

  startListeningToTagEvents(): void {
    // Notes and tags share NoteStore's single change stream; one listener serves both result sets.
    this.fetchedTags = [];
  }

  notifyNotesDidChange(): void {
    if (!this.displaysNotes) {
      return;
    }
    if (this.onBatchChanges !== null) {
      this.onBatchChanges();
    }
  }

  notifyTagsDidChange(): void {
    if (!this.displaysTags) {
      return;
    }
    if (this.onBatchChanges !== null) {
      this.onBatchChanges();
    }
  }

  private onStoreDidChange(): void {
    this.performFetch();
    this.notifyNotesDidChange();
    this.notifyTagsDidChange();
  }
}
