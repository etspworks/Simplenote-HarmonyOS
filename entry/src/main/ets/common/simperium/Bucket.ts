// Port of SPBucket.h/.m (+Internals), SPManagedObject.h/.m, SPObject.m, SPDiffable.h and the two
// storage providers Simperium ships: SPCoreDataStorage (persistent entities — here backed by the
// relationalStore stack in ../Database) and SPJSONStorage (the ephemeral in-memory store used by
// dynamic buckets such as "Account").
//
// Threading: the ObjC code hops between the main queue and one serial `processorQueue` per bucket.
// ArkTS runs this on one thread, so the processor queue is a serial promise chain and the
// "dispatch to main" hops become microtasks. Order of work is preserved.
import { CoreDataManager, ManagedObjectContext, StoredEntityRow, UserDefaults } from '../Database';
import { SPChangeProcessor } from './ChangeProcessor';
import { SPGhost } from './GhostStore';
import { SPIndexProcessor } from './IndexProcessor';
import {
  SPDiffable, SPDict, SPDiffer, SPMember, SPMemberDefinition, SPSchema, SPValue, copyDict, dictFromJSONString,
  isNil, jsonString, makeUUID
} from './JsonDiff';
import { SPWebSocketInterface } from './WebSocketChannel';

// MARK: - SPBucketChangeType

export enum SPBucketChangeType {
  INSERT = 1,
  DELETE = 2,
  MOVE = 3,
  UPDATE = 4,
  ACKNOWLEDGE = 5
}

/** SPBucketDelegate: every callback optional, like the ObjC protocol. */
export interface SPBucketDelegate {
  bucketDidChangeObjectForKey?: (bucket: SPBucket, key: string, changeType: SPBucketChangeType,
    memberNames: string[] | null) => void;
  bucketWillChangeObjectsForKeys?: (bucket: SPBucket, keys: Set<string>) => void;
  bucketWillStartIndexing?: (bucket: SPBucket) => void;
  bucketDidFinishIndexing?: (bucket: SPBucket) => void;
  bucketDidReceiveObjectForKey?: (bucket: SPBucket, key: string, version: string, data: SPDict) => void;
  bucketDidAcknowledgeDelete?: (bucket: SPBucket) => void;
  bucketDidFailWithError?: (bucket: SPBucket, error: Error) => void;
  bucketDidShareObjectForKey?: (bucket: SPBucket, key: string, email: string) => void;
}

/** Posted whenever the objects of a bucket change (the NSManagedObjectContext change notification). */
export type SPBucketContentListener = (bucket: SPBucket) => void;

export type SPBucketStatsCallback = (bucket: SPBucket, localPendingChanges: number,
  localEnqueuedChanges: number, localEnqueuedDeletions: number) => void;

export type SPBucketForceSyncCompletion = (signatureUpdated: boolean) => void;

/** Runs `work` on the next turn, the equivalent of dispatch_async(dispatch_get_main_queue(), ...). */
export function dispatchMain(work: () => void): void {
  Promise.resolve().then(work).catch((e: Error) => {
    console.error(`Simperium main-queue task failed: ${e.message}`);
  });
}

/** A serial queue: tasks run one after another, in submission order. */
export class SPSerialQueue {
  private tail: Promise<void> = Promise.resolve();

  async(work: () => void | Promise<void>): Promise<void> {
    const next = this.tail.then(async () => {
      await work();
    });
    this.tail = next.catch((e: Error) => {
      console.error(`Simperium processor task failed: ${e.message}`);
    });
    return next;
  }

  /** Resolves once every task submitted so far has run. */
  drain(): Promise<void> {
    return this.tail;
  }
}

// MARK: - Diffable entities

/** Common base of every object a bucket tracks (SPDiffable). */
export abstract class SPDiffableObject implements SPDiffable {
  ghost: SPGhost | null = null;
  ghostData: string | null = null;
  simperiumKey: string = '';
  bucket: SPBucket | null = null;
  updateWaiting: boolean = false;

