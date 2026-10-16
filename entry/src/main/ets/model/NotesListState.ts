// Port of NotesListState.swift, with the NSPredicate / NSSortDescriptor builders it calls
// (NSSortDescriptor+Simplenote.swift, SimplenoteSearch's NSPredicate+Search.swift). Core Data
// predicates and sort descriptors become typed filter / comparator functions over the entities.
import { Note, caseInsensitiveCompare } from './Note';
import { NotesListFilter, NotesListFilterKind } from './NotesListFilter';
import { SearchQuery, SearchQueryItemKind } from './SearchQuery';
import { SortMode } from './SortMode';
import { Tag } from './Tag';

export type NotePredicate = (note: Note) => boolean;
export type TagPredicate = (tag: Tag) => boolean;
export type NoteSortDescriptor = (lhs: Note, rhs: Note) => number;
export type TagSortDescriptor = (lhs: Tag, rhs: Tag) => number;

export enum NotesListStateKind {
  RESULTS = 0,
  SEARCHING = 1
}

/** [cd]: case and diacritic insensitive */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function containsCD(haystack: string, needle: string): boolean {
  return fold(haystack).indexOf(fold(needle)) !== -1;
}

/** `tags CONTAINS[c] "\"<tag>\""`: an element of the JSON tag list equal to the tag */
function hasTagElement(note: Note, tag: string, diacriticInsensitive: boolean): boolean {
  const target = diacriticInsensitive ? fold(tag) : tag.toLowerCase();
  for (const element of note.tagsArray) {
    const candidate = diacriticInsensitive ? fold(element) : element.toLowerCase();
    if (candidate === target) {
      return true;
    }
  }
  return false;
}

// MARK: - NSPredicate builders

/** NSPredicate.predicateForNotes(deleted:) */
export function predicateForNotesDeleted(deleted: boolean): NotePredicate {
  return (note: Note) => note.deleted === deleted;
}

/** NSPredicate.predicateForNotes(tag:) */
export function predicateForNotesTag(tag: string): NotePredicate {
  return (note: Note) => hasTagElement(note, tag, false);
}

/** NSPredicate.predicateForUntaggedNotes(): empty, null or an empty JSON list */
export function predicateForUntaggedNotes(): NotePredicate {
  const regex = /^(\s*\[\s*]\s*)$/;
  return (note: Note) => {
    const tags = note.tags;
    return tags === null || tags.length === 0 || tags === 'null' || regex.test(tags);
  };
}

/** NSPredicate.predicateForNotes(query:) */
export function predicateForNotesQuery(query: SearchQuery): NotePredicate {
  const predicates: NotePredicate[] = [];
  for (const item of query.items) {
    if (item.kind === SearchQueryItemKind.KEYWORD) {
      const keyword = item.value;
      predicates.push((note: Note) => containsCD(note.content, keyword));
    } else if (item.value.length > 0) {
      const tag = item.value;
      predicates.push((note: Note) => hasTagElement(note, tag, true));
    }
  }
  return (note: Note) => predicates.every((p: NotePredicate) => p(note));
}

/** NSPredicate.predicateForTags(in:) */
export function predicateForTagsInQuery(query: SearchQuery): TagPredicate {
  if (query.items.length === 0) {
    return (tag: Tag) => true;
  }
  const lastItem = query.items[query.items.length - 1];
  const value = lastItem.value;
  if (lastItem.kind === SearchQueryItemKind.KEYWORD) {
    return (tag: Tag) => containsCD(tag.name ?? '', value);
  }
  if (value.length === 0) {
    return (tag: Tag) => true;
  }
  return (tag: Tag) => containsCD(tag.name ?? '', value) && tag.name.toLowerCase() !== value.toLowerCase();
}

// MARK: - NSSortDescriptor builders

/** NSSortDescriptor.descriptorForNotes(sortMode:) */
export function descriptorForNotes(sortMode: SortMode): NoteSortDescriptor {
  switch (sortMode) {
    case SortMode.ALPHABETICALLY_ASCENDING:
      return (lhs: Note, rhs: Note) => caseInsensitiveCompare(lhs.content, rhs.content);
    case SortMode.ALPHABETICALLY_DESCENDING:
      return (lhs: Note, rhs: Note) => caseInsensitiveCompare(rhs.content, lhs.content);
    case SortMode.CREATED_NEWEST:
      return (lhs: Note, rhs: Note) => rhs.creationDate.getTime() - lhs.creationDate.getTime();
    case SortMode.CREATED_OLDEST:
      return (lhs: Note, rhs: Note) => lhs.creationDate.getTime() - rhs.creationDate.getTime();
    case SortMode.MODIFIED_NEWEST:
      return (lhs: Note, rhs: Note) => rhs.modificationDate.getTime() - lhs.modificationDate.getTime();
    case SortMode.MODIFIED_OLDEST:
    default:
      return (lhs: Note, rhs: Note) => lhs.modificationDate.getTime() - rhs.modificationDate.getTime();
  }
}

