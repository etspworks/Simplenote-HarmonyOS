// Port of SPChangeProcessor.h/.m and SPProcessorConstants.h/.m: applies remote changes ("c"
// messages) to ghosts and entities, rebasing any unsent local edit on top, and turns local edits
// into outgoing changes, keeping every pending / queued / retry key persisted across launches.
import { SPBucket, SPDiffableObject, dispatchMain } from './Bucket';
import { SPGhost, SPPersistentMutableDictionary, SPPersistentMutableSet } from './GhostStore';
import { SPDict, SPValue, dictFromJSONString, isValidJsonObject, makeUUID } from './JsonDiff';
import { UserDefaults } from '../Database';

// Changeset keys (SPProcessorConstants.m)
export const CH_KEY: string = 'id';
export const CH_ADD: string = '+';
export const CH_REMOVE: string = '-';
export const CH_MODIFY: string = 'M';
export const CH_OPERATION: string = 'o';
export const CH_VALUE: string = 'v';
export const CH_START_VERSION: string = 'sv';
export const CH_END_VERSION: string = 'ev';
export const CH_CHANGE_VERSION: string = 'cv';
export const CH_LOCAL_ID: string = 'ccid';
export const CH_CLIENT_ID: string = 'clientid';
export const CH_ERROR: string = 'error';
export const CH_DATA: string = 'd';
export const CH_EMPTY: string = 'EMPTY';

// Changeset errors (SPProcessorConstants.h CH_ERRORS)
export enum ChangesetError {
  INVALID_SCHEMA = 400,
  INVALID_PERMISSION = 401,
  NOT_FOUND = 404,
  BAD_VERSION = 405,
  DUPLICATE = 409,
  EMPTY_CHANGE = 412,
  DOCUMENT_TOO_LARGE = 413,
  EXPECTATION_FAILED = 417,
  INVALID_DIFF = 440,
  THRESHOLD = 503
}

const CH_SERVER_ERROR_RANGE_LOCATION: number = 500;
const CH_SERVER_ERROR_RANGE_LENGTH: number = 99;
const SP_CHANGE_PROCESSOR_MAX_PENDING_CHANGES: number = 200;

export enum SPProcessorErrors {
  SENT_DUPLICATE_CHANGE = 0,
  SENT_INVALID_CHANGE = 1,
  RECEIVED_UNKNOWN_CHANGE = 2,
  RECEIVED_INVALID_CHANGE = 3,
  ENTITY_GHOST_INTEGRITY = 4,
  CLIENT_OUT_OF_SYNC = 5,
  CLIENT_ERROR = 6,
  SERVER_ERROR = 7
}

export class SPProcessorError extends Error {
  code: SPProcessorErrors;

  constructor(code: SPProcessorErrors, description: string = '') {
    super(description);
    this.code = code;
  }
}

export type SPChangeSuccessHandler = (simperiumKey: string, version: string | null) => void;
export type SPChangeErrorHandler = (simperiumKey: string, version: string | null, error: SPProcessorError) => void;
export type SPChangeEnumerationBlock = (change: SPDict) => void;

function versionString(value: SPValue): string | null {
  return SPGhost.versionString(value);
}

export class SPChangeProcessor {
  readonly label: string;
  readonly clientID: string;
  private changesPending: SPPersistentMutableDictionary;
  private keysForObjectsWithMoreChanges: SPPersistentMutableSet;
  private keysForObjectsToDelete: SPPersistentMutableSet;
  private keysForObjectsWithPendingRetry: SPPersistentMutableSet;

  constructor(label: string, clientID: string) {
    this.label = label;
    this.clientID = clientID;
    this.changesPending = SPPersistentMutableDictionary.loadDictionaryWithLabel(label);
    this.keysForObjectsWithMoreChanges = SPPersistentMutableSet.loadSetWithLabel(`keysForObjectsWithMoreChanges-${label}`);
    this.keysForObjectsWithPendingRetry = SPPersistentMutableSet.loadSetWithLabel(`keysForObjectsWithPendingRetry-${label}`);
    this.keysForObjectsToDelete = SPPersistentMutableSet.loadSetWithLabel(`keysForObjectsToDelete-${label}`);
    this.migratePendingChangesIfNeeded();
  }