  abstract simperiumSetValue(value: SPValue, key: string): void;

  abstract simperiumValueForKey(key: string): SPValue;

  abstract loadMemberData(data: SPDict): void;

  abstract dictionary(): SPDict;

  version(): string | null {
    return this.ghost !== null ? this.ghost.version : null;
  }

  willBeRead(): void {
    // Nothing to fault in: entities are fully materialised in memory
  }

  namespacedSimperiumKey(): string {
    return `${this.bucket !== null ? this.bucket.name : ''}.${this.simperiumKey}`;
  }

  /** Member data plus any local-only attribute, as persisted in the entity row. */
  storageDictionary(): SPDict {
    return this.dictionary();
  }

  loadStorageDictionary(data: SPDict): void {
    this.loadMemberData(data);
  }

  awakeFromFetch(): void {
    this.ghost = SPGhost.fromJSONString(this.ghostData);
  }

  awakeFromInsert(remote: boolean): void {
    if (remote) {
      this.awakeFromRemoteInsert();
    } else {
      this.awakeFromLocalInsert();
    }
  }

  awakeFromLocalInsert(): void {
    // Override me if needed!
  }

  awakeFromRemoteInsert(): void {
    // Override me if needed!
  }
}

/**
 * SPManagedObject: base class of the app's synced entities (Note, Tag, Settings, Preferences).
 * A subclass maps each schema member onto its own typed field via getMemberValue / setMemberValue —
 * the key-value coding the ObjC class gets for free.
 */
export abstract class SPManagedObject extends SPDiffableObject {
  /** -didTurnIntoFault: the ghost is released with the object's data */
  didTurnIntoFault(): void {
    this.ghost = null;
  }

  protected abstract getMemberValue(key: string): SPValue;

  protected abstract setMemberValue(key: string, value: SPValue): void;

  simperiumSetValue(value: SPValue, key: string): void {
    this.safeSetValue(value, key);
  }

  simperiumValueForKey(key: string): SPValue {
    return this.getMemberValue(key);
  }

  private schema(): SPSchema | null {
    return this.bucket !== null ? this.bucket.differ.schema : null;
  }

  loadMemberData(memberData: SPDict): void {
    const schema = this.schema();
    if (schema === null) {
      console.error('Simperium error: bucket list not loaded. Ensure Simperium is started before any objects are fetched.');
      return;
    }
    for (const memberKey of Object.keys(memberData)) {
      const member = schema.memberForKey(memberKey);
      if (member !== undefined) {
        this.safeSetValue(member.getValueFromDictionary(memberData, memberKey), member.keyName);
      }
    }
  }

  dictionary(): SPDict {
    const dict: SPDict = {};
    const schema = this.schema();
    if (schema === null) {
      return dict;
    }
    schema.members.forEach((member: SPMember) => {
      member.setValueForKeyInDictionary(this.getMemberValue(member.keyName), member.keyName, dict);
    });
    return dict;
  }

  object(): SPManagedObject {
    return this;
  }

  private safeSetValue(value: SPValue, key: string): void {
    if (this.bucket === null || !this.bucket.propertyMismatchFailsafeEnabled) {
      this.setMemberValue(key, value);
      return;
    }
    try {
      this.setMemberValue(key, value);
    } catch (e) {
      console.error(`Simperium CRITICAL Error: Exception thrown while setting [${key}]`);
    }
  }
}

/** SPObject: the schemaless, dictionary-backed object held by dynamic (JSON storage) buckets. */
export class SPObject extends SPDiffableObject {
  private storage: SPDict;

  constructor(dictionary?: SPDict) {
    super();
    this.storage = dictionary !== undefined ? copyDict(dictionary) : {};
    this.ghost = new SPGhost(null, null);
  }

