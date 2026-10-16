// Port of SortMode.swift: every possible Sort Mode of the notes list. The raw values are the
// integers persisted by Options.listSortMode, so their order must never change.

export enum SortMode {
  /** Order: A-Z */
  ALPHABETICALLY_ASCENDING = 0,
  /** Order: Z-A */
  ALPHABETICALLY_DESCENDING = 1,
  /** Order: Newest on Top */
  CREATED_NEWEST = 2,
  /** Order: Oldest on Top */
  CREATED_OLDEST = 3,
  /** Order: Newest on Top */
  MODIFIED_NEWEST = 4,
  /** Order: Oldest on Top */
  MODIFIED_OLDEST = 5
}

export class SortModeInfo {
  /** CaseIterable.allCases */
  static readonly ALL_CASES: SortMode[] = [
    SortMode.ALPHABETICALLY_ASCENDING,
    SortMode.ALPHABETICALLY_DESCENDING,
    SortMode.CREATED_NEWEST,
    SortMode.CREATED_OLDEST,
    SortMode.MODIFIED_NEWEST,
    SortMode.MODIFIED_OLDEST
  ];

  /** SortMode(rawValue:) */
  static fromRawValue(rawValue: number): SortMode | null {
    return SortModeInfo.ALL_CASES.indexOf(rawValue as SortMode) !== -1 ? rawValue as SortMode : null;
  }

  /** Returns a localized Description, matching the current rawValue */
  static description(mode: SortMode): string {
    switch (mode) {
      case SortMode.ALPHABETICALLY_ASCENDING:
        return 'Name: A-Z';
      case SortMode.ALPHABETICALLY_DESCENDING:
        return 'Name: Z-A';
      case SortMode.CREATED_NEWEST:
        return 'Created: Newest';
      case SortMode.CREATED_OLDEST:
        return 'Created: Oldest';
      case SortMode.MODIFIED_NEWEST:
        return 'Modified: Newest';
      case SortMode.MODIFIED_OLDEST:
        return 'Modified: Oldest';
      default:
        return '';
    }
  }
}