  reset(): void {
    this.changesPending.removeAllObjects();
    this.keysForObjectsWithMoreChanges.removeAllObjects();
    this.keysForObjectsWithPendingRetry.removeAllObjects();
    this.keysForObjectsToDelete.removeAllObjects();
    this.changesPending.save();
    this.keysForObjectsWithMoreChanges.save();
    this.keysForObjectsWithPendingRetry.save();
    this.keysForObjectsToDelete.save();
  }

  // MARK: - Remote changes (private helpers)

  /** Returns an error when the change carries one; null when the change is not an error. */
  private processRemoteError(change: SPDict): SPProcessorError | null {
    const raw = change[CH_ERROR];
    if (raw === null || raw === undefined) {
      return null;
    }
    const errorCode = typeof raw === 'number' ? raw as number : parseInt(String(raw), 10);
    let wrappedCode: SPProcessorErrors;
    let description: string;
    switch (errorCode) {
      case ChangesetError.DUPLICATE:
        wrappedCode = SPProcessorErrors.SENT_DUPLICATE_CHANGE;
        description = 'Duplicate Change';
        break;
      case ChangesetError.BAD_VERSION:
      case ChangesetError.EXPECTATION_FAILED:
      case ChangesetError.INVALID_DIFF:
        wrappedCode = SPProcessorErrors.SENT_INVALID_CHANGE;
        description = 'Invalid Change';
        break;
      default: {
        const isServerError = errorCode >= CH_SERVER_ERROR_RANGE_LOCATION &&
          errorCode < CH_SERVER_ERROR_RANGE_LOCATION + CH_SERVER_ERROR_RANGE_LENGTH;
        wrappedCode = isServerError ? SPProcessorErrors.SERVER_ERROR : SPProcessorErrors.CLIENT_ERROR;
        description = isServerError ? 'Server Error' : 'Client Error';
        break;
      }
    }
    return new SPProcessorError(wrappedCode, `${description} : ${errorCode}`);
  }

  private processRemoteDeleteWithKey(simperiumKey: string, bucket: SPBucket, objectWasFound: boolean): boolean {
    if (objectWasFound) {
      const object = bucket.storage.objectForKey(simperiumKey, bucket.name);
      if (object !== undefined) {
        bucket.storage.deleteObjectFromProcessor(object);
      }
      dispatchMain(() => {
        bucket.objectKeysDeleted(new Set<string>([simperiumKey]));
      });
    } else {
      dispatchMain(() => {
        bucket.acknowledgedObjectDeletion();
      });
    }
    return true;
  }