  simperiumSetValue(value: SPValue, key: string): void {
    if (isNil(value)) {
      this.storage[key] = undefined;
    } else {
      this.storage[key] = value;
    }
    if (this.bucket !== null) {
      this.bucket.differ.schema.ensureDynamicMemberExistsForObject(value, key);
    }
  }

  simperiumValueForKey(key: string): SPValue {
    return this.storage[key];
  }

  loadMemberData(data: SPDict): void {
    for (const key of Object.keys(data)) {
      this.storage[key] = data[key];
    }
    if (this.bucket !== null) {
      for (const key of Object.keys(this.storage)) {
        const value = this.storage[key];
        if (!isNil(value)) {
          this.bucket.differ.schema.ensureDynamicMemberExistsForObject(value, key);
        }
      }
    }
  }

  dictionary(): SPDict {
    return copyDict(this.storage);
  }

  /** -object: a copy of the underlying dictionary */
  object(): SPDict {
    return copyDict(this.storage);
  }
}

// MARK: - Storage

export type SPManagedObjectFactory = () => SPManagedObject;

/** Simperium (SPStorageObserver): told around every local save, to push changes over the wire. */
export interface SPStorageObserver {
  storageWillSave(storage: SPStorage, deletedObjects: Set<SPDiffableObject>): void;
  storageDidSave(storage: SPStorage, insertedObjects: Set<SPDiffableObject>, updatedObjects: Set<SPDiffableObject>): void;
}

/**
 * SPStorageProvider: SPCoreDataStorage when built over a CoreDataManager stack,
 * SPJSONStorage (ephemeral, in memory) when built without one.
 */
export class SPStorage {
  readonly isEphemeral: boolean;
  delegate: SPStorageObserver | null = null;
  bucketList: Map<string, SPBucket> = new Map<string, SPBucket>();
  delaysNewObjectsInitialization: boolean = false;
  private context: ManagedObjectContext | null;
  private factories: Map<string, SPManagedObjectFactory> = new Map<string, SPManagedObjectFactory>();
  private objects: Map<string, Map<string, SPDiffableObject>> = new Map<string, Map<string, SPDiffableObject>>();
  private snapshots: Map<SPDiffableObject, string> = new Map<SPDiffableObject, string>();
  private insertedObjects: Set<SPDiffableObject> = new Set<SPDiffableObject>();
  private deletedObjects: Set<SPDiffableObject> = new Set<SPDiffableObject>();
  private stashed: Set<SPDiffableObject> = new Set<SPDiffableObject>();

  /** SPCoreDataStorage -initWithModel:mainContext:coordinator: */
  static coreDataStorage(manager: CoreDataManager): SPStorage {
    const context = manager.managedObjectContext;
    if (context !== null && context.persistentStoreCoordinator === null) {
      context.persistentStoreCoordinator = manager.persistentStoreCoordinator;
    }
    return new SPStorage(context, false);
  }

  /** SPJSONStorage -initWithDelegate: */
  static jsonStorage(): SPStorage {
    return new SPStorage(null, true);
  }

  private constructor(context: ManagedObjectContext | null, ephemeral: boolean) {
    this.context = context;
    this.isEphemeral = ephemeral;
  }

  registerEntity(bucketName: string, factory: SPManagedObjectFactory): void {
    this.factories.set(bucketName, factory);
  }

  entityNames(): string[] {
    return Array.from(this.factories.keys());
  }

  private bucketObjects(bucketName: string): Map<string, SPDiffableObject> {
    let map = this.objects.get(bucketName);
    if (map === undefined) {
      map = new Map<string, SPDiffableObject>();
      this.objects.set(bucketName, map);
    }
    return map;
  }

  private rowFor(object: SPDiffableObject): StoredEntityRow {
    // SPManagedObject -willSave: serialise the ghost only when it changed
    if (object.ghost !== null && object.ghost.needsSave) {
      object.ghostData = object.ghost.toJSONString();
      object.ghost.needsSave = false;
    }
    return new StoredEntityRow(object.simperiumKey, object.ghostData, jsonString(object.storageDictionary()));
  }

