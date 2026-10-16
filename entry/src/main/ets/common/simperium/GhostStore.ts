// Port of SPGhost.h/.m (an entity's member data as last acknowledged by the server, plus its
// version) and of the persistent containers the change processor keeps its bookkeeping in:
// SPPersistentMutableDictionary / SPPersistentMutableSet. The ObjC containers each sit in their
// own SQLite file; here they live in the app's preferences (UserDefaults), keyed by label.
import { UserDefaults } from '../Database';
import { SPDict, SPValue, copyDict, dictFromJSONString, isDict, jsonString, objectFromJSONString } from './JsonDiff';

export class SPGhost {
  private keyValue: string | null = null;
  private memberDataValue: SPDict | null = null;
  private versionValue: string | null = null;
  needsSave: boolean = false;

  /** -initWithKey:memberData: */
  constructor(key: string | null, memberData: SPDict | null) {
    this.keyValue = key;
    this.memberDataValue = memberData;
  }

  /** -initFromDictionary: (not marked dirty: ghosts are loaded this way on launch) */
  static fromDictionary(dict: SPDict | null): SPGhost {
    const ghost = new SPGhost(null, null);
    if (dict !== null) {
      const key = dict['key'];
      const obj = dict['obj'];
      const version = dict['version'];
      ghost.keyValue = typeof key === 'string' ? key as string : null;
      ghost.memberDataValue = isDict(obj) ? obj as SPDict : null;
      ghost.versionValue = SPGhost.versionString(version);
    }
    ghost.needsSave = false;
    return ghost;
  }

  static fromJSONString(ghostData: string | null): SPGhost {
    return SPGhost.fromDictionary(dictFromJSONString(ghostData));
  }

  static versionString(value: SPValue): string | null {
    if (typeof value === 'number') {
      return `${Math.trunc(value as number)}`;
    }
    return typeof value === 'string' ? value as string : null;
  }

  get key(): string | null {
    return this.keyValue;
  }

  set key(newKey: string | null) {
    this.keyValue = newKey;
    this.needsSave = true;
  }

  get memberData(): SPDict | null {
    return this.memberDataValue;
  }

  setMemberData(newMemberData: SPDict | null): void {
    this.memberDataValue = newMemberData === null ? null : copyDict(newMemberData);
    this.needsSave = true;
  }

  get version(): string | null {
    return this.versionValue;
  }

  set version(newVersion: string | null) {
    this.versionValue = newVersion;
    this.needsSave = true;
  }

  /** -copyWithZone: (memberData shared) — callers that mutate use mutableCopy() */
  copy(): SPGhost {
    const ghost = new SPGhost(this.keyValue, this.memberDataValue);
    ghost.versionValue = this.versionValue;
    return ghost;
  }

  mutableCopy(): SPGhost {
    const ghost = new SPGhost(this.keyValue, this.memberDataValue === null ? null : copyDict(this.memberDataValue));
    ghost.versionValue = this.versionValue;
    return ghost;
  }

  dictionary(): SPDict {
    const dict: SPDict = {};
    dict['key'] = this.keyValue;
    if (this.versionValue !== null) {
      dict['version'] = this.versionValue;
    }
    dict['obj'] = this.memberDataValue;
    return dict;
  }

  toJSONString(): string {
    return jsonString(this.dictionary());
  }
}

/** SPPersistentMutableDictionary: insertion-ordered dictionary, persisted on save(). */
export class SPPersistentMutableDictionary {
  private label: string;
  private contents: Map<string, SPDict> = new Map<string, SPDict>();

  private constructor(label: string) {
    this.label = label;
  }

  static loadDictionaryWithLabel(label: string): SPPersistentMutableDictionary {
    const dict = new SPPersistentMutableDictionary(label);
    const stored = objectFromJSONString(UserDefaults.standard.string(dict.storageKey()));
    if (isDict(stored)) {
      const storedDict = stored as SPDict;
      for (const key of Object.keys(storedDict)) {
        const value = storedDict[key];
        if (isDict(value)) {
          dict.contents.set(key, value as SPDict);
        }
      }
    }
    return dict;
  }

  private storageKey(): string {
    return `SPPersistentMutableDictionary-${this.label}`;
  }

  get count(): number {
    return this.contents.size;
  }

  allKeys(): string[] {
    return Array.from(this.contents.keys());
  }

  allValues(): SPDict[] {
    return Array.from(this.contents.values());
  }

  objectForKey(key: string): SPDict | undefined {
    return this.contents.get(key);
  }

  containsObjectForKey(key: string): boolean {
    return this.contents.has(key);
  }

  setObject(value: SPDict, key: string): void {
    this.contents.set(key, value);
  }

  removeObjectForKey(key: string): void {
    this.contents.delete(key);
  }

  removeAllObjects(): void {
    this.contents.clear();
  }

  save(): void {
    const out: SPDict = {};
    this.contents.forEach((value: SPDict, key: string) => {
      out[key] = value;
    });
    UserDefaults.standard.set(this.storageKey(), jsonString(out));
  }
}

/** SPPersistentMutableSet: an insertion-ordered set of keys, persisted on save(). */
export class SPPersistentMutableSet {
  private label: string;
  private contents: Set<string> = new Set<string>();

  private constructor(label: string) {
    this.label = label;
  }

  static loadSetWithLabel(label: string): SPPersistentMutableSet {
    const set = new SPPersistentMutableSet(label);
    const stored = objectFromJSONString(UserDefaults.standard.string(set.storageKey()));
    if (Array.isArray(stored)) {
      for (const item of stored as Object[]) {
        if (typeof item === 'string') {
          set.contents.add(item as string);
        }
      }
    }
    return set;
  }

  private storageKey(): string {
    return `SPPersistentMutableSet-${this.label}`;
  }

  get count(): number {
    return this.contents.size;
  }

  allObjects(): string[] {
    return Array.from(this.contents.values());
  }

  containsObject(key: string): boolean {
    return this.contents.has(key);
  }

  addObject(key: string): void {
    this.contents.add(key);
  }

  removeObject(key: string): void {
    this.contents.delete(key);
  }

  minusSet(keys: Set<string>): void {
    keys.forEach((key: string) => {
      this.contents.delete(key);
    });
  }

  removeAllObjects(): void {
    this.contents.clear();
  }

  save(): void {
    UserDefaults.standard.set(this.storageKey(), jsonString(Array.from(this.contents.values())));
  }
}