  /** Throws SPProcessorError on failure; false = nothing to do. */
  private processRemoteModifyWithKey(simperiumKey: string, bucket: SPBucket, change: SPDict,
    acknowledged: boolean, clientMatches: boolean): boolean {
    const storage = bucket.storage;
    let object: SPDiffableObject | undefined = storage.objectForKey(simperiumKey, bucket.name);
    let newlyAdded = false;

    if (object === undefined) {
      // If the change was sent by this very same client, and the object isn't available, don't add it.
      if (clientMatches) {
        return false;
      }
      newlyAdded = true;
      object = storage.insertNewObjectForBucketName(bucket.name, simperiumKey, true);
      const ghost = new SPGhost(object.simperiumKey, null);
      ghost.version = '0';
      object.ghost = ghost;
    }

    object.willBeRead();

    const ghost = object.ghost;
    if (ghost === null) {
      throw new SPProcessorError(SPProcessorErrors.RECEIVED_UNKNOWN_CHANGE);
    }
    const oldVersion = ghost.version;
    const startVersion = versionString(change[CH_START_VERSION]);
    const endVersion = versionString(change[CH_END_VERSION]);

    // Already at the end version? Nothing to apply
    if (ghost.version === endVersion) {
      return true;
    }

    if (startVersion !== null && oldVersion !== startVersion) {
      throw new SPProcessorError(SPProcessorErrors.CLIENT_OUT_OF_SYNC);
    }

    const oldGhost = ghost.mutableCopy();
    let diff: SPDict = (change[CH_VALUE] as SPDict) ?? {};

    try {
      bucket.differ.applyGhostDiffFromDictionary(diff, object);
    } catch (e) {
      throw new SPProcessorError(SPProcessorErrors.RECEIVED_INVALID_CHANGE, (e as Error).message);
    }

    ghost.version = endVersion;

    // Ghost integrity: never persist a ghost that cannot be encoded
    if (!isValidJsonObject(ghost.dictionary())) {
      throw new SPProcessorError(SPProcessorErrors.ENTITY_GHOST_INTEGRITY);
    }

    object.ghostData = ghost.toJSONString();

    // Rebase: if there are unsent local edits, transform the remote diff on top of them
    if (!acknowledged && !newlyAdded) {
      const oldDiff = bucket.differ.diffFromDictionary(oldGhost.memberData, object);
      if (Object.keys(oldDiff).length > 0) {
        try {
          diff = bucket.differ.transform(object, oldDiff, diff, oldGhost);
        } catch (e) {
          throw new SPProcessorError(SPProcessorErrors.RECEIVED_INVALID_CHANGE, (e as Error).message);
        }
        if (Object.keys(diff).length > 0) {
          // Load the new ghost data, and apply the transformed (local) diff on top of it
          const memberData = ghost.memberData;
          if (memberData !== null) {
            object.loadMemberData(memberData);
          }
          this.enqueueObjectForMoreChanges(simperiumKey, bucket);
        }
      }
    }

    if (!acknowledged && Object.keys(diff).length > 0) {
      try {
        bucket.differ.applyDiffFromDictionary(diff, object);
      } catch (e) {
        throw new SPProcessorError(SPProcessorErrors.RECEIVED_INVALID_CHANGE, (e as Error).message);
      }
    }

    storage.saveFromProcessor([object]);

    const changedMembers = Object.keys(diff);
    dispatchMain(() => {
      const keys = new Set<string>([simperiumKey]);
      if (newlyAdded) {
        bucket.objectsAdded(keys);
      } else if (acknowledged) {
        bucket.objectsAcknowledged(keys);
      } else {
        bucket.objectDidChange(simperiumKey, changedMembers);
      }
    });
    return true;
  }

  /** Throws SPProcessorError on failure. */
  private processRemoteChange(change: SPDict, bucket: SPBucket): boolean {
    const key = this.keyWithoutNamespaces(change, bucket);
    const operation = change[CH_OPERATION];
    const changeClientID = change[CH_CLIENT_ID];
    const clientMatches = changeClientID === this.clientID;
    const remove = operation === CH_REMOVE;
    const modify = operation === CH_MODIFY;
    const awaitingAck = this.awaitingAcknowledgementForKey(key);
    const acknowledged = awaitingAck && clientMatches;
    const objectWasFound = bucket.storage.objectForKey(key, bucket.name) !== undefined;

    // A remove operation, or an acknowledgement of this client's own change, clears the pending change
    if (remove || (objectWasFound && acknowledged && clientMatches)) {
      this.changesPending.removeObjectForKey(key);
    }

    if (remove && (objectWasFound || acknowledged)) {
      return this.processRemoteDeleteWithKey(key, bucket, objectWasFound);
    } else if (modify) {
      return this.processRemoteModifyWithKey(key, bucket, change, acknowledged, clientMatches);
    }
    return false;
  }

  // MARK: - Remote changes

