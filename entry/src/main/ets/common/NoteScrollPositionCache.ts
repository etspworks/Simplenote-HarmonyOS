// Port of Simplenote/NoteScrollPositionCache.swift + Simplenote/Classes/FileStorage.swift, and the two call
// sites that own it: EditorFactory.scrollPositionCache (the shared instance, file "<filesDir>/.scroll-cache")
// and SPAppDelegate.cleanupScrollPositionCache().
//
// FileStorage<T: Codable> -> a JSON text file via @kit.CoreFileKit fileIo, same file-per-cache layout.
import { application, common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { NoteStore } from './NoteStore';
import { Note } from '../model/Note';

const DOMAIN: number = 0x0001;
const LOG_TAG: string = 'NoteScrollPositionCache';
const SCROLL_CACHE_FILENAME: string = '.scroll-cache';

export type ScrollCache = Record<string, number>;

/// FileStorage<ScrollCache>: load / save one JSON-encoded object at a file path.
export class FileStorage {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /// Load an object. Throws when the file is missing or undecodable (the caller uses `try?`).
  load(): ScrollCache | null {
    const text: string = fileIo.readTextSync(this.filePath);
    const decoded: Object = JSON.parse(text) as Object;
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('FileStorage: undecodable payload');
    }
    const source: Record<string, Object> = decoded as Record<string, Object>;
    const out: ScrollCache = {};
    for (const key of Object.keys(source)) {
      const value: Object = source[key];
      if (typeof value !== 'number') {
        throw new Error('FileStorage: undecodable value for ' + key);
      }
      out[key] = value as number;
    }
    return out;
  }

  /// Save an object
  save(object: ScrollCache): void {
    const file: fileIo.File =
      fileIo.openSync(this.filePath, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    try {
      fileIo.writeSync(file.fd, JSON.stringify(object));
    } finally {
      fileIo.closeSync(file);
    }
  }
}

// MARK: - NoteScrollPositionCache: cache scroll offset
export class NoteScrollPositionCache {
  private static sharedInstance: NoteScrollPositionCache | null = null;

  private cacheValue: ScrollCache = {};
  private readonly storage: FileStorage;

  constructor(storage: FileStorage) {
    this.storage = storage;

    let storedCache: ScrollCache | null = null;
    try {
      storedCache = storage.load();
    } catch (e) {
      storedCache = null;
    }
    this.cacheValue = storedCache ?? {};
  }

  /// EditorFactory.shared.scrollPositionCache
  static shared(): NoteScrollPositionCache {
    if (NoteScrollPositionCache.sharedInstance === null) {
      const context: common.Context = application.getApplicationContext();
      const filePath: string = context.filesDir + '/' + SCROLL_CACHE_FILENAME;
      NoteScrollPositionCache.sharedInstance = new NoteScrollPositionCache(new FileStorage(filePath));
    }
    return NoteScrollPositionCache.sharedInstance as NoteScrollPositionCache;
  }

  /// `cache` with its didSet: every assignment persists.
  private get cache(): ScrollCache {
    return this.cacheValue;
  }

  private set cache(value: ScrollCache) {
    this.cacheValue = value;
    try {
      this.storage.save(value);
    } catch (e) {
      hilog.warn(DOMAIN, LOG_TAG, 'save failed: %{public}s', JSON.stringify(e));
    }
  }

  /// Returns cached scroll position
  position(key: string): number | null {
    const value: number | undefined = this.cache[key];
    return value === undefined ? null : value;
  }

  /// Stores scroll position
  store(position: number, key: string): void {
    const next: ScrollCache = this.copy(this.cache);
    next[key] = position;
    this.cache = next;
  }

  /// Cleanup
  cleanup(keys: string[]): void {
    const next: ScrollCache = {};
    const current: ScrollCache = this.cache;
    for (const key of Object.keys(current)) {
      if (keys.indexOf(key) >= 0) {
        next[key] = current[key];
      }
    }
    this.cache = next;
  }

  private copy(source: ScrollCache): ScrollCache {
    const out: ScrollCache = {};
    for (const key of Object.keys(source)) {
      out[key] = source[key];
    }
    return out;
  }
}

/// SPAppDelegate.cleanupScrollPositionCache(): keep only live (non-deleted) notes. Attach as
/// SessionStore.hooks.cleanupScrollPositionCache.
export function cleanupScrollPositionCache(): void {
  const allIdentifiers: string[] = [];
  for (const note of NoteStore.sharedManager().notes()) {
    const n: Note = note;
    if (!n.deleted && n.simperiumKey.length > 0) {
      allIdentifiers.push(n.simperiumKey);
    }
  }
  NoteScrollPositionCache.shared().cleanup(allIdentifiers);
}