  private snapshotOf(object: SPDiffableObject): string {
    return `${object.ghostData ?? ''}|${jsonString(object.storageDictionary())}`;
  }

  /** Loads every persisted entity (awakeFromFetch). */
  async loadPersistedObjects(): Promise<void> {
    if (this.context === null) {
      return;
    }
    for (const bucketName of this.entityNames()) {
      const rows = await this.context.fetchAll(bucketName);
      const map = this.bucketObjects(bucketName);
      const factory = this.factories.get(bucketName);
      if (factory === undefined) {
        continue;
      }
      for (const row of rows) {
        const object = factory();
        object.simperiumKey = row.simperiumKey;
        object.ghostData = row.ghostData;
        object.bucket = this.bucketList.get(bucketName) ?? null;
        const data = dictFromJSONString(row.data);
        if (data !== null) {
          object.loadStorageDictionary(data);
        }
        object.awakeFromFetch();
        map.set(object.simperiumKey, object);
        this.snapshots.set(object, this.snapshotOf(object));
      }
    }
  }

  /** False until the object reached the store (Core Data's temporary objectID). */
  isPersisted(object: SPDiffableObject): boolean {
    return this.snapshots.has(object);
  }

  objectForKey(key: string, bucketName: string): SPDiffableObject | undefined {
    return this.bucketObjects(bucketName).get(key);
  }

  objectsForKeys(keys: Iterable<string>, bucketName: string): SPDiffableObject[] {
    const map = this.bucketObjects(bucketName);
    const out: SPDiffableObject[] = [];
    for (const key of keys) {
      const object = map.get(key);
      if (object !== undefined) {
        out.push(object);
      }
    }
    return out;
  }

  /** -faultObjectsForKeys:bucketName: */
  faultObjectsForKeys(keys: string[], bucketName: string): Map<string, SPDiffableObject> {
    const out = new Map<string, SPDiffableObject>();
    for (const object of this.objectsForKeys(keys, bucketName)) {
      out.set(object.simperiumKey, object);
    }
    return out;
  }

  objectsForBucketName(bucketName: string, predicate?: (object: SPDiffableObject) => boolean): SPDiffableObject[] {
    const all = Array.from(this.bucketObjects(bucketName).values());
    return predicate === undefined ? all : all.filter(predicate);
  }

  objectKeysForBucketName(bucketName: string): string[] {
    return Array.from(this.bucketObjects(bucketName).keys());
  }

  numObjectsForBucketName(bucketName: string, predicate?: (object: SPDiffableObject) => boolean): number {
    return this.objectsForBucketName(bucketName, predicate).length;
  }

  /** `remote` = inserted by the processors (worker context), which must not be re-sent as local. */
  insertNewObjectForBucketName(bucketName: string, key: string | null, remote: boolean = false): SPDiffableObject {
    const factory = this.factories.get(bucketName);
    const object: SPDiffableObject = factory !== undefined ? factory() : new SPObject();
    object.simperiumKey = key ?? makeUUID();
    object.bucket = this.bucketList.get(bucketName) ?? null;
    this.bucketObjects(bucketName).set(object.simperiumKey, object);
    if (!remote) {
      this.insertedObjects.add(object);
      if (!this.delaysNewObjectsInitialization) {
        this.configureNewGhost(object);
      }
    }
    object.awakeFromInsert(remote);
    return object;
  }

  /** SPStorage -configureNewGhost: new to this client, so an empty ghost at version 0. */
  configureNewGhost(object: SPDiffableObject): void {
    // Objects coming off the wire already have a ghost: be careful not to stomp it
    if (object.ghost !== null) {
      return;
    }
    const ghost = new SPGhost(object.simperiumKey, null);
    ghost.version = '0';
    object.ghost = ghost;
  }