  notifyOfRemoteChanges(changes: SPDict[], bucket: SPBucket): void {
    const changedKeys = new Set<string>();
    for (const change of changes) {
      const key = this.keyWithoutNamespaces(change, bucket);
      if (!this.awaitingAcknowledgementForKey(key)) {
        changedKeys.add(key);
      }
    }
    if (changedKeys.size === 0) {
      return;
    }
    bucket.objectsWillChange(changedKeys);
  }

  processRemoteChanges(changes: SPDict[], bucket: SPBucket, successHandler: SPChangeSuccessHandler,
    errorHandler: SPChangeErrorHandler): void {
    for (const change of changes) {
      const key = this.keyWithoutNamespaces(change, bucket);
      const version = versionString(change[CH_END_VERSION]);

      const remoteError = this.processRemoteError(change);
      if (remoteError !== null) {
        errorHandler(key, version, remoteError);
        continue;
      }

      let processed = false;
      try {
        processed = this.processRemoteChange(change, bucket);
      } catch (e) {
        if (e instanceof SPProcessorError) {
          errorHandler(key, version, e as SPProcessorError);
        } else {
          errorHandler(key, version, new SPProcessorError(SPProcessorErrors.RECEIVED_INVALID_CHANGE,
            (e as Error).message));
        }
        continue;
      }
      if (!processed) {
        continue;
      }

      successHandler(key, version);

      // Signature update: only after the change was successfully applied
      const changeVersion = versionString(change[CH_CHANGE_VERSION]);
      dispatchMain(() => {
        bucket.lastChangeSignature = changeVersion;
      });
    }

    this.changesPending.save();

    // Force sync: signal completion once there are no pending changes
    if (!bucket.isForceSyncPending() || this.changesPending.count > 0) {
      return;
    }
    dispatchMain(() => {
      bucket.signalForceSyncComplete();
    });
  }

  // MARK: - Change helpers

  enqueueObjectForMoreChanges(key: string, bucket: SPBucket): void {
    this.keysForObjectsWithMoreChanges.addObject(key);
    this.keysForObjectsWithMoreChanges.save();
  }

  enqueueObjectForDeletion(key: string, bucket: SPBucket): void {
    this.keysForObjectsToDelete.addObject(key);
    this.keysForObjectsToDelete.save();
  }

  enqueueObjectForRetry(key: string, bucket: SPBucket, overrideRemoteData: boolean): void {
    let success = true;
    const object = bucket.storage.objectForKey(key, bucket.name);
    const oldChange = this.changesPending.objectForKey(key);

    // Deleted object that is not a pending deletion: drop the change
    if (object === undefined && (oldChange === undefined || oldChange[CH_OPERATION] !== CH_REMOVE)) {
      this.changesPending.removeObjectForKey(key);
      success = false;
    } else if (object !== undefined && overrideRemoteData) {
      // Send the full object data, overriding whatever is in the backend
      const fullData = object.dictionary();
      const newChange = this.createChangeWithFullData(key, CH_MODIFY, object.ghost !== null ? object.ghost.version : null,
        fullData);
      this.changesPending.setObject(newChange, key);
    }

    if (success) {
      this.keysForObjectsWithPendingRetry.addObject(key);
      this.keysForObjectsWithPendingRetry.save();
    }
  }

  discardPendingChanges(key: string, bucket: SPBucket): void {
    this.changesPending.removeObjectForKey(key);
  }

  // MARK: - Local changes

