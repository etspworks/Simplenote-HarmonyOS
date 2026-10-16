// Port of SimplenoteSearch-Swift: Query/SearchQuery.swift, Query/SearchQueryItem.swift,
// Extensions/NSString+Search.swift, plus the app's SearchQuery+Simplenote.swift (default settings).

// MARK: - SearchQueryItem

export enum SearchQueryItemKind {
  KEYWORD = 'keyword',
  TAG = 'tag'
}

export class SearchQueryItem {
  readonly kind: SearchQueryItemKind;
  readonly value: string;

  constructor(kind: SearchQueryItemKind, value: string) {
    this.kind = kind;
    this.value = value;
  }

  static keyword(value: string): SearchQueryItem {
    return new SearchQueryItem(SearchQueryItemKind.KEYWORD, value);
  }

  static tag(value: string): SearchQueryItem {
    return new SearchQueryItem(SearchQueryItemKind.TAG, value);
  }

  equals(other: SearchQueryItem): boolean {
    return this.kind === other.kind && this.value === other.value;
  }
}

// MARK: - SearchQuerySettings

export const TAGS_KEYWORD: string = 'tag:';

export class SearchQuerySettings {
  readonly tagsKeyword: string;
  readonly localizedTagKeyword: string;

  constructor(tagsKeyword: string, localizedTagKeyword: string) {
    this.tagsKeyword = tagsKeyword;
    this.localizedTagKeyword = localizedTagKeyword;
  }

  /// SearchQuerySettings.default (SearchQuery+Simplenote.swift).
  /// ponytail: the localized operator equals the English one until a translated
  /// `tag:` string resource exists; pass `localizedTagKeyword` from the UI layer then.
  static defaultSettings(localizedTagKeyword: string = TAGS_KEYWORD): SearchQuerySettings {
    return new SearchQuerySettings(TAGS_KEYWORD, localizedTagKeyword);
  }
}

// MARK: - String + Search API(s)

export const WHITESPACE: string = ' ';

// CharacterSet.whitespaces: horizontal whitespace only (newlines are NOT separators)
const WHITESPACES: RegExp = new RegExp('[\\t \\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000]');

/// Replaces the last word in `text` (tokens are separated by whitespaces)
export function replaceLastWord(text: string, word: string): string {
  const words: string[] = text.split(WHITESPACES);
  words.pop();
  words.push(word);
  return words.join(WHITESPACE);
}

/// Returns the suffix after a given `prefix` (if any!)
export function suffixAfterPrefix(text: string, prefix: string): string | null {
  if (!text.startsWith(prefix) || text.length < prefix.length) {
    return null;
  }
  return text.substring(prefix.length);
}

// MARK: - SearchQuery

export class SearchQuery {
  /// Original search text
  readonly searchText: string;

  /// Localized Tag search operator settings
  readonly settings: SearchQuerySettings;

  /// Ordered list of query items found in a search text
  private itemsStorage: SearchQueryItem[] = [];

  constructor(searchText: string, settings: SearchQuerySettings = SearchQuerySettings.defaultSettings()) {
    this.searchText = searchText;
    this.settings = settings;
    this.parse();
  }

  get items(): SearchQueryItem[] {
    return this.itemsStorage;
  }

  /// A boolean value indicating if the query is empty
  get isEmpty(): boolean {
    return this.itemsStorage.length === 0;
  }

  /// Tags found in a search text
  get tags(): string[] {
    const output: string[] = [];
    for (const item of this.itemsStorage) {
      if (item.kind === SearchQueryItemKind.TAG && item.value.length > 0) {
        output.push(item.value);
      }
    }
    return output;
  }

  /// Keywords found in a search text
  get keywords(): string[] {
    const output: string[] = [];
    for (const item of this.itemsStorage) {
      if (item.kind === SearchQueryItemKind.KEYWORD) {
        output.push(item.value);
      }
    }
    return output;
  }

  equals(other: SearchQuery | null): boolean {
    if (other === null || other.items.length !== this.itemsStorage.length) {
      return false;
    }
    for (let i = 0; i < this.itemsStorage.length; i++) {
      if (!this.itemsStorage[i].equals(other.items[i])) {
        return false;
      }
    }
    return true;
  }

  private parse(): void {
    const keywords: string[] = this.searchText.trim().split(WHITESPACES);
    for (const keyword of keywords) {
      if (keyword.length === 0) {
        continue;
      }
      const tag: string | null = this.extractTagKeyword(keyword);
      if (tag === null) {
        this.itemsStorage.push(SearchQueryItem.keyword(keyword));
        continue;
      }
      this.itemsStorage.push(SearchQueryItem.tag(tag));
    }
  }

  private extractTagKeyword(keyword: string): string | null {
    const tagPrefixes: string[] = [this.settings.tagsKeyword.toLowerCase(), this.settings.localizedTagKeyword.toLowerCase()];
    for (const prefix of tagPrefixes) {
      const tag: string | null = suffixAfterPrefix(keyword.toLowerCase(), prefix);
      if (tag !== null) {
        return tag;
      }
    }
    return null;
  }
}