  deleteObject(object: SPDiffableObject): void {
    const bucketName = object.bucket !== null ? object.bucket.name : '';
    this.bucketObjects(bucketName).delete(object.simperiumKey);
    if (this.insertedObjects.has(object)) {
      this.insertedObjects.delete(object);
      this.snapshots.delete(object);
      return;
    }
    this.deletedObjects.add(object);
  }

  deleteAllObjectsForBucketName(bucketName: string): void {
    for (const object of this.objectsForBucketName(bucketName)) {
      this.deleteObject(object);
    }
  }

  /**
   * -validateObjectsForBucketName: every entity needs a key and a ghost. Like SPCoreDataStorage, members are
   * NOT filled with their type defaults (SPSchema -setDefaults: is never called on iOS): doing so stored
   * owner == '' on every Note, a member the server never had, which then showed up as a phantom local diff.
   */
  validateObjectsForBucketName(bucketName: string): void {
    for (const object of this.objectsForBucketName(bucketName)) {
      if (object.simperiumKey.length === 0) {
        object.simperiumKey = makeUUID();
      }
      this.configureNewGhost(object);
    }
  }

  stashUnsavedObjects(): void {
    if (this.isEphemeral) {
      return;
    }
    for (const object of this.pendingUpdatedObjects()) {
      this.stashed.add(object);
    }
  }

  get stashedObjects(): Set<SPDiffableObject> {
    return new Set<SPDiffableObject>(this.stashed);
  }

  unstashUnsavedObjects(): void {
    this.stashed.clear();
  }

  stopManagingObjectWithKey(key: string): void {
    // Nothing to release: the object was already removed from the in-memory map
  }

  unloadAllObjects(): void {
    // Core Data resets its contexts here; the in-memory maps stay the source of truth
  }

  private pendingUpdatedObjects(): SPDiffableObject[] {
    const out: SPDiffableObject[] = [];
    this.objects.forEach((map: Map<string, SPDiffableObject>) => {
      map.forEach((object: SPDiffableObject) => {
        if (this.insertedObjects.has(object)) {
          return;
        }
        if (this.snapshots.get(object) !== this.snapshotOf(object)) {
          out.push(object);
        }
      });
    });
    return out;
  }

  private persist(inserted: Iterable<SPDiffableObject>, updated: Iterable<SPDiffableObject>,
    deleted: Iterable<SPDiffableObject>): Promise<void>[] {
    const writes: Promise<void>[] = [];
    const context = this.context;
    const write = (object: SPDiffableObject): void => {
      const row = this.rowFor(object);
      this.snapshots.set(object, this.snapshotOf(object));
      if (context !== null && object.bucket !== null) {
        writes.push(context.upsert(object.bucket.name, row));
      }
    };
    for (const object of inserted) {
      write(object);
    }
    for (const object of updated) {
      write(object);
    }
    for (const object of deleted) {
      this.snapshots.delete(object);
      if (context !== null && object.bucket !== null) {
        writes.push(context.delete(object.bucket.name, object.simperiumKey));
      }
    }
    return writes;
  }

  /** A local save (main context): notifies the observer so the changes get synced. */
  async save(): Promise<void> {
    if (this.delaysNewObjectsInitialization) {
      this.insertedObjects.forEach((object: SPDiffableObject) => {
        this.configureNewGhost(object);
      });
    }
    const inserted = new Set<SPDiffableObject>(this.insertedObjects);
    const updated = new Set<SPDiffableObject>(this.pendingUpdatedObjects());
    const deleted = new Set<SPDiffableObject>(this.deletedObjects);
    this.insertedObjects.clear();
    this.deletedObjects.clear();
    if (inserted.size === 0 && updated.size === 0 && deleted.size === 0 && this.stashed.size === 0) {
      return;
    }
    if (this.delegate !== null) {
      this.delegate.storageWillSave(this, deleted);
    }
    const writes = this.persist(inserted, updated, deleted);
    if (this.delegate !== null) {
      this.delegate.storageDidSave(this, inserted, updated);
    }
    this.notifyContentChanged(inserted, updated, deleted);
    await Promise.all(writes);
  }