  processLocalObjectsWithKeys(keys: Set<string>, bucket: SPBucket): SPDict[] {
    const changes: SPDict[] = [];
    const keysNotFound = new Set<string>(keys);
    const objects = bucket.storage.objectsForKeys(keys, bucket.name);

    for (const object of objects) {
      keysNotFound.delete(object.simperiumKey);

      // An object with a pending change waits for its ack: queue it for more changes
      if (this.changesPending.containsObjectForKey(object.simperiumKey)) {
        this.enqueueObjectForMoreChanges(object.simperiumKey, bucket);
        continue;
      }

      let newData: SPDict;
      const ghost = object.ghost;
      if (ghost !== null && ghost.memberData !== null) {
        newData = bucket.differ.diffFromDictionary(ghost.memberData, object);
      } else {
        newData = bucket.differ.diffForAddition(object);
      }

      if (Object.keys(newData).length > 0) {
        const change = this.createChange(object.simperiumKey, CH_MODIFY, ghost !== null ? ghost.version : null, newData);
        this.changesPending.setObject(change, object.simperiumKey);
        changes.push(change);
      }
    }

    // Objects deleted before their changes were sent: drop them
    keysNotFound.forEach((keyNotFound: string) => {
      this.changesPending.removeObjectForKey(keyNotFound);
      this.keysForObjectsWithMoreChanges.removeObject(keyNotFound);
    });
    if (keysNotFound.size > 0) {
      this.keysForObjectsWithMoreChanges.save();
    }

    this.changesPending.save();
    return changes;
  }

  processLocalDeletionsWithKeys(keys: Set<string>): SPDict[] {
    const changes: SPDict[] = [];
    keys.forEach((key: string) => {
      const change = this.createChange(key, CH_REMOVE, null, null);
      this.changesPending.setObject(change, key);
      changes.push(change);
    });
    this.changesPending.save();
    return changes;
  }

  processLocalBucketsDeletion(buckets: Set<SPBucket>): SPDict[] {
    const changes: SPDict[] = [];
    buckets.forEach((bucket: SPBucket) => {
      changes.push(this.createChange(bucket.name, CH_EMPTY, null, null));
    });
    return changes;
  }

  enumeratePendingChangesForBucket(bucket: SPBucket, block: SPChangeEnumerationBlock): void {
    if (this.changesPending.count === 0) {
      return;
    }
    for (const key of this.changesPending.allKeys()) {
      const change = this.changesPending.objectForKey(key);
      if (change !== undefined) {
        block(change);
      }
    }
  }

  enumerateQueuedChangesForBucket(bucket: SPBucket, block: SPChangeEnumerationBlock): void {
    const limit = Math.max(SP_CHANGE_PROCESSOR_MAX_PENDING_CHANGES - this.changesPending.count, 0);
    if (this.keysForObjectsWithMoreChanges.count === 0 || limit <= 0) {
      return;
    }
    const processedKeys = new Set<string>();
    for (const key of this.keysForObjectsWithMoreChanges.allObjects()) {
      if (processedKeys.size >= limit) {
        break;
      }
      if (!this.changesPending.containsObjectForKey(key)) {
        processedKeys.add(key);
      }
    }
    const changes = this.processLocalObjectsWithKeys(processedKeys, bucket);
    for (const change of changes) {
      block(change);
    }
    this.keysForObjectsWithMoreChanges.minusSet(processedKeys);
    this.keysForObjectsWithMoreChanges.save();
  }

  enumerateQueuedDeletionsForBucket(bucket: SPBucket, block: SPChangeEnumerationBlock): void {
    const limit = Math.max(SP_CHANGE_PROCESSOR_MAX_PENDING_CHANGES - this.changesPending.count, 0);
    if (this.keysForObjectsToDelete.count === 0 || limit <= 0) {
      return;
    }
    const processedKeys = new Set<string>();
    for (const key of this.keysForObjectsToDelete.allObjects()) {
      if (processedKeys.size >= limit) {
        break;
      }
      processedKeys.add(key);
    }
    const changes = this.processLocalDeletionsWithKeys(processedKeys);
    for (const change of changes) {
      block(change);
    }
    this.keysForObjectsToDelete.minusSet(processedKeys);
    this.keysForObjectsToDelete.save();
  }

