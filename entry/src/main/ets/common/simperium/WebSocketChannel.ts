// Port of SPWebSocketInterface.h/.m, SPWebSocketChannel.h/.m and SPWebSocket.h/.m (the
// SocketRocket wrapper) over @kit.NetworkKit webSocket. One socket per Simperium instance, one
// numbered channel per bucket, speaking the Simperium protocol:
//   <channel>:init:{json}   <channel>:auth:<email|{error}>   <channel>:i::<mark>::<limit>
//   <channel>:cv:<signature>   <channel>:c:[changes]   <channel>:e:<key>.<version>[\n{payload}]
//   <channel>:o:{options}   <channel>:index   h:<n> (heartbeat)   log:<level>
import { webSocket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { SPUser } from '../../model/SPUser';
import { SPBucket, SPDiffableObject, dispatchMain } from './Bucket';
import { SPProcessorError, SPProcessorErrors } from './ChangeProcessor';
import { SPVersionTuple } from './IndexProcessor';
import { SPDict, SPValue, dictFromJSONString, isDict, jsonString, objectFromJSONString } from './JsonDiff';

// SPEnvironment.m
export const SP_BASE_URL: string = 'https://api.simperium.com/1/';
export const SP_AUTH_URL: string = 'https://auth.simperium.com/1/';
export const SP_WEBSOCKET_URL: string = 'wss://api.simperium.com/sock/1';
export const SP_TERMS_OF_SERVICE_URL: string = 'https://simperium.com/tos/';
export const SP_API_VERSION: string = '1.1';
export const SP_LIBRARY_ID: string = 'ios';
export const SP_LIBRARY_VERSION: string = '1.9.0';

// SPWebSocketInterface.m
const SP_WEBSOCKET_HEARTBEAT_INTERVAL_MS: number = 30 * 1000;
export const COM_AUTH: string = 'auth';
export const COM_INDEX: string = 'i';
export const COM_CHANGE: string = 'c';
export const COM_CHANGE_VERSION: string = 'cv';
export const COM_ENTITY: string = 'e';
export const COM_ERROR: string = '?';
export const COM_LOG: string = 'log';
export const COM_INDEX_STATE: string = 'index';
export const COM_HEARTBEAT: string = 'h';
export const COM_OPTIONS: string = 'o';

enum SPRemoteLogging {
  OFF = 0,
  REGULAR = 1,
  VERBOSE = 2
}

// SPWebSocketChannel.m
enum SPWebsocketAuthError {
  TOKEN_MALFORMED = 400,
  TOKEN_INVALID = 401
}

const SP_WEBSOCKET_MAX_PENDING_VERSIONS: number = 200;
const SP_WEBSOCKET_CHANGES_BATCH_SIZE: number = 20;
const SP_WEBSOCKET_INDEX_PAGE_SIZE: number = 500;
const SP_WEBSOCKET_INDEX_BATCH_SIZE: number = 20;
const SP_WEBSOCKET_ERROR_MARK: string = '{';
const SP_WEBSOCKET_ERROR_CODE_KEY: string = 'code';
const SP_WEBSOCKET_SYNC_TIMEOUT_INTERVAL_MS: number = 180 * 1000;
const SP_WEBSOCKET_RETRY_DELAY_MS: number = 2000;

/** What the network layer needs from Simperium (kept as an interface to avoid an import cycle). */
export interface SPSimperiumContext {
  readonly clientID: string;
  readonly appID: string | null;
  readonly label: string;
  readonly networkEnabled: boolean;
  user: SPUser | null;
  remoteLoggingEnabled: boolean;
  verboseLoggingEnabled: boolean;
  bucketForName(name: string): SPBucket | null;
  /** The SPAuthenticationDidFail notification. */
  authenticationDidFail(): void;
}

// MARK: - SPWebSocket (SocketRocket wrapper)

export enum SPWebSocketReadyState {
  CONNECTING = 0,
  OPEN = 1,
  CLOSING = 2,
  CLOSED = 3
}

export interface SPWebSocketDelegate {
  webSocketDidOpen(socket: SPWebSocket): void;
  webSocketDidFailWithError(socket: SPWebSocket, error: Error): void;
  webSocketDidReceiveMessage(socket: SPWebSocket, message: string): void;
  webSocketDidCloseWithCode(socket: SPWebSocket, code: number, reason: string, wasClean: boolean): void;
}

export class SPWebSocket {
  delegate: SPWebSocketDelegate | null = null;
  readyState: SPWebSocketReadyState = SPWebSocketReadyState.CONNECTING;
  lastSeenTimestamp: Date | null = null;
  bytesReceived: number = 0;
  bytesSent: number = 0;
  private url: string;
  private socket: webSocket.WebSocket = webSocket.createWebSocket();

  constructor(url: string) {
    this.url = url;
  }

  open(): void {
    this.socket.on('open', () => {
      this.readyState = SPWebSocketReadyState.OPEN;
      this.lastSeenTimestamp = new Date();
      if (this.delegate !== null) {
        this.delegate.webSocketDidOpen(this);
      }
    });
    this.socket.on('message', (err: BusinessError, value: string | ArrayBuffer) => {
      if (err) {
        return;
      }
      const message = typeof value === 'string' ? value as string : '';
      this.bytesReceived += message.length;
      this.lastSeenTimestamp = new Date();
      if (this.delegate !== null) {
        this.delegate.webSocketDidReceiveMessage(this, message);
      }
    });
    this.socket.on('close', (err: BusinessError, value: webSocket.CloseResult) => {
      this.readyState = SPWebSocketReadyState.CLOSED;
      if (this.delegate !== null) {
        const code = value !== undefined ? value.code : 0;
        const reason = value !== undefined ? value.reason : '';
        this.delegate.webSocketDidCloseWithCode(this, code, reason, code === 1000);
      }
    });
    this.socket.on('error', (err: BusinessError) => {
      this.readyState = SPWebSocketReadyState.CLOSED;
      if (this.delegate !== null) {
        this.delegate.webSocketDidFailWithError(this, new Error(`WebSocket error ${err.code}: ${err.message}`));
      }
    });
    this.readyState = SPWebSocketReadyState.CONNECTING;
    this.socket.connect(this.url).catch((e: BusinessError) => {
      this.readyState = SPWebSocketReadyState.CLOSED;
      if (this.delegate !== null) {
        this.delegate.webSocketDidFailWithError(this, new Error(`WebSocket connect failed ${e.code}: ${e.message}`));
      }
    });
  }

  send(message: string): void {
    if (this.readyState !== SPWebSocketReadyState.OPEN) {
      return;
    }
    this.bytesSent += message.length;
    this.socket.send(message).catch((e: BusinessError) => {
      console.error(`Simperium websocket send failed: ${e.message}`);
    });
  }

  close(): void {
    if (this.readyState === SPWebSocketReadyState.CLOSED) {
      return;
    }
    this.readyState = SPWebSocketReadyState.CLOSING;
    this.socket.close().catch((e: BusinessError) => {
      console.error(`Simperium websocket close failed: ${e.message}`);
    }).finally(() => {
      this.socket.off('open');
      this.socket.off('message');
      this.socket.off('close');
      this.socket.off('error');
    });
  }
}

/** NSString+Simperium sp_componentsSeparatedByString:limit: */
function componentsSeparatedByString(text: string, separator: string, limit: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (out.length < limit - 1) {
    const index = rest.indexOf(separator);
    if (index === -1) {
      break;
    }
    out.push(rest.substring(0, index));
    rest = rest.substring(index + separator.length);
  }
  out.push(rest);
  return out;
}

// MARK: - SPWebSocketChannel

export class SPWebSocketChannel {
  number: number = 0;
  name: string = '';
  remoteName: string = '';
  authenticated: boolean = false;
  webSocketManager: SPWebSocketInterface | null = null;
  private simperium: SPSimperiumContext;
  private indexArray: SPDict[] = [];
  private changesBatch: SPDict[] = [];
  private versionsBatch: SPVersionTuple[] = [];
  private versionsPending: Map<string, string> = new Map<string, string>();
  private objectVersionsPending: number = 0;
  private started: boolean = false;
  private indexing: boolean = false;
  private retrievingObjectHistory: boolean = false;
  private shouldSendEverything: boolean = false;
  private onLocalChangesSent: (() => void) | null = null;
  private pendingLastChangeSignature: string | null = null;
  private nextMark: string | null = null;
  private syncTimeoutTimer: number = -1;

  constructor(simperium: SPSimperiumContext) {
    this.simperium = simperium;
  }

  // MARK: Object Versions

  requestVersions(numVersions: number, object: SPDiffableObject): void {
    if (this.retrievingObjectHistory) {
      return;
    }
    this.retrievingObjectHistory = true;
    const lastVersion = object.ghost !== null && object.ghost.version !== null ? parseInt(object.ghost.version, 10) : 0;
    const firstVersion = Math.max(lastVersion - numVersions, 1);
    for (let version = lastVersion; version >= firstVersion; --version) {
      this.requestVersion(`${version}`, object.simperiumKey);
    }
  }

  requestLatestVersionsForBucket(bucket: SPBucket): void {
    // Multiple errors could try to trigger multiple index refreshes
    if (this.indexing) {
      return;
    }
    this.indexing = true;
    // Send any pending changes first
    this.setShouldSendEverything();
    this.sendChangesForBucketWithCompletion(bucket, () => {
      this.requestLatestVersionsForBucketWithMark(bucket, null);
    });
  }

  private requestVersion(version: string, simperiumKey: string): void {
    if (version.length === 0 || simperiumKey.length === 0) {
      return;
    }
    ++this.objectVersionsPending;
    this.send(`${this.number}:e:${simperiumKey}.${version}`);
  }

  private requestVersionsInBatch(versions: Map<string, string>): void {
    versions.forEach((version: string, key: string) => {
      this.versionsPending.set(key, version);
    });
    this.requestPendingVersionsIfNeeded();
  }

  private requestPendingVersionsIfNeeded(): void {
    const requestedKeys: string[] = [];
    for (const entry of Array.from(this.versionsPending.entries())) {
      if (this.reachedMaximumPendingVersions()) {
        break;
      }
      this.requestVersion(entry[1], entry[0]);
      requestedKeys.push(entry[0]);
    }
    for (const key of requestedKeys) {
      this.versionsPending.delete(key);
    }
  }

  private hasPendingVersionRequests(): boolean {
    return this.versionsPending.size !== 0;
  }

  private reachedMaximumPendingVersions(): boolean {
    return this.objectVersionsPending > SP_WEBSOCKET_MAX_PENDING_VERSIONS;
  }

  // MARK: Sending Object Changes

  sendObjectDeletion(object: SPDiffableObject): void {
    const key = object.simperiumKey;
    const bucket = object.bucket;
    if (key.length === 0 || bucket === null) {
      console.warn('Simperium received DELETION request for nil key');
      return;
    }
    bucket.processorQueue.async(() => {
      const processor = bucket.changeProcessor;
      if (this.indexing || !this.authenticated || processor.reachedMaxPendings) {
        processor.enqueueObjectForDeletion(key, bucket);
      } else {
        const changes = processor.processLocalDeletionsWithKeys(new Set<string>([key]));
        for (const change of changes) {
          this.sendChange(change);
        }
      }
    });
  }

  sendObjectChanges(object: SPDiffableObject): void {
    const key = object.simperiumKey;
    const bucket = object.bucket;
    if (key.length === 0 || bucket === null) {
      console.warn(`Simperium tried to send changes for an object with a nil simperiumKey (${this.name})`);
      return;
    }
    bucket.processorQueue.async(() => {
      const processor = bucket.changeProcessor;
      if (this.indexing || !this.authenticated || processor.reachedMaxPendings) {
        processor.enqueueObjectForMoreChanges(key, bucket);
      } else {
        const changes = processor.processLocalObjectsWithKeys(new Set<string>([key]), bucket);
        for (const change of changes) {
          this.sendChange(change);
        }
      }
    });
  }

  shareObject(object: SPDiffableObject, email: string): void {
    // Not yet implemented with WebSockets (same as the ObjC library)
    console.warn(`Simperium: sharing ${object.simperiumKey} with ${email} is not supported over websockets`);
  }

  // MARK: Bucket Helpers

  removeAllBucketObjects(bucket: SPBucket): void {
    const changes = bucket.changeProcessor.processLocalBucketsDeletion(new Set<SPBucket>([bucket]));
    for (const change of changes) {
      this.send(`${this.number}:c:${jsonString(change)}`);
    }
  }

  // MARK: Response Handlers

  handleAuthResponse(responseString: string, bucket: SPBucket): void {
    if (responseString.indexOf(SP_WEBSOCKET_ERROR_MARK) === 0) {
      console.warn(`Simperium received unexpected auth response: ${responseString}`);
      const authPayload = dictFromJSONString(responseString);
      if (authPayload !== null) {
        const errorCode = Number(authPayload[SP_WEBSOCKET_ERROR_CODE_KEY]);
        if (errorCode === SPWebsocketAuthError.TOKEN_MALFORMED || errorCode === SPWebsocketAuthError.TOKEN_INVALID) {
          this.simperium.authenticationDidFail();
        }
      }
      return;
    }

    this.authenticated = true;
    this.started = false;
    this.indexing = false;
    this.retrievingObjectHistory = false;
    this.shouldSendEverything = false;
    if (this.simperium.user !== null) {
      this.simperium.user.email = responseString;
    }
    this.onLocalChangesSent = null;
    this.objectVersionsPending = 0;
    this.versionsPending.clear();

    // Reset disable-rebase mechanism + reset reload mechanism
    bucket.processorQueue.async(() => {
      bucket.indexProcessor.enableRebaseForAllObjects();
      bucket.indexProcessor.disableReloadForAllObjects();
    });

    // Download the index, on the 1st sync
    if (bucket.lastChangeSignature === null) {
      this.requestLatestVersionsForBucket(bucket);
    } else {
      this.startProcessingChangesForBucket(bucket);
    }
  }

  handleRemoteChanges(changes: SPDict[], bucket: SPBucket): void {
    // Batch-Processing: speeds up sync'ing of large databases
    bucket.processorQueue.async(() => {
      for (const change of changes) {
        this.changesBatch.push(change);
      }
      const shouldProcess = !this.started ||
        this.changesBatch.length % SP_WEBSOCKET_CHANGES_BATCH_SIZE === 0 ||
        bucket.changeProcessor.numChangesPending < SP_WEBSOCKET_CHANGES_BATCH_SIZE;
      if (!shouldProcess) {
        return;
      }
      const receivedBatch = this.changesBatch;
      this.changesBatch = [];
      this.started = true;
      this.processBatchChanges(receivedBatch, bucket);
    });
    // Signal there's activity in the channel
    this.invalidateSyncTimeoutTimer();
  }

  private processBatchChanges(changes: SPDict[], bucket: SPBucket): void {
    const changeProcessor = bucket.changeProcessor;
    const indexProcessor = bucket.indexProcessor;

    // Stash unsaved local edits so remote saves don't swallow them, then notify the delegates
    bucket.storage.stashUnsavedObjects();
    changeProcessor.notifyOfRemoteChanges(changes, bucket);

    // Failsafe: Don't proceed if we just got deauthenticated
    if (!this.authenticated) {
      return;
    }

    changeProcessor.processRemoteChanges(changes, bucket,
      (simperiumKey: string, version: string | null) => {
        indexProcessor.enableRebaseForObjectWithKey(simperiumKey);
      },
      (simperiumKey: string, version: string | null, error: SPProcessorError) => {
        console.error(`Simperium Error [${error.message}] while processing changes for object [${bucket.name}][${simperiumKey}]`);
        switch (error.code) {
          case SPProcessorErrors.CLIENT_OUT_OF_SYNC:
            dispatchMain(() => {
              this.requestLatestVersionsForBucket(bucket);
            });
            break;
          case SPProcessorErrors.SENT_DUPLICATE_CHANGE:
            changeProcessor.discardPendingChanges(simperiumKey, bucket);
            break;
          case SPProcessorErrors.SENT_INVALID_CHANGE:
            changeProcessor.enqueueObjectForRetry(simperiumKey, bucket, true);
            indexProcessor.disableRebaseForObjectWithKey(simperiumKey);
            break;
          case SPProcessorErrors.ENTITY_GHOST_INTEGRITY:
            indexProcessor.disableRebaseForObjectWithKey(simperiumKey);
            changeProcessor.discardPendingChanges(simperiumKey, bucket);
            changeProcessor.enqueueObjectForRetry(simperiumKey, bucket, true);
            break;
          case SPProcessorErrors.SERVER_ERROR:
            changeProcessor.enqueueObjectForRetry(simperiumKey, bucket, false);
            break;
          case SPProcessorErrors.CLIENT_ERROR:
            changeProcessor.discardPendingChanges(simperiumKey, bucket);
            break;
          case SPProcessorErrors.RECEIVED_INVALID_CHANGE:
            // Prevent re-entrant calls: Indexing flag is modified only on the main thread
            dispatchMain(() => {
              if (!this.indexing) {
                this.requestVersion(version ?? '', simperiumKey);
                return;
              }
              bucket.processorQueue.async(() => {
                indexProcessor.enableReloadForObjectWithKey(simperiumKey);
              });
            });
            break;
          default:
            break;
        }
      });

    // After remote changes have been processed, send any local change queued in the meantime
    dispatchMain(() => {
      this.sendChangesForBucket(bucket);
    });
  }

  handleIndexResponse(responseString: string, bucket: SPBucket): void {
    if (!this.indexing) {
      console.error('ERROR: Index response was NOT expected!');
    }
    const responseDict = dictFromJSONString(responseString) ?? {};
    const currentIndexArray = responseDict['index'];
    const current = responseDict['current'];
    let currentString = '';
    if (typeof current === 'number') {
      currentString = `${Math.trunc(current as number)}`;
    } else if (typeof current === 'string') {
      currentString = current as string;
    }
    this.pendingLastChangeSignature = currentString;
    const mark = responseDict['mark'];
    this.nextMark = typeof mark === 'string' ? mark as string : null;

    // Remember all the retrieved data in case there's more to get
    if (Array.isArray(currentIndexArray)) {
      for (const entry of currentIndexArray as Object[]) {
        if (isDict(entry)) {
          this.indexArray.push(entry as SPDict);
        }
      }
    }

    if (this.nextMark !== null && this.nextMark.length > 0) {
      // Another page: keep going until there are none left
      this.requestLatestVersionsForBucketWithMark(bucket, this.nextMark);
    } else {
      // Index retrieval is complete, so get all the versions
      this.requestVersionsForKeys(this.indexArray, bucket);
      this.indexArray = [];
    }
  }

  handleVersionResponse(responseString: string, bucket: SPBucket): void {
    if (responseString === '?') {
      console.error(`Simperium error: '?' response during version retrieval (${bucket.name})`);
      this.objectVersionsPending--;
      return;
    }

    // Expected format is: key_here.maybe.with.periods.VERSIONSTRING\n{payload}
    const headerLocation = responseString.indexOf('\n');
    if (headerLocation === -1) {
      console.error(`Simperium error: version header not found during version retrieval (${bucket.name})`);
      this.objectVersionsPending--;
      return;
    }
    const keyLocation = responseString.lastIndexOf('.', headerLocation);
    if (keyLocation === -1) {
      console.error(`Simperium error: version key not found during version retrieval (${bucket.name})`);
      this.objectVersionsPending--;
      return;
    }
    const key = responseString.substring(0, keyLocation);
    const version = responseString.substring(keyLocation + 1, headerLocation);
    const payload = responseString.substring(headerLocation + 1);

    // With websockets, the data is wrapped up in a dictionary, so unwrap it
    const payloadDict = dictFromJSONString(payload);
    const dataValue: SPValue = payloadDict !== null ? payloadDict['data'] : null;
    if (!isDict(dataValue)) {
      console.error(`Simperium error: version had no data (${bucket.name}): ${key}`);
      this.objectVersionsPending--;
      return;
    }
    const dataDict = dataValue as SPDict;

    if (this.retrievingObjectHistory) {
      // Going back in time: hand the result directly to the delegate
      if (--this.objectVersionsPending === 0) {
        this.retrievingObjectHistory = false;
      }
      const d = bucket.delegate;
      if (d !== null && d.bucketDidReceiveObjectForKey !== undefined) {
        d.bucketDidReceiveObjectForKey(bucket, key, version, dataDict);
      }
    } else {
      // Otherwise, process the result for indexing, in batches
      this.versionsBatch.push(new SPVersionTuple(key, version, dataDict));
      if ((this.versionsBatch.length === this.objectVersionsPending &&
        this.objectVersionsPending < SP_WEBSOCKET_INDEX_BATCH_SIZE) ||
        (this.versionsBatch.length % SP_WEBSOCKET_INDEX_BATCH_SIZE === 0)) {
        this.processVersionsBatchForBucket(bucket);
      }
    }
  }

  handleOptions(options: string, bucket: SPBucket): void {
    const optionsDict = dictFromJSONString(options) ?? {};
    const namespace = optionsDict['namespace'];
    bucket.localNamespace = typeof namespace === 'string' ? namespace as string : '';
    bucket.exposeNamespace = optionsDict['expose_namespace'] === true || optionsDict['expose_namespace'] === 1;
  }

  handleIndexStatusRequest(bucket: SPBucket): void {
    this.send(`${this.number}:index:${jsonString(bucket.exportStatus())}`);
  }

  // MARK: Initialization

  startProcessingChangesForBucket(bucket: SPBucket): void {
    if (!this.authenticated) {
      return;
    }
    // Start getting changes from the last cv
    this.send(`${this.number}:cv:${bucket.lastChangeSignature ?? ''}`);
    // In the next changeset-handling cycle, let's send everything
    this.setShouldSendEverything();
  }

  stop(): void {
    this.authenticated = false;
    this.webSocketManager = null;
    this.invalidateSyncTimeoutTimer();
  }

  // MARK: Sending Changes

  private setShouldSendEverything(): void {
    this.shouldSendEverything = true;
  }

  private sendChangesForBucketWithCompletion(bucket: SPBucket, completion: () => void): void {
    this.onLocalChangesSent = completion;
    this.sendChangesForBucket(bucket);
  }

  sendChangesForBucket(bucket: SPBucket): void {
    if (!this.authenticated) {
      return;
    }
    // 'onlyQueuedChanges' set to false will post **every** pending change, again
    const onlyQueuedChanges = !this.shouldSendEverything;
    const processor = bucket.changeProcessor;
    const block = (change: SPDict): void => {
      this.sendChange(change);
    };

    bucket.processorQueue.async(() => {
      if (onlyQueuedChanges) {
        processor.enumerateRetryChangesForBucket(bucket, block);
      } else {
        processor.enumeratePendingChangesForBucket(bucket, block);
      }
      processor.enumerateQueuedChangesForBucket(bucket, block);
      processor.enumerateQueuedDeletionsForBucket(bucket, block);

      // Ready posting local changes. If needed, hit the callback
      if (this.onLocalChangesSent === null) {
        return;
      }
      if (processor.numChangesPending > 0 || processor.numKeysForObjectsWithMoreChanges > 0 ||
        processor.numKeysForObjectToDelete > 0) {
        return;
      }
      dispatchMain(() => {
        const callback = this.onLocalChangesSent;
        if (callback !== null) {
          this.onLocalChangesSent = null;
          callback();
        }
      });
    });

    // Already done
    this.shouldSendEverything = false;
  }

  private sendChange(change: SPDict): void {
    dispatchMain(() => {
      this.send(`${this.number}:c:${jsonString(change)}`);
      this.startSyncTimeoutTimer();
    });
  }

  private send(message: string): void {
    if (this.webSocketManager !== null) {
      this.webSocketManager.send(message);
    }
  }

  // MARK: Index Handling

  private requestLatestVersionsForBucketWithMark(bucket: SPBucket, mark: string | null): void {
    if (this.simperium.user === null) {
      console.error('Simperium critical error: tried to retrieve index with no user set');
      return;
    }
    // Get an index of all objects and fetch their latest versions
    this.indexing = true;
    this.send(`${this.number}:i::${mark ?? ''}::${SP_WEBSOCKET_INDEX_PAGE_SIZE}`);
  }

  private processVersionsBatchForBucket(bucket: SPBucket): void {
    this.requestPendingVersionsIfNeeded();
    if (this.versionsBatch.length === 0) {
      return;
    }
    const batch = this.versionsBatch.slice();
    const newPendings = Math.max(0, this.objectVersionsPending - batch.length);
    const shouldHitFinished = this.indexing && newPendings === 0 && !this.hasPendingVersionRequests();

    bucket.processorQueue.async(() => {
      if (!this.authenticated) {
        return;
      }
      bucket.indexProcessor.processVersions(batch, bucket, (key: string) => {
        // Local version was different, so nuke old changes, and recalculate the delta
        bucket.changeProcessor.discardPendingChanges(key, bucket);
        bucket.changeProcessor.enqueueObjectForMoreChanges(key, bucket);
      });
      if (shouldHitFinished) {
        dispatchMain(() => {
          this.allVersionsFinishedForBucket(bucket);
        });
      }
    });

    this.objectVersionsPending = newPendings;
    this.versionsBatch = [];
  }

  private requestVersionsForKeys(currentIndexArray: SPDict[], bucket: SPBucket): void {
    // Stash unsaved edits: regular syncing is disabled during index retrieval
    bucket.storage.stashUnsavedObjects();

    const d = bucket.delegate;
    if (d !== null && d.bucketWillStartIndexing !== undefined) {
      d.bucketWillStartIndexing(bucket);
    }

    const indexArrayCopy = currentIndexArray.slice();
    bucket.processorQueue.async(() => {
      if (!this.authenticated) {
        return;
      }
      const pendingVersionRequests = new Map<string, string>();
      bucket.indexProcessor.processIndex(indexArrayCopy, bucket, (key: string, version: string) => {
        pendingVersionRequests.set(key, version);
      });
      dispatchMain(() => {
        this.requestVersionsInBatch(pendingVersionRequests);
      });
      // If no requests were queued, then all is good; back to processing
      if (pendingVersionRequests.size === 0) {
        dispatchMain(() => {
          this.allVersionsFinishedForBucket(bucket);
        });
      }
    });
  }

  private allVersionsFinishedForBucket(bucket: SPBucket): void {
    this.processVersionsBatchForBucket(bucket);

    // All versions were received successfully, so update the lastChangeSignature
    bucket.lastChangeSignature = this.pendingLastChangeSignature;
    this.pendingLastChangeSignature = null;
    this.nextMark = null;
    this.indexing = false;

    // There could be some processing happening on the queue still, so don't start until they're done
    bucket.processorQueue.async(() => {
      if (!this.authenticated) {
        return;
      }
      dispatchMain(() => {
        const delegate = bucket.delegate;
        if (delegate !== null && delegate.bucketDidFinishIndexing !== undefined) {
          delegate.bucketDidFinishIndexing(bucket);
        }
        this.startProcessingChangesForBucket(bucket);
      });
    });
  }

  // MARK: Sync Timeout

  private startSyncTimeoutTimer(): void {
    this.invalidateSyncTimeoutTimer();
    this.syncTimeoutTimer = setTimeout(() => {
      this.handleSyncTimeout();
    }, SP_WEBSOCKET_SYNC_TIMEOUT_INTERVAL_MS);
  }

  private invalidateSyncTimeoutTimer(): void {
    if (this.syncTimeoutTimer !== -1) {
      clearTimeout(this.syncTimeoutTimer);
      this.syncTimeoutTimer = -1;
    }
  }

  private handleSyncTimeout(): void {
    this.syncTimeoutTimer = -1;
    if (this.webSocketManager !== null) {
      this.webSocketManager.reopen();
    }
  }
}

// MARK: - SPWebSocketInterface

export class SPWebSocketInterface implements SPWebSocketDelegate {
  private simperium: SPSimperiumContext;
  private channels: Map<string, SPWebSocketChannel> = new Map<string, SPWebSocketChannel>();
  private webSocket: SPWebSocket | null = null;
  private heartbeatTimer: number = -1;
  private reopenTimer: number = -1;
  private open: boolean = false;

  constructor(simperium: SPSimperiumContext) {
    this.simperium = simperium;
  }

  channelForName(name: string): SPWebSocketChannel | undefined {
    return this.channels.get(name);
  }

  channelForNumber(num: number): SPWebSocketChannel | undefined {
    for (const channel of Array.from(this.channels.values())) {
      if (channel.number === num) {
        return channel;
      }
    }
    return undefined;
  }

  loadChannelForBucket(bucket: SPBucket): SPWebSocketChannel {
    const channel = new SPWebSocketChannel(this.simperium);
    channel.number = this.channels.size;
    channel.name = bucket.name;
    channel.remoteName = bucket.remoteName;
    this.channels.set(bucket.name, channel);
    return channel;
  }

  loadChannelsForBuckets(bucketList: Map<string, SPBucket>): void {
    bucketList.forEach((bucket: SPBucket) => {
      this.loadChannelForBucket(bucket);
    });
  }

  private startChannels(): void {
    this.channels.forEach((channel: SPWebSocketChannel) => {
      channel.webSocketManager = this;
      this.authenticateChannel(channel);
    });
  }

  private stopChannels(): void {
    this.channels.forEach((channel: SPWebSocketChannel) => {
      channel.stop();
    });
  }

  sendObjectDeletion(object: SPDiffableObject): void {
    const channel = object.bucket !== null ? this.channelForName(object.bucket.name) : undefined;
    if (channel !== undefined) {
      channel.sendObjectDeletion(object);
    }
  }

  sendObjectChanges(object: SPDiffableObject): void {
    const channel = object.bucket !== null ? this.channelForName(object.bucket.name) : undefined;
    if (channel !== undefined) {
      channel.sendObjectChanges(object);
    }
  }

  removeAllBucketObjects(bucket: SPBucket): void {
    const channel = this.channelForName(bucket.name);
    if (channel !== undefined) {
      channel.removeAllBucketObjects(bucket);
    }
  }

  sendLogMessage(logMessage: string): void {
    const payload: SPDict = { 'log': logMessage };
    this.send(`${COM_LOG}:${jsonString(payload)}`);
  }

  private authenticateChannel(channel: SPWebSocketChannel): void {
    const user = this.simperium.user;
    if (this.simperium.clientID.length === 0) {
      console.error('Simperium Error: Attempted channel auth with empty clientID');
      return;
    }
    if (this.simperium.appID === null) {
      console.error('Simperium Error: Attempted channel auth with empty appID');
      return;
    }
    if (user === null || user.authToken === null || user.authToken.length === 0) {
      console.error('Simperium Error: Attempted channel auth with empty authToken');
      return;
    }
    const jsonData: SPDict = {
      'api': parseFloat(SP_API_VERSION),
      'clientid': this.simperium.clientID,
      'app_id': this.simperium.appID,
      'username': user.email ?? '',
      'token': user.authToken,
      'name': channel.remoteName,
      'library': SP_LIBRARY_ID,
      'version': SP_LIBRARY_VERSION
    };
    this.send(`${channel.number}:init:${jsonString(jsonData)}`);
  }

  private openWebSocket(): void {
    // Prevent multiple 'openWebSocket' calls to get executed
    this.cancelReopen();
    const socket = new SPWebSocket(`${SP_WEBSOCKET_URL}/${this.simperium.appID ?? ''}/websocket`);
    this.webSocket = socket;
    socket.delegate = this;
    this.open = false;
    socket.open();
  }

  private scheduleReopen(): void {
    this.cancelReopen();
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = -1;
      this.openWebSocket();
    }, SP_WEBSOCKET_RETRY_DELAY_MS);
  }

  private cancelReopen(): void {
    if (this.reopenTimer !== -1) {
      clearTimeout(this.reopenTimer);
      this.reopenTimer = -1;
    }
  }

  start(bucket: SPBucket): void {
    let channel = this.channelForName(bucket.name);
    if (channel === undefined) {
      channel = this.loadChannelForBucket(bucket);
    }
    if (channel.authenticated) {
      return;
    }
    if (this.webSocket === null) {
      // Channels will get setup after successfully connection
      this.openWebSocket();
    } else if (this.open) {
      channel.webSocketManager = this;
      this.authenticateChannel(channel);
    }
  }

  stop(bucket: SPBucket): void {
    const channel = this.channelForName(bucket.name);
    if (channel !== undefined) {
      channel.stop();
    }
    // Mark it closed so it doesn't reopen
    this.open = false;
    if (this.webSocket !== null) {
      this.webSocket.delegate = null;
      this.webSocket.close();
      this.webSocket = null;
    }
    // Prevent any pending retries
    this.cancelReopen();
    this.cancelHeartbeat();
  }

  reset(bucket: SPBucket, completion: (() => void) | null): void {
    bucket.processorQueue.async(() => {
      bucket.changeProcessor.reset();
      bucket.lastChangeSignature = null;
      if (completion !== null) {
        completion();
      }
    });
  }

  send(message: string): void {
    if (!this.open || this.webSocket === null) {
      return;
    }
    this.webSocket.send(message);
    this.resetHeartbeatTimer();
  }

  reopen(): void {
    // WebSocket's didClose handler will take care of reopening the socket
    this.stopChannels();
    if (this.webSocket !== null) {
      this.webSocket.close();
    }
  }

  // MARK: Heartbeat

  private resetHeartbeatTimer(): void {
    this.cancelHeartbeat();
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = -1;
      this.sendHeartbeat();
    }, SP_WEBSOCKET_HEARTBEAT_INTERVAL_MS);
  }

  private cancelHeartbeat(): void {
    if (this.heartbeatTimer !== -1) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = -1;
    }
  }

  private sendHeartbeat(): void {
    if (this.webSocket === null || this.webSocket.readyState !== SPWebSocketReadyState.OPEN) {
      return;
    }
    // Send it (will also schedule another one)
    this.send('h:1');
  }

  private handleRemoteLogLevel(level: number): void {
    this.simperium.remoteLoggingEnabled = level !== SPRemoteLogging.OFF;
    this.simperium.verboseLoggingEnabled = level === SPRemoteLogging.VERBOSE;
  }

  // MARK: SPWebSocketDelegate

  webSocketDidOpen(socket: SPWebSocket): void {
    // Reconnection failsafe
    if (socket !== this.webSocket) {
      return;
    }
    this.open = true;
    this.startChannels();
    this.resetHeartbeatTimer();
  }

  webSocketDidFailWithError(socket: SPWebSocket, error: Error): void {
    if (socket !== this.webSocket) {
      return;
    }
    this.stopChannels();
    socket.delegate = null;
    this.webSocket = null;
    this.open = false;
    // Networking glitch with networking still enabled: retry. Otherwise the framework shut us down.
    if (this.simperium.networkEnabled) {
      console.info(`Simperium websocket failed (will retry) with error ${error.message}`);
      this.scheduleReopen();
    } else {
      console.info(`Simperium websocket failed (will NOT retry) with error ${error.message}`);
    }
  }

  webSocketDidReceiveMessage(socket: SPWebSocket, message: string): void {
    const components = componentsSeparatedByString(message, ':', 3);
    // Shortest messages have the form: [CHANNEL:COMMAND]
    if (components.length < 2) {
      console.error(`Simperium websocket received invalid message: ${message}`);
      return;
    }
    const channelStr = components[0];
    const command = components[1];
    const data = components.length > 2 ? components[2] : null;

    if (channelStr === COM_HEARTBEAT) {
      return;
    }
    if (channelStr === COM_LOG) {
      this.handleRemoteLogLevel(parseInt(command, 10));
      return;
    }

    const channel = this.channelForNumber(parseInt(channelStr, 10));
    if (channel === undefined) {
      return;
    }
    const bucket = this.simperium.bucketForName(channel.name);
    if (bucket === null) {
      return;
    }
    if (data === null) {
      console.warn(`Simperium received unrecognized websocket message: ${message}`);
    }
    const payload = data ?? '';

    if (command === COM_AUTH) {
      channel.handleAuthResponse(payload, bucket);
    } else if (command === COM_INDEX) {
      channel.handleIndexResponse(payload, bucket);
    } else if (command === COM_CHANGE_VERSION) {
      channel.requestLatestVersionsForBucket(bucket);
    } else if (command === COM_CHANGE) {
      const changes = objectFromJSONString(payload);
      const list: SPDict[] = [];
      if (Array.isArray(changes)) {
        for (const change of changes as Object[]) {
          if (isDict(change)) {
            list.push(change as SPDict);
          }
        }
      }
      channel.handleRemoteChanges(list, bucket);
    } else if (command === COM_ENTITY) {
      channel.handleVersionResponse(payload, bucket);
    } else if (command === COM_OPTIONS) {
      channel.handleOptions(payload, bucket);
    } else if (command === COM_INDEX_STATE) {
      channel.handleIndexStatusRequest(bucket);
    } else if (command === COM_ERROR) {
      console.info(`Simperium returned a command error (?) for bucket ${bucket.name}`);
    }
  }

  webSocketDidCloseWithCode(socket: SPWebSocket, code: number, reason: string, wasClean: boolean): void {
    if (socket !== this.webSocket) {
      return;
    }
    if (this.open) {
      // Closed unexpectedly, retry
      console.info(`Simperium connection closed (will retry): ${code}, ${reason}`);
      this.scheduleReopen();
    } else {
      console.info('Simperium connection closed');
    }
    this.stopChannels();
    socket.delegate = null;
    this.webSocket = null;
    this.open = false;
  }

  // MARK: Public Methods

  requestVersions(numVersions: number, object: SPDiffableObject): void {
    const channel = object.bucket !== null ? this.channelForName(object.bucket.name) : undefined;
    if (channel !== undefined) {
      channel.requestVersions(numVersions, object);
    }
  }

  shareObject(object: SPDiffableObject, email: string): void {
    const channel = object.bucket !== null ? this.channelForName(object.bucket.name) : undefined;
    if (channel !== undefined) {
      channel.shareObject(object, email);
    }
  }

  requestLatestVersionsForBucket(bucket: SPBucket): void {
    const channel = this.channelForName(bucket.name);
    if (channel !== undefined) {
      channel.requestLatestVersionsForBucket(bucket);
    }
  }

  forceSyncBucket(bucket: SPBucket): void {
    // Reuse the start mechanism: post the latest CV + publish pending changes
    const channel = this.channelForName(bucket.name);
    if (channel !== undefined) {
      channel.startProcessingChangesForBucket(bucket);
    }
  }

  // MARK: Status

  get status(): string {
    if (this.webSocket === null) {
      return 'Uninitialized';
    }
    switch (this.webSocket.readyState) {
      case SPWebSocketReadyState.CONNECTING:
        return 'Connecting';
      case SPWebSocketReadyState.OPEN:
        return 'Open';
      case SPWebSocketReadyState.CLOSING:
        return 'Closing';
      case SPWebSocketReadyState.CLOSED:
        return 'Closed';
      default:
        return 'Unknown';
    }
  }

  get lastSeenTime(): Date | null {
    return this.webSocket !== null ? this.webSocket.lastSeenTimestamp : null;
  }

  get bytesReceived(): number {
    return this.webSocket !== null ? this.webSocket.bytesReceived : 0;
  }

  get bytesSent(): number {
    return this.webSocket !== null ? this.webSocket.bytesSent : 0;
  }
}
