// Port of SimplenoteSearch-Swift: Extensions/NSPredicate+Search.swift, Interfaces/Searchable*.swift
// NSPredicate strings become in-memory predicates with the same operator semantics
// (CONTAINS[cd] = case + diacritic insensitive, [c] = case insensitive, MATCHES = whole-string regex),
// consumed by foundation/ResultsController as its `predicate`.
import { SearchQuery, SearchQueryItem, SearchQueryItemKind, SearchQuerySettings } from './SearchQuery';

/// Defines the properties a Note Entity must have (`tags` / `systemTags` are the JSON-encoded arrays)
export interface SearchableNote {
  content: string;
  deleted: boolean;
  systemTags: string;
  tags: string;
}

/// Defines the properties a Tag Entity must have
export interface SearchableTag {
  name: string;
}

export type NotePredicate = (note: SearchableNote) => boolean;
export type TagPredicate = (tag: SearchableTag) => boolean;

// MARK: - Operator helpers

function foldCase(value: string): string {
  return value.toLowerCase();
}

function foldCaseAndDiacritics(value: string): string {
  return value.normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toLowerCase();
}

function containsCD(haystack: string | null, needle: string): boolean {
  return haystack !== null && foldCaseAndDiacritics(haystack).includes(foldCaseAndDiacritics(needle));
}

function containsC(haystack: string | null, needle: string): boolean {
  return haystack !== null && foldCase(haystack).includes(foldCase(needle));
}

function andAll<T>(predicates: ((o: T) => boolean)[]): (o: T) => boolean {
  return (o: T): boolean => {
    for (const p of predicates) {
      if (!p(o)) {
        return false;
      }
    }
    return true;
  };
}

/// Returns the received tag, escaped and surrounded by quotes: ensures only *exact* tag matches are hit
function formattedTag(tag: string): string {
  const filtered: string = tag.split('\\').join('\\\\').split('/').join('\\/');
  return '"' + filtered + '"';
}

// MARK: - Notes

/// Compound (AND) predicate matching a given Search Query
export function predicateForNotesWithQuery(query: SearchQuery): NotePredicate {
  const predicates: NotePredicate[] = [];
  for (const item of query.items) {
    const value: string = item.value;
    if (item.kind === SearchQueryItemKind.KEYWORD) {
      predicates.push((note: SearchableNote): boolean => containsCD(note.content, value));
    } else {
      if (value.length === 0) {
        continue;
      }
      const tag: string = formattedTag(value);
      predicates.push((note: SearchableNote): boolean => containsCD(note.tags, tag));
    }
  }

  if (predicates.length === 0) {
    return (note: SearchableNote): boolean => true;
  }
  return andAll<SearchableNote>(predicates);
}

export function predicateForNotesWithSearchText(searchText: string, settings: SearchQuerySettings): NotePredicate {
  return predicateForNotesWithQuery(new SearchQuery(searchText, settings));
}

/// Matches Notes with the specified `deleted` flag
export function predicateForNotesWithDeleted(deleted: boolean): NotePredicate {
  return (note: SearchableNote): boolean => note.deleted === deleted;
}

/// Exact (case-sensitive) match of the specified keyword
export function predicateForNotesWithExactMatch(keyword: string): NotePredicate {
  return (note: SearchableNote): boolean => note.content !== null && note.content.includes(keyword);
}

/// Matches a given System Tag
export function predicateForNotesWithSystemTag(systemTag: string): NotePredicate {
  return (note: SearchableNote): boolean => containsC(note.systemTags, systemTag);
}

/// Matches a given Tag
export function predicateForNotesWithTag(tag: string): NotePredicate {
  const formatted: string = formattedTag(tag);
  return (note: SearchableNote): boolean => containsC(note.tags, formatted);
}

// Empty String  (OR)  "null"  (OR)  Spaces* + [ + Spaces* + ] + Spaces*  — MATCHES is whole-string
const UNTAGGED_REGEX: RegExp = new RegExp('^(?:()|(null)|(\\s*\\[\\s*]\\s*))$');

/// Matches Empty JSON Arrays (with random padding) and Empty Strings
export function predicateForUntaggedNotes(): NotePredicate {
  return (note: SearchableNote): boolean => UNTAGGED_REGEX.test(note.tags ?? '');
}

// MARK: - Tags

/// Tags matching the LAST token of a query:
///  - `tag:` payload: names containing it, excluding exact (case-insensitive) matches
///  - keyword: names containing it
///  - `tag:` with no payload / empty query: every tag
export function predicateForTagsInQuery(query: SearchQuery): TagPredicate {
  const items: SearchQueryItem[] = query.items;
  if (items.length === 0) {
    return (tag: SearchableTag): boolean => true;
  }
  const lastItem: SearchQueryItem = items[items.length - 1];
  const value: string = lastItem.value;
  if (lastItem.kind === SearchQueryItemKind.KEYWORD) {
    return (tag: SearchableTag): boolean => containsCD(tag.name, value);
  }
  if (value.length === 0) {
    return (tag: SearchableTag): boolean => true;
  }
  return (tag: SearchableTag): boolean =>
    containsCD(tag.name, value) && (tag.name === null || foldCase(tag.name) !== foldCase(value));
}

export function predicateForTagWithKeyword(keyword: string, settings: SearchQuerySettings): TagPredicate {
  return predicateForTagsInQuery(new SearchQuery(keyword, settings));
}
