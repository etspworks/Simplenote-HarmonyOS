// Port of SPIndexProcessor.h/.m: reconciles the server's index ("i" responses) with local
// entities, decides which versions must be downloaded, and applies downloaded versions ("e"
// responses during indexing), rebasing unsent local edits on top of them.
import { SPBucket, SPDiffableObject, dispatchMain } from './Bucket';
import { SPGhost } from './GhostStore';
import { SPDict, SPValue, isDict } from './JsonDiff';

const SP_INDEX_PROCESSOR_BATCH_SIZE: number = 50;

// Index of each element of a version tuple [key, version, data]
export const SP_VERSION_KEY: number = 0;
export const SP_VERSION_NUMBER: number = 1;
export const SP_VERSION_DATA: number = 2;

/** One downloaded version: key, version string and the entity payload. */
export class SPVersionTuple {
  key: string;
  version: string;
  data: SPDict;

  constructor(key: string, version: string, data: SPDict) {
    this.key = key;
    this.version = version;
    this.data = data;
  }
}

export type SPVersionHandler = (key: string, version: string) => void;
export type SPChangeHandler = (key: string) => void;

export class SPIndexProcessor {
  private keysForObjectsWithRebaseDisabled: Set<string> = new Set<string>();
  private keysForObjectsWithPendingReload: Set<string> = new Set<string>();

  /** Walks the index and asks for every version the local store doesn't already hold. */
  processIndex(indexArray: SPDict[], bucket: SPBucket, versionHandler: SPVersionHandler): void {
    const indexDict = new Map<string, SPValue>();
    const batchLists: string[][] = [[]];
    for (const dict of indexArray) {
      const key = String(dict['id']);
      indexDict.set(key, dict['v']);
      let current = batchLists[batchLists.length - 1];
      if (current.length === SP_INDEX_PROCESSOR_BATCH_SIZE) {
        current = [];
        batchLists.push(current);
      }
      current.push(key);
    }

    // Objects gone from the remote index are removed locally
    this.reconcileLocalAndRemoteIndex(new Set<string>(indexDict.keys()), bucket);

    for (const batchList of batchLists) {
      const objects = bucket.storage.faultObjectsForKeys(batchList, bucket.name);
      for (const key of batchList) {
        const version = SPGhost.versionString(indexDict.get(key)) ?? '';
        const object = objects.get(key);
        const shouldReload = this.keysForObjectsWithPendingReload.has(key);
        const localVersion = object !== undefined && object.ghost !== null ? object.ghost.version : null;
        if (!shouldReload && localVersion !== null && version === localVersion) {
          continue;
        }
        versionHandler(key, version);
        this.keysForObjectsWithPendingReload.delete(key);
      }
    }
  }

  private reconcileLocalAndRemoteIndex(remoteKeySet: Set<string>, bucket: SPBucket): void {
    const localKeySet = new Set<string>(bucket.storage.objectKeysForBucketName(bucket.name));
    remoteKeySet.forEach((key: string) => {
      localKeySet.delete(key);
    });
    if (localKeySet.size === 0) {
      return;
    }

    const keysForDeletedObjects = new Set<string>();
    const objectsToDelete = bucket.storage.objectsForKeys(localKeySet, bucket.name);
    for (const objectToDelete of objectsToDelete) {
      // Never synced (no ghost data): it's a local-only object that hasn't been uploaded yet
      if (objectToDelete.ghost === null || objectToDelete.ghost.memberData === null) {
        continue;
      }
      keysForDeletedObjects.add(objectToDelete.simperiumKey);
      bucket.storage.deleteObjectFromProcessor(objectToDelete);
    }

    dispatchMain(() => {
      bucket.objectKeysDeleted(keysForDeletedObjects);
    });
  }