  /** A save from the processors (the worker context): persisted, never re-sent as local changes. */
  async saveFromProcessor(touched: Iterable<SPDiffableObject>): Promise<void> {
    const updated = new Set<SPDiffableObject>();
    for (const object of touched) {
      this.insertedObjects.delete(object);
      updated.add(object);
    }
    const writes = this.persist([], updated, []);
    this.notifyContentChanged(new Set<SPDiffableObject>(), updated, new Set<SPDiffableObject>());
    await Promise.all(writes);
  }

  /** A deletion applied by the processors (remote delete / index reconciliation): never re-sent. */
  async deleteObjectFromProcessor(object: SPDiffableObject): Promise<void> {
    const bucketName = object.bucket !== null ? object.bucket.name : '';
    this.bucketObjects(bucketName).delete(object.simperiumKey);
    this.insertedObjects.delete(object);
    this.deletedObjects.delete(object);
    const deleted = new Set<SPDiffableObject>([object]);
    const writes = this.persist([], [], deleted);
    this.notifyContentChanged(new Set<SPDiffableObject>(), new Set<SPDiffableObject>(), deleted);
    await Promise.all(writes);
  }

  private notifyContentChanged(inserted: Set<SPDiffableObject>, updated: Set<SPDiffableObject>,
    deleted: Set<SPDiffableObject>): void {
    const names = new Set<string>();
    const collect = (object: SPDiffableObject): void => {
      if (object.bucket !== null) {
        names.add(object.bucket.name);
      }
    };
    inserted.forEach(collect);
    updated.forEach(collect);
    deleted.forEach(collect);
    names.forEach((name: string) => {
      const bucket = this.bucketList.get(name);
      if (bucket !== undefined) {
        bucket.notifyContentListeners();
      }
    });
  }

  async commitPendingOperations(): Promise<void> {
    if (this.context !== null) {
      await this.context.commitPendingOperations();
    }
  }
}

// MARK: - SPBucket

export class SPBucket {
  readonly name: string;
  readonly remoteName: string;
  readonly instanceLabel: string;
  delegate: SPBucketDelegate | null = null;
  notifyWhileIndexing: boolean = false;
  propertyMismatchFailsafeEnabled: boolean = false;
  exposeNamespace: boolean = false;
  localNamespace: string = '';
  storage: SPStorage;
  network: SPWebSocketInterface;
  differ: SPDiffer;
  changeProcessor: SPChangeProcessor;
  indexProcessor: SPIndexProcessor;
  processorQueue: SPSerialQueue = new SPSerialQueue();
  forceSyncCompletion: SPBucketForceSyncCompletion | null = null;
  forceSyncSignature: string | null = null;
  private lastChangeSignatureValue: string | null = null;
  private lastChangeSignatureLoaded: boolean = false;
  private contentListeners: SPBucketContentListener[] = [];

  constructor(schema: SPSchema, storage: SPStorage, network: SPWebSocketInterface, label: string,
    remoteName: string, clientID: string) {
    this.name = schema.bucketName;
    this.remoteName = remoteName;
    this.storage = storage;
    this.network = network;
    this.differ = new SPDiffer(schema);
    // Label is used to support multiple simperium instances (e.g. unit testing)
    this.instanceLabel = `${this.name}${label}`;
    this.changeProcessor = new SPChangeProcessor(this.instanceLabel, clientID);
    this.indexProcessor = new SPIndexProcessor();
  }

  get schema(): SPSchema {
    return this.differ.schema;
  }

  set schema(schema: SPSchema) {
    this.differ.schema = schema;
  }