/** NSSortDescriptor.descriptorForPinnedNotes(): pinned notes on top */
export function descriptorForPinnedNotes(): NoteSortDescriptor {
  return (lhs: Note, rhs: Note) => (rhs.pinned ? 1 : 0) - (lhs.pinned ? 1 : 0);
}

/** NSSortDescriptor.descriptorForTags(): by name, case-insensitive ascending */
export function descriptorForTags(): TagSortDescriptor {
  return (lhs: Tag, rhs: Tag) => caseInsensitiveCompare(lhs.name, rhs.name);
}

/** Applies a list of sort descriptors in order (NSArray sortedArrayUsingDescriptors:) */
export function sortNotes(notes: Note[], descriptors: NoteSortDescriptor[]): Note[] {
  return notes.slice().sort((lhs: Note, rhs: Note) => {
    for (const descriptor of descriptors) {
      const result = descriptor(lhs, rhs);
      if (result !== 0) {
        return result;
      }
    }
    return 0;
  });
}

export function sortTags(tags: Tag[], descriptors: TagSortDescriptor[]): Tag[] {
  return tags.slice().sort((lhs: Tag, rhs: Tag) => {
    for (const descriptor of descriptors) {
      const result = descriptor(lhs, rhs);
      if (result !== 0) {
        return result;
      }
    }
    return 0;
  });
}

// MARK: - NotesListState

export class NotesListState {
  static readonly RESULTS: NotesListState = new NotesListState(NotesListStateKind.RESULTS, null);

  readonly kind: NotesListStateKind;
  /** The query of `.searching(query:)` */
  readonly query: SearchQuery | null;

  constructor(kind: NotesListStateKind, query: SearchQuery | null) {
    this.kind = kind;
    this.query = query;
  }

  static results(): NotesListState {
    return NotesListState.RESULTS;
  }

  static searching(query: SearchQuery): NotesListState {
    return new NotesListState(NotesListStateKind.SEARCHING, query);
  }

  /** Equatable */
  equals(other: NotesListState): boolean {
    if (this.kind !== other.kind) {
      return false;
    }
    if (this.query === null || other.query === null) {
      return this.query === other.query;
    }
    return this.query.equals(other.query);
  }

  /** Indicates if the NotesList should display Note Entities for the current state */
  get displaysNotes(): boolean {
    return true;
  }

  /** Indicates if the NotesList should display Tag Entities for the current state */
  get displaysTags(): boolean {
    return this.kind === NotesListStateKind.SEARCHING;
  }

  /** Returns the SectionIndex for Notes, in the current state */
  get sectionIndexForNotes(): number {
    return this.kind === NotesListStateKind.SEARCHING ? 1 : 0;
  }

  /** Returns the SectionIndex for Tags, in the current state */
  get sectionIndexForTags(): number {
    return 0;
  }

  /** Returns the SectionTitle for Notes, in the current state */
  get sectionTitleForNotes(): string | null {
    return this.kind === NotesListStateKind.SEARCHING ? 'Notes' : null;
  }

  /** Returns the SectionTitle for Tags, in the current state */
  get sectionTitleForTags(): string | null {
    return this.kind === NotesListStateKind.SEARCHING ? 'Search by Tag' : null;
  }

  /** Indicates if we should adjust SectionIndexes for ResultsController Changes entities */
  get requiresNoteSectionIndexAdjustments(): boolean {
    return this.kind === NotesListStateKind.SEARCHING;
  }

  /** Returns a predicate to filter out Notes in the current state, with the specified Filter */
  predicateForNotes(filter: NotesListFilter): NotePredicate | null {
    const subpredicates: NotePredicate[] = [];
    if (this.kind === NotesListStateKind.RESULTS || this.query === null) {
      subpredicates.push(predicateForNotesDeleted(filter.kind === NotesListFilterKind.DELETED));
      if (filter.kind === NotesListFilterKind.TAG) {
        subpredicates.push(predicateForNotesTag(filter.name));
      } else if (filter.kind === NotesListFilterKind.UNTAGGED) {
        subpredicates.push(predicateForUntaggedNotes());
      }
    } else {
      subpredicates.push(predicateForNotesDeleted(false));
      subpredicates.push(predicateForNotesQuery(this.query));
    }
    return (note: Note) => subpredicates.every((p: NotePredicate) => p(note));
  }

  /** Returns a predicate to filter out Tags in the current state */
  predicateForTags(): TagPredicate | null {
    if (this.kind !== NotesListStateKind.SEARCHING || this.query === null) {
      return null;
    }
    return predicateForTagsInQuery(this.query);
  }

  /** Sort descriptors that reflect the specified SortMode over a Notes collection */
  descriptorsForNotes(sortMode: SortMode): NoteSortDescriptor[] {
    const descriptors: NoteSortDescriptor[] = [];
    if (this.kind === NotesListStateKind.RESULTS) {
      descriptors.push(descriptorForPinnedNotes());
    }
    // Search shouldn't be affected by pinned notes
    descriptors.push(descriptorForNotes(sortMode));
    return descriptors;
  }

  /** Sort descriptors for a Tags collection */
  descriptorsForTags(): TagSortDescriptor[] {
    return [descriptorForTags()];
  }
}