  enumerateRetryChangesForBucket(bucket: SPBucket, block: SPChangeEnumerationBlock): void {
    if (this.keysForObjectsWithPendingRetry.count === 0) {
      return;
    }
    const processedKeys = new Set<string>();
    for (const key of this.keysForObjectsWithPendingRetry.allObjects()) {
      const change = this.changesPending.objectForKey(key);
      if (change !== undefined) {
        block(change);
      }
      processedKeys.add(key);
    }
    this.keysForObjectsWithPendingRetry.minusSet(processedKeys);
    this.keysForObjectsWithPendingRetry.save();
  }

  // MARK: - Helpers

  hasLocalChangesForKey(key: string): boolean {
    return this.changesPending.containsObjectForKey(key) ||
      this.keysForObjectsToDelete.containsObject(key) ||
      this.keysForObjectsWithMoreChanges.containsObject(key);
  }

  exportPendingChanges(): SPDict[] {
    const pendings: SPDict[] = [];
    for (const change of this.changesPending.allValues()) {
      const exported: SPDict = {};
      exported[CH_KEY] = change[CH_KEY];
      exported[CH_LOCAL_ID] = change[CH_LOCAL_ID];
      const startVersion = change[CH_START_VERSION];
      if (startVersion !== null && startVersion !== undefined) {
        exported[CH_START_VERSION] = startVersion;
      }
      pendings.push(exported);
    }
    return pendings;
  }

  get numChangesPending(): number {
    return this.changesPending.count;
  }

  get numKeysForObjectsWithMoreChanges(): number {
    return this.keysForObjectsWithMoreChanges.count;
  }

  get numKeysForObjectToDelete(): number {
    return this.keysForObjectsToDelete.count;
  }

  get reachedMaxPendings(): boolean {
    return this.changesPending.count >= SP_CHANGE_PROCESSOR_MAX_PENDING_CHANGES;
  }

  // MARK: - Changeset generation + metadata

  private keyWithoutNamespaces(change: SPDict, bucket: SPBucket): string {
    const changeKey = String(change[CH_KEY] ?? '');
    if (!bucket.exposeNamespace) {
      return changeKey;
    }
    return changeKey.split(`${bucket.localNamespace}/`).join('');
  }

  private createChangeWithFullData(key: string, operation: string, version: string | null, fullData: SPDict): SPDict {
    const change: SPDict = {};
    change[CH_KEY] = key;
    change[CH_LOCAL_ID] = makeUUID();
    change[CH_OPERATION] = operation;
    if (operation === CH_MODIFY && version !== null && parseInt(version, 10) !== 0) {
      change[CH_START_VERSION] = version;
    }
    change[CH_DATA] = fullData;
    return change;
  }

  private createChange(key: string, operation: string, version: string | null, data: SPDict | null): SPDict {
    const change: SPDict = {};
    change[CH_KEY] = key;
    change[CH_LOCAL_ID] = makeUUID();
    change[CH_OPERATION] = operation;
    if (data !== null) {
      change[CH_VALUE] = data;
    }
    if (operation === CH_MODIFY && version !== null && parseInt(version, 10) !== 0) {
      change[CH_START_VERSION] = version;
    }
    return change;
  }

  private awaitingAcknowledgementForKey(key: string): boolean {
    return this.changesPending.containsObjectForKey(key);
  }

  /** Pending changes used to live in NSUserDefaults as one JSON blob: move them over, once. */
  private migratePendingChangesIfNeeded(): void {
    const pendingKey = `changesPending-${this.label}`;
    const pendingJSON = UserDefaults.standard.string(pendingKey);
    if (pendingJSON === null) {
      return;
    }
    const pendingDict = dictFromJSONString(pendingJSON);
    if (pendingDict !== null) {
      for (const key of Object.keys(pendingDict)) {
        const change = pendingDict[key];
        if (change !== null && change !== undefined && typeof change === 'object') {
          this.changesPending.setObject(change as SPDict, key);
        }
      }
    }
    this.changesPending.save();
    UserDefaults.standard.removeObject(pendingKey);
  }
}