  // MARK: Object access

  objectForKey(simperiumKey: string): SPDiffableObject | undefined {
    return this.storage.objectForKey(simperiumKey, this.name);
  }

  objectAtIndex(index: number): SPDiffableObject | undefined {
    return this.storage.objectsForBucketName(this.name)[index];
  }

  requestVersions(numVersions: number, simperiumKey: string): void {
    const diffable = this.storage.objectForKey(simperiumKey, this.name);
    if (diffable !== undefined) {
      this.network.requestVersions(numVersions, diffable);
    }
  }

  allObjects(): SPDiffableObject[] {
    return this.storage.objectsForBucketName(this.name);
  }

  allObjectKeys(): string[] {
    return this.storage.objectKeysForBucketName(this.name);
  }

  insertNewObject(): SPDiffableObject {
    const diffable = this.storage.insertNewObjectForBucketName(this.name, null);
    diffable.bucket = this;
    return diffable;
  }

  insertNewObjectForKey(simperiumKey: string): SPDiffableObject {
    const diffable = this.storage.insertNewObjectForBucketName(this.name, simperiumKey);
    diffable.bucket = this;
    return diffable;
  }

  deleteObject(object: SPDiffableObject): void {
    this.storage.deleteObject(object);
  }

  deleteAllObjects(): void {
    this.storage.deleteAllObjectsForBucketName(this.name);
  }

  validateObjects(): void {
    this.storage.validateObjectsForBucketName(this.name);
    this.storage.save();
  }

  unloadAllObjects(): void {
    this.storage.unloadAllObjects();
  }

  objectsForKeys(keys: Iterable<string>): SPDiffableObject[] {
    return this.storage.objectsForKeys(keys, this.name);
  }

  objectsForPredicate(predicate: (object: SPDiffableObject) => boolean): SPDiffableObject[] {
    return this.storage.objectsForBucketName(this.name, predicate);
  }

  numObjects(): number {
    return this.storage.numObjectsForBucketName(this.name);
  }

  numObjectsForPredicate(predicate: (object: SPDiffableObject) => boolean): number {
    return this.storage.numObjectsForBucketName(this.name, predicate);
  }

  statsWithCallback(callback: SPBucketStatsCallback): void {
    const processor = this.changeProcessor;
    this.processorQueue.async(() => {
      const numPendingChanges = processor.numChangesPending;
      const numEnqueuedChanges = processor.numKeysForObjectsWithMoreChanges;
      const numEnqueuedDeletions = processor.numKeysForObjectToDelete;
      dispatchMain(() => {
        callback(this, numPendingChanges, numEnqueuedChanges, numEnqueuedDeletions);
      });
    });
  }

  // MARK: Content observation (NSManagedObjectContext change notifications)

  addContentListener(listener: SPBucketContentListener): void {
    this.contentListeners.push(listener);
  }

  removeContentListener(listener: SPBucketContentListener): void {
    this.contentListeners = this.contentListeners.filter((l: SPBucketContentListener) => l !== listener);
  }

  notifyContentListeners(): void {
    for (const listener of this.contentListeners.slice()) {
      listener(this);
    }
  }

  // MARK: Change signature

  get lastChangeSignature(): string | null {
    // Load it: Skip for Ephemeral Storage
    if (!this.lastChangeSignatureLoaded && !this.storage.isEphemeral) {
      this.lastChangeSignatureValue = UserDefaults.standard.string(this.signatureKey());
      this.lastChangeSignatureLoaded = true;
    }
    return this.lastChangeSignatureValue;
  }

  set lastChangeSignature(signature: string | null) {
    this.lastChangeSignatureValue = signature;
    this.lastChangeSignatureLoaded = true;
    if (this.storage.isEphemeral) {
      return;
    }
    UserDefaults.standard.set(this.signatureKey(), signature);
  }