  /** Applies downloaded versions; `changeHandler` is told about every rebased key. */
  processVersions(versions: SPVersionTuple[], bucket: SPBucket, changeHandler: SPChangeHandler): void {
    const addedKeys = new Set<string>();
    const changedKeys = new Set<string>();
    const rebasedKeys = new Set<string>();
    const touched: SPDiffableObject[] = [];

    const objectKeys: string[] = versions.map((v: SPVersionTuple) => v.key);
    const objects = bucket.storage.faultObjectsForKeys(objectKeys, bucket.name);

    for (const versionData of versions) {
      const key = versionData.key;
      const version = versionData.version;
      const data = versionData.data;
      let ghostData: SPDict;
      let object: SPDiffableObject | undefined = objects.get(key);

      if (object === undefined) {
        // Brand new object
        object = bucket.storage.insertNewObjectForBucketName(bucket.name, key, true);
        object.bucket = bucket;
        object.loadMemberData(data);
        ghostData = object.dictionary();
        addedKeys.add(key);
      } else {
        // Existing object: remember any unsent local edit before loading the remote version
        object.willBeRead();
        const localGhost = object.ghost !== null ? object.ghost.mutableCopy() : new SPGhost(key, null);
        const localDiff = bucket.differ.diffFromDictionary(localGhost.memberData, object);

        object.loadMemberData(data);
        ghostData = object.dictionary();

        const isRebaseDisabled = this.keysForObjectsWithRebaseDisabled.has(key);
        if (Object.keys(localDiff).length > 0 && !isRebaseDisabled) {
          const remoteDiff = bucket.differ.diffFromDictionary(localGhost.memberData, object);
          try {
            const rebaseDiff = Object.keys(remoteDiff).length > 0 ?
              bucket.differ.transform(object, localDiff, remoteDiff, localGhost) : localDiff;
            if (Object.keys(rebaseDiff).length > 0) {
              bucket.differ.applyDiffFromDictionary(rebaseDiff, object);
            }
          } catch (e) {
            console.error(`Simperium error: rebase failed for ${bucket.name}.${key}: ${(e as Error).message}`);
          }
          rebasedKeys.add(key);
        }

        changedKeys.add(key);
        if (isRebaseDisabled) {
          this.keysForObjectsWithRebaseDisabled.delete(key);
        }
      }

      const ghost = new SPGhost(object.simperiumKey, ghostData);
      ghost.version = version;
      object.ghost = ghost;
      object.ghostData = ghost.toJSONString();
      touched.push(object);
    }

    bucket.storage.saveFromProcessor(touched);

    // Rebased entities get their local changes (re)calculated and enqueued
    rebasedKeys.forEach((key: string) => {
      changeHandler(key);
    });

    dispatchMain(() => {
      bucket.resolvePendingRelationshipsToKeys(addedKeys);
      if (!bucket.notifyWhileIndexing) {
        return;
      }
      bucket.objectsAdded(addedKeys);
      changedKeys.forEach((key: string) => {
        bucket.objectDidChange(key, null);
      });
    });
  }

  enableRebaseForAllObjects(): void {
    this.keysForObjectsWithRebaseDisabled.clear();
  }

  enableRebaseForObjectWithKey(simperiumKey: string): void {
    this.keysForObjectsWithRebaseDisabled.delete(simperiumKey);
  }

  disableRebaseForObjectWithKey(simperiumKey: string): void {
    this.keysForObjectsWithRebaseDisabled.add(simperiumKey);
  }

  enableReloadForObjectWithKey(simperiumKey: string): void {
    this.keysForObjectsWithPendingReload.add(simperiumKey);
  }

  disableReloadForAllObjects(): void {
    this.keysForObjectsWithPendingReload.clear();
  }

  exportIndexStatus(bucket: SPBucket): SPDict[] {
    const index: SPDict[] = [];
    for (const object of bucket.storage.objectsForBucketName(bucket.name)) {
      const entry: SPDict = {};
      entry[object.simperiumKey] = object.ghost !== null ? object.ghost.version : null;
      index.push(entry);
    }
    return index;
  }
}

/** Builds a version tuple from the raw [key, version, data] triple, when well formed. */
export function versionTupleFrom(key: string, version: string, data: SPValue): SPVersionTuple | null {
  return isDict(data) ? new SPVersionTuple(key, version, data as SPDict) : null;
}
