// Port of NotesListFilter.swift: which notes the list shows. The `tag(name:)` case carries the
// tag name. The selected-tag sentinels are SPConstants' kSimplenoteTrashKey / kSimplenoteUntaggedKey.

export const SIMPLENOTE_TRASH_KEY: string = '__##__trash__##__';
export const SIMPLENOTE_UNTAGGED_KEY: string = '__##__untagged__##__';

export enum NotesListFilterKind {
  EVERYTHING = 0,
  DELETED = 1,
  UNTAGGED = 2,
  TAG = 3
}

export class NotesListFilter {
  static readonly EVERYTHING: NotesListFilter = new NotesListFilter(NotesListFilterKind.EVERYTHING);
  static readonly DELETED: NotesListFilter = new NotesListFilter(NotesListFilterKind.DELETED);
  static readonly UNTAGGED: NotesListFilter = new NotesListFilter(NotesListFilterKind.UNTAGGED);

  readonly kind: NotesListFilterKind;
  /** The tag name, for `.tag(name:)` */
  readonly name: string;

  constructor(kind: NotesListFilterKind, name: string = '') {
    this.kind = kind;
    this.name = name;
  }

  static tag(name: string): NotesListFilter {
    return new NotesListFilter(NotesListFilterKind.TAG, name);
  }

  /** init(selectedTag:) */
  static fromSelectedTag(selectedTag: string | null | undefined): NotesListFilter {
    if (selectedTag === null || selectedTag === undefined || selectedTag.length === 0) {
      return NotesListFilter.EVERYTHING;
    }
    if (selectedTag === SIMPLENOTE_TRASH_KEY) {
      return NotesListFilter.DELETED;
    }
    if (selectedTag === SIMPLENOTE_UNTAGGED_KEY) {
      return NotesListFilter.UNTAGGED;
    }
    return NotesListFilter.tag(selectedTag);
  }

  /** Filter's visible Title */
  get title(): string {
    switch (this.kind) {
      case NotesListFilterKind.EVERYTHING:
        return 'All Notes';
      case NotesListFilterKind.DELETED:
        return 'Trash';
      case NotesListFilterKind.UNTAGGED:
        return 'Untagged';
      default:
        return this.name;
    }
  }

  /** Equatable */
  equals(other: NotesListFilter): boolean {
    return this.kind === other.kind && this.name === other.name;
  }
}