  private signatureKey(): string {
    return `lastChangeSignature-${this.instanceLabel}`;
  }

  // MARK: Processor notifications

  /** ProcessorDidChangeObjectNotification */
  objectDidChange(key: string, changedMembers: string[] | null): void {
    const d = this.delegate;
    if (d !== null && d.bucketDidChangeObjectForKey !== undefined) {
      d.bucketDidChangeObjectForKey(this, key, SPBucketChangeType.UPDATE, changedMembers);
    }
  }

  /** ProcessorDidAddObjectsNotification */
  objectsAdded(keys: Set<string>): void {
    // Resolve references to the new objects, then tell the delegate they are accessible
    this.resolvePendingRelationshipsToKeys(keys);
    const d = this.delegate;
    if (d === null || d.bucketDidChangeObjectForKey === undefined) {
      return;
    }
    keys.forEach((key: string) => {
      if (d.bucketDidChangeObjectForKey !== undefined) {
        d.bucketDidChangeObjectForKey(this, key, SPBucketChangeType.INSERT, null);
      }
    });
  }

  /** ProcessorDidDeleteObjectKeysNotification */
  objectKeysDeleted(keys: Set<string>): void {
    const d = this.delegate;
    keys.forEach((key: string) => {
      this.storage.stopManagingObjectWithKey(key);
      if (d !== null && d.bucketDidChangeObjectForKey !== undefined) {
        d.bucketDidChangeObjectForKey(this, key, SPBucketChangeType.DELETE, null);
      }
    });
  }

  /** ProcessorDidAcknowledgeObjectsNotification */
  objectsAcknowledged(keys: Set<string>): void {
    const d = this.delegate;
    keys.forEach((key: string) => {
      if (d !== null && d.bucketDidChangeObjectForKey !== undefined) {
        d.bucketDidChangeObjectForKey(this, key, SPBucketChangeType.ACKNOWLEDGE, null);
      }
    });
  }

  /** ProcessorWillChangeObjectsNotification */
  objectsWillChange(keys: Set<string>): void {
    const d = this.delegate;
    if (d !== null && d.bucketWillChangeObjectsForKeys !== undefined) {
      d.bucketWillChangeObjectsForKeys(this, keys);
    }
  }

  /** ProcessorDidAcknowledgeDeleteNotification */
  acknowledgedObjectDeletion(): void {
    const d = this.delegate;
    if (d !== null && d.bucketDidAcknowledgeDelete !== undefined) {
      d.bucketDidAcknowledgeDelete(this);
    }
  }

  resolvePendingRelationshipsToKeys(keys: Set<string>): void {
    // Simplenote's model declares no relationships (SPRelationshipResolver has nothing to resolve)
  }

  // MARK: Force sync

  forceSyncWithCompletion(completion: SPBucketForceSyncCompletion): void {
    this.forceSyncCompletion = completion;
    this.forceSyncSignature = this.lastChangeSignature;
    this.network.forceSyncBucket(this);
  }

  isForceSyncPending(): boolean {
    return this.forceSyncCompletion !== null;
  }

  signalForceSyncComplete(): void {
    if (this.forceSyncCompletion === null) {
      return;
    }
    const signatureUpdated = this.lastChangeSignature !== this.forceSyncSignature;
    this.forceSyncCompletion(signatureUpdated);
    this.forceSyncCompletion = null;
    this.forceSyncSignature = null;
  }

  hasLocalChangesForKey(key: string): boolean {
    return this.changeProcessor.hasLocalChangesForKey(key);
  }

  /** Debugging aid, answered to the server's "index" request. */
  exportStatus(): SPDict {
    const status: SPDict = {};
    status['current'] = this.lastChangeSignature ?? '';
    status['index'] = this.indexProcessor.exportIndexStatus(this);
    status['pendings'] = this.changeProcessor.exportPendingChanges();
    return status;
  }
}

export { SPMemberDefinition };
