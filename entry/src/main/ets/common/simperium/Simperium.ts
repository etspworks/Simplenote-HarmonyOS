// Port of Simperium.h/.m (+Internals) — the entry point of the sync engine — together with the
// app-side Simperium+Simplenote.swift extension (bucket accessors, loadNote) and the Simperium
// half of SPCredentials.swift.
//
// Platform mapping:
//   SPCoreDataStorage over NSManagedObjectModel  -> SPStorage over ../Database CoreDataManager
//   SPReachability                                -> @kit.NetworkKit connection (netAvailable / netLost)
//   presenting SPAuthenticationViewController     -> `authenticationPresenter`, set by the app's
//                                                    session layer, which routes to its own login page
//   TrustKit certificate pinning                  -> flag kept; the system TLS stack validates the chain
import { connection } from '@kit.NetworkKit';
import { common } from '@kit.AbilityKit';
import { CoreDataManager, ManagedObjectModel, UserDefaults } from '../Database';
import { SPUser } from '../../model/SPUser';
import { NoteStoreBackend } from '../NoteStore';
import { Note } from '../../model/Note';
import { Tag } from '../../model/Tag';
import { Settings } from '../../model/Settings';
import { Preferences } from '../../model/Preferences';
import { SPAuthenticator, SPAuthenticatorDelegate, SPAuthenticatorSimperium } from './Authenticator';
import {
  SPBucket, SPBucketDelegate, SPDiffableObject, SPManagedObjectFactory, SPStorage,
  SPStorageObserver, dispatchMain
} from './Bucket';
import { SPMemberDefinition, SPSchema, makeUUID } from './JsonDiff';
import { SP_BASE_URL, SP_LIBRARY_ID, SPSimperiumContext, SPWebSocketInterface } from './WebSocketChannel';

const UUID_KEY: string = 'SPUUIDKey';
export const SIMPERIUM_WILL_SAVE_NOTIFICATION: string = 'SimperiumWillSaveNotification';
const SP_BACKGROUND_SYNC_TIMEOUT_MS: number = 20 * 1000;

export enum SPSimperiumErrors {
  MISSING_APP_ID = 0,
  MISSING_API_KEY = 1,
  MISSING_TOKEN = 2,
  MISSING_WINDOW = 3,
  INVALID_TOKEN = 4
}

export class SimperiumError extends Error {
  code: SPSimperiumErrors;

  constructor(code: SPSimperiumErrors) {
    super(`Simperium error ${code}`);
    this.code = code;
  }
}

/** SimperiumDelegate: every callback optional. */
export interface SimperiumDelegate {
  simperiumDidFailWithError?: (simperium: Simperium, error: SimperiumError) => void;
  simperiumDidLogin?: (simperium: Simperium) => void;
  simperiumDidLogout?: (simperium: Simperium) => void;
  simperiumDidCancelLogin?: (simperium: Simperium) => void;
  simperiumDidCreateAccount?: (simperium: Simperium) => void;
}

/** One synced entity of the model: its schema members and how to instantiate it. */
export class SPEntityDescription {
  name: string;
  members: SPMemberDefinition[];
  factory: SPManagedObjectFactory;

  constructor(name: string, members: SPMemberDefinition[], factory: SPManagedObjectFactory) {
    this.name = name;
    this.members = members;
    this.factory = factory;
  }
}

export type SimperiumSignoutCompletion = () => void;
export type SimperiumBackgroundFetchCompletion = (newData: boolean) => void;

export class Simperium implements SPSimperiumContext, SPStorageObserver, SPAuthenticatorDelegate,
  SPAuthenticatorSimperium {
  // Simperium+Simplenote constants
  static readonly ACCOUNT_BUCKET_NAME: string = 'Account';
  static readonly PREFERENCES_LAST_CHANGED_SIGNATURE_KEY: string = 'lastChangeSignature-Preferences';

  /** The app's one Simperium instance (SPAppDelegate.simperium), set by buildSimplenoteSimperium. */
  static shared: Simperium | null = null;

  delegate: SimperiumDelegate | null = null;
  authenticationOptional: boolean = false;
  authenticationShouldBeEmbeddedInNavigationController: boolean = false;
  certificatePinningEnabled: boolean = false;
  remoteLoggingEnabled: boolean = false;
  presentsLoginByDefault: boolean = false;
  validatesObjects: boolean = true;
  authenticationEnabled: boolean = true;
  dynamicSchemaEnabled: boolean = true;
  /** Opens the login UI (openAuthViewControllerAnimated:). Set by the app's session layer. */
  authenticationPresenter: ((simperium: Simperium) => void) | null = null;
  /** Closes the login UI (closeAuthViewControllerAnimated:). */
  authenticationDismisser: ((simperium: Simperium) => void) | null = null;

  user: SPUser | null = null;
  appID: string | null = null;
  APIKey: string | null = null;
  appURL: string = '';
  readonly label: string;
  readonly bucketOverrides: Map<string, string> | null;
  authenticator: SPAuthenticator;
  buckets: Map<string, SPBucket> = new Map<string, SPBucket>();
  network: SPWebSocketInterface;
  coreDataStorage: SPStorage;
  private JSONStorageValue: SPStorage | null = null;
  private clientIDValue: string = '';
  private rootURLValue: string = '';
  private networkEnabledValue: boolean = true;
  private verboseLoggingEnabledValue: boolean = false;
  private networkManagersStarted: boolean = false;
  private logoutInProgress: boolean = false;
  private skipContextProcessing: boolean = false;
  private netConnection: connection.NetConnection | null = null;
  private authOpenTimer: number = -1;

  /** -initWithModel:context:coordinator:label:bucketOverrides: (call loadPersistedObjects() next). */
  constructor(manager: CoreDataManager, entities: SPEntityDescription[], label: string = '',
    bucketOverrides: Map<string, string> | null = null) {
    this.label = label;
    // Set the clientID as well, otherwise certain change operations won't work
    this.clientIDValue = label;
    this.bucketOverrides = bucketOverrides;
    this.network = new SPWebSocketInterface(this);
    this.authenticator = new SPAuthenticator(this, this);
    this.setupNotifications();

    // Initialize the storage, then load the buckets but don't start them yet
    const storage = SPStorage.coreDataStorage(manager);
    storage.delegate = this;
    this.coreDataStorage = storage;
    for (const entity of entities) {
      storage.registerEntity(entity.name, entity.factory);
    }
    this.buckets = this.loadBuckets(entities);
    // SPManagedObjects need the bucket list
    storage.bucketList = this.buckets;
  }

  /** Materialises every persisted entity; await before reading any bucket. */
  async loadPersistedObjects(): Promise<void> {
    await this.coreDataStorage.loadPersistedObjects();
  }

  // MARK: Init Helpers

  private setupNotifications(): void {
    // SPReachability: start / stop the network managers as connectivity comes and goes
    try {
      const netConnection = connection.createNetConnection();
      netConnection.on('netAvailable', () => {
        this.handleNetworkChange(true);
      });
      netConnection.on('netLost', () => {
        this.handleNetworkChange(false);
      });
      netConnection.register(() => {
        console.info('Simperium reachability observer registered');
      });
      this.netConnection = netConnection;
    } catch (e) {
      console.error(`Simperium couldn't observe reachability: ${(e as Error).message}`);
    }
  }

  // MARK: Bucket Helpers

  bucketForName(name: string): SPBucket | null {
    const bucket = this.buckets.get(name);
    if (bucket !== undefined) {
      return bucket;
    }
    // First check for an override
    for (const someBucket of Array.from(this.buckets.values())) {
      if (someBucket.remoteName === name) {
        return someBucket;
      }
    }
    if (!this.dynamicSchemaEnabled) {
      return null;
    }
    // Lazily start dynamic buckets (JSON storage, like the Account bucket)
    const schema = new SPSchema(name, null);
    schema.dynamic = true;
    const remoteName = this.bucketOverrides?.get(schema.bucketName) ?? schema.bucketName;
    const newBucket = new SPBucket(schema, this.JSONStorage, this.network, this.label, remoteName, this.clientID);
    this.JSONStorage.bucketList.set(name, newBucket);
    this.buckets.set(name, newBucket);
    if (this.networkManagersStarted) {
      this.network.start(newBucket);
    }
    return newBucket;
  }

  // MARK: Networking

  startNetworkManagers(): void {
    if (!this.networkEnabledValue || this.networkManagersStarted || this.appID === null) {
      return;
    }
    if (this.logoutInProgress) {
      console.error('Simperium Error: there is a pending logout operation that hasn\'t been fulfilled');
    }
    this.buckets.forEach((bucket: SPBucket) => {
      bucket.network.start(bucket);
    });
    this.networkManagersStarted = true;
  }

  stopNetworkManagers(): void {
    if (!this.networkManagersStarted) {
      return;
    }
    this.buckets.forEach((bucket: SPBucket) => {
      bucket.network.stop(bucket);
    });
    this.networkManagersStarted = false;
  }

  private handleNetworkChange(reachable: boolean): void {
    if (!reachable) {
      this.stopNetworkManagers();
    } else if (this.user !== null && this.user.authenticated()) {
      this.startNetworkManagers();
    }
  }

  get networkEnabled(): boolean {
    return this.networkEnabledValue;
  }

  set networkEnabled(enabled: boolean) {
    if (this.networkEnabledValue === enabled) {
      return;
    }
    this.networkEnabledValue = enabled;
    if (enabled && this.authenticationEnabled) {
      this.authenticateIfNecessary();
    } else if (enabled && this.user !== null && this.user.authenticated()) {
      this.startNetworkManagers();
    } else {
      this.stopNetworkManagers();
    }
  }

  get delaysNewObjectsInitialization(): boolean {
    return this.coreDataStorage.delaysNewObjectsInitialization;
  }

  set delaysNewObjectsInitialization(delays: boolean) {
    this.coreDataStorage.delaysNewObjectsInitialization = delays;
  }

  // MARK: Buckets

  private loadBuckets(entities: SPEntityDescription[]): Map<string, SPBucket> {
    const bucketList = new Map<string, SPBucket>();
    for (const entity of entities) {
      const schema = new SPSchema(entity.name, entity.members);
      const remoteName = this.bucketOverrides?.get(schema.bucketName) ?? schema.bucketName;
      const bucket = new SPBucket(schema, this.coreDataStorage, this.network, this.label, remoteName, this.clientID);
      bucketList.set(schema.bucketName, bucket);
    }
    this.network.loadChannelsForBuckets(bucketList);
    return bucketList;
  }

  private validateObjectsIfNecessary(): void {
    if (!this.validatesObjects) {
      return;
    }
    // Check all existing objects (e.g. in case there are existing ones that aren't in Simperium yet)
    this.buckets.forEach((bucket: SPBucket) => {
      bucket.validateObjects();
    });
  }

  setAllBucketDelegates(delegate: SPBucketDelegate | null): void {
    this.buckets.forEach((bucket: SPBucket) => {
      bucket.delegate = delegate;
    });
  }

  setAllBucketPropertyMismatchFailsafeEnabled(isEnabled: boolean): void {
    this.buckets.forEach((bucket: SPBucket) => {
      bucket.propertyMismatchFailsafeEnabled = isEnabled;
    });
  }

  shareObject(object: SPDiffableObject, email: string): void {
    if (object.bucket !== null) {
      object.bucket.network.shareObject(object, email);
    }
  }

  // MARK: Authentication Methods

  /** -authenticateWithAppID:APIKey:rootViewController: (the login UI is `authenticationPresenter`). */
  authenticateWithAppID(identifier: string | null, key: string | null): void {
    if (identifier === null || identifier.length === 0) {
      this.failWithErrorCode(SPSimperiumErrors.MISSING_APP_ID);
      return;
    }
    if (key === null || key.length === 0) {
      this.failWithErrorCode(SPSimperiumErrors.MISSING_API_KEY);
      return;
    }
    this.startWithAppID(identifier, key);
  }

  authenticateWithAppIDAndToken(identifier: string | null, token: string | null): void {
    if (identifier === null || identifier.length === 0) {
      this.failWithErrorCode(SPSimperiumErrors.MISSING_APP_ID);
      return;
    }
    if (token === null || token.length === 0) {
      this.failWithErrorCode(SPSimperiumErrors.MISSING_TOKEN);
      return;
    }
    // Start Simperium: Disable Authentication!
    this.authenticationEnabled = false;
    this.startWithAppID(identifier, null);
    // Manually initialize the user
    this.user = new SPUser('', token);
    this.startNetworkManagers();
  }

  private startWithAppID(identifier: string, key: string | null): void {
    console.info(`Simperium starting... ${this.label}`);
    this.appID = identifier;
    this.APIKey = key;
    this.rootURL = SP_BASE_URL;
    // With everything configured, all objects can now be validated
    this.validateObjectsIfNecessary();
    this.authenticateIfNecessary();
  }

  // MARK: SPStorageObserver

  storageWillSave(storage: SPStorage, deletedObjects: Set<SPDiffableObject>): void {
    if (!this.objectsShouldSync) {
      return;
    }
    // Process deletions before the Save OP is complete
    deletedObjects.forEach((deletedObject: SPDiffableObject) => {
      if (deletedObject.bucket !== null) {
        deletedObject.bucket.network.sendObjectDeletion(deletedObject);
        deletedObject.bucket.storage.stopManagingObjectWithKey(deletedObject.simperiumKey);
      }
    });
  }

  storageDidSave(storage: SPStorage, insertedObjects: Set<SPDiffableObject>, updatedObjects: Set<SPDiffableObject>): void {
    if (!this.objectsShouldSync) {
      return;
    }
    // Unstash since they're about to be sent
    const stashedObjects = storage.stashedObjects;
    storage.unstashUnsavedObjects();
    const send = (object: SPDiffableObject): void => {
      if (object.bucket !== null) {
        object.bucket.network.sendObjectChanges(object);
      }
    };
    stashedObjects.forEach(send);
    insertedObjects.forEach(send);
    updatedObjects.forEach(send);
  }

  // MARK: Save

  /** -save: persists local edits and pushes them over the wire. */
  async save(): Promise<boolean> {
    await this.JSONStorage.save();
    await this.coreDataStorage.save();
    return true;
  }

  async saveWithoutSyncing(): Promise<boolean> {
    this.skipContextProcessing = true;
    const result = await this.save();
    // Make sure that any pending async op is drained
    await this.coreDataStorage.commitPendingOperations();
    await this.JSONStorage.commitPendingOperations();
    this.skipContextProcessing = false;
    return result;
  }

  backgroundFetchWithCompletion(completion: SimperiumBackgroundFetchCompletion): void {
    let result = false;
    let notified = false;
    const buckets = Array.from(this.buckets.values());
    let remaining = buckets.length;
    const finish = (): void => {
      if (!notified) {
        notified = true;
        completion(result);
      }
    };
    for (const bucket of buckets) {
      bucket.forceSyncWithCompletion((signatureUpdated: boolean) => {
        if (signatureUpdated) {
          result = true;
        }
        remaining--;
        if (remaining === 0) {
          finish();
        }
      });
    }
    if (buckets.length === 0) {
      finish();
    }
    // Safety net: never leave the caller hanging on a slow network
    setTimeout(finish, SP_BACKGROUND_SYNC_TIMEOUT_MS);
  }

  // MARK: Signout Helpers

  signOutAndRemoveLocalData(remove: boolean, completion: SimperiumSignoutCompletion | null): void {
    if (this.logoutInProgress) {
      console.error('Error: Simperium is already logging out');
      return;
    }
    console.info('Simperium logging out...');

    // Reset Simperium: Don't start network managers again; expect app to handle that
    this.stopNetworkManagers();

    // Clear the token and user
    this.authenticator.reset();
    this.user = null;

    // Reset the network manager and processors; any enqueued tasks will get skipped
    this.logoutInProgress = true;

    const resets: Promise<void>[] = [];
    this.buckets.forEach((bucket: SPBucket) => {
      bucket.unloadAllObjects();
      resets.push(new Promise<void>((resolve: () => void) => {
        bucket.network.reset(bucket, resolve);
      }));
    });

    Promise.all(resets).then(() => {
      this.finishSignout(remove, completion);
    });
  }

  private finishSignout(remove: boolean, completion: SimperiumSignoutCompletion | null): void {
    // Now delete all local content; no more changes will be coming in at this point
    if (remove) {
      console.info('Simperium removing all entities...');
      this.skipContextProcessing = true;
      this.buckets.forEach((bucket: SPBucket) => {
        bucket.deleteAllObjects();
      });
    }
    const saving: Promise<void> = remove ? this.coreDataStorage.save().then(() => this.JSONStorage.save()) :
      Promise.resolve();
    saving.then(() => this.coreDataStorage.commitPendingOperations()).then(() => {
      dispatchMain(() => {
        const d = this.delegate;
        if (d !== null && d.simperiumDidLogout !== undefined) {
          d.simperiumDidLogout(this);
        }
        if (completion !== null) {
          completion();
        }
        this.logoutInProgress = false;
        this.skipContextProcessing = false;
      });
    });
  }

  resetMetadata(): void {
    if (this.user !== null && this.user.authenticated()) {
      console.error('Simperium error: cannot reset metadata with the user already logged in.');
      return;
    }
    console.info('Simperium nuking Sync\'ing Metadata...');
    this.buckets.forEach((bucket: SPBucket) => {
      bucket.unloadAllObjects();
      bucket.network.reset(bucket, null);
    });
  }

  // MARK: Properties

  get JSONStorage(): SPStorage {
    if (this.JSONStorageValue === null) {
      const storage = SPStorage.jsonStorage();
      storage.delegate = this;
      this.JSONStorageValue = storage;
    }
    return this.JSONStorageValue;
  }

  get clientID(): string {
    if (this.clientIDValue.length === 0) {
      // Unique client ID; persist it so changes sent between sessions come from the same client ID
      let uuid = UserDefaults.standard.string(UUID_KEY);
      if (uuid === null) {
        uuid = makeUUID();
        UserDefaults.standard.set(UUID_KEY, uuid);
      }
      this.clientIDValue = `${SP_LIBRARY_ID}-${uuid}`;
    }
    return this.clientIDValue;
  }

  get rootURL(): string {
    return this.rootURLValue;
  }

  set rootURL(url: string) {
    this.rootURLValue = url;
    this.appURL = `${url}${this.appID ?? ''}/`;
  }

  get verboseLoggingEnabled(): boolean {
    return this.verboseLoggingEnabledValue;
  }

  set verboseLoggingEnabled(on: boolean) {
    this.verboseLoggingEnabledValue = on;
  }

  get objectsShouldSync(): boolean {
    return !this.skipContextProcessing;
  }

  get requiresConnection(): boolean {
    try {
      return !connection.hasDefaultNetSync();
    } catch (e) {
      return false;
    }
  }

  get networkStatus(): string {
    return this.network.status;
  }

  get networkLastSeenTime(): Date | null {
    return this.network.lastSeenTime;
  }

  get bytesSent(): number {
    return this.network.bytesSent;
  }

  get bytesReceived(): number {
    return this.network.bytesReceived;
  }

  // MARK: Authentication Helpers (SPAuthenticatorDelegate)

  authenticationDidSucceedForUsername = (username: string, token: string): void => {
    // It's now safe to start the network managers
    this.startNetworkManagers();
    this.closeAuthViewController();
    const d = this.delegate;
    if (d !== null && d.simperiumDidLogin !== undefined) {
      d.simperiumDidLogin(this);
    }
  };

  authenticationDidCreateAccount = (): void => {
    const d = this.delegate;
    if (d !== null && d.simperiumDidCreateAccount !== undefined) {
      d.simperiumDidCreateAccount(this);
    }
  };

  authenticationDidCancel = (): void => {
    this.stopNetworkManagers();
    this.authenticator.reset();
    if (this.user !== null) {
      this.user.authToken = null;
    }
    this.closeAuthViewController();
    const d = this.delegate;
    if (d !== null && d.simperiumDidCancelLogin !== undefined) {
      d.simperiumDidCancelLogin(this);
    }
  };

  /** Also the SPAuthenticationDidFail notification posted by the websocket channels. */
  authenticationDidFail = (): void => {
    // Only nuke the token from memory (not the keychain), so a glitch may recover upon relaunch
    this.stopNetworkManagers();
    if (this.user !== null) {
      this.user.authToken = null;
    }
    this.failWithErrorCode(SPSimperiumErrors.INVALID_TOKEN);
    if (!this.authenticationEnabled) {
      return;
    }
    this.scheduleOpenAuthViewController();
  };

  /** Returns true when the login UI is needed. */
  authenticateIfNecessary(): boolean {
    if (!this.networkEnabledValue || !this.authenticationEnabled || this.appID === null) {
      return false;
    }
    this.stopNetworkManagers();
    return this.authenticator.authenticateIfNecessary();
  }

  private scheduleOpenAuthViewController(): void {
    this.unscheduleOpenAuthViewController();
    // Delay it a touch, like the source, so a page transition in flight can finish
    this.authOpenTimer = setTimeout(() => {
      this.authOpenTimer = -1;
      this.openAuthViewController();
    }, 100);
  }

  private unscheduleOpenAuthViewController(): void {
    if (this.authOpenTimer !== -1) {
      clearTimeout(this.authOpenTimer);
      this.authOpenTimer = -1;
    }
  }

  private openAuthViewController(): void {
    if (this.authenticationPresenter !== null) {
      this.authenticationPresenter(this);
    } else {
      console.error('Simperium error: no authenticationPresenter configured to open the login UI');
    }
  }

  private closeAuthViewController(): void {
    if (this.authenticationDismisser !== null) {
      this.authenticationDismisser(this);
    }
    this.unscheduleOpenAuthViewController();
  }

  // MARK: Remote logging

  handleLogMessage(logMessage: string): void {
    if (!this.remoteLoggingEnabled) {
      return;
    }
    dispatchMain(() => {
      this.network.sendLogMessage(logMessage);
    });
  }

  // MARK: Private Methods

  /** Integration-test helper: deletes the remote data of every bucket. */
  removeRemoteData(): void {
    this.buckets.forEach((bucket: SPBucket) => {
      bucket.network.removeAllBucketObjects(bucket);
    });
  }

  private failWithErrorCode(code: SPSimperiumErrors): void {
    const d = this.delegate;
    if (d === null || d.simperiumDidFailWithError === undefined) {
      return;
    }
    d.simperiumDidFailWithError(this, new SimperiumError(code));
  }

  // MARK: - Simperium + Simplenote (Simperium+Simplenote.swift)

  get allBuckets(): SPBucket[] {
    return [this.accountBucket, this.notesBucket, this.preferencesBucket, this.settingsBucket, this.tagsBucket];
  }

  /** Dynamic (in-memory JSON storage) bucket: there is no Account class. */
  get accountBucket(): SPBucket {
    return this.bucketForName(Simperium.ACCOUNT_BUCKET_NAME) as SPBucket;
  }

  get notesBucket(): SPBucket {
    return this.bucketForName(ManagedObjectModel.ENTITY_NOTE) as SPBucket;
  }

  get preferencesBucket(): SPBucket {
    return this.bucketForName(ManagedObjectModel.ENTITY_PREFERENCES) as SPBucket;
  }

  get settingsBucket(): SPBucket {
    return this.bucketForName(ManagedObjectModel.ENTITY_SETTINGS) as SPBucket;
  }

  get tagsBucket(): SPBucket {
    return this.bucketForName(ManagedObjectModel.ENTITY_TAG) as SPBucket;
  }

  /** Returns the Note with the specified SimperiumKey */
  loadNote(simperiumKey: string): Note | null {
    const object = this.notesBucket.objectForKey(simperiumKey);
    return object instanceof Note ? object as Note : null;
  }
}

/**
 * The Core Data / bucket access SPObjectManager performs through SPAppDelegate.simperium:
 * fetch, insert and delete Notes and Tags, then save (persist + enqueue the sync changes).
 * Structurally matches NoteStore's NoteStoreBackend, so the session layer can attach it as is.
 */
export class SimperiumNoteStoreBackend implements NoteStoreBackend {
  private simperium: Simperium;

  constructor(simperium: Simperium) {
    this.simperium = simperium;
  }

  fetchNotes(): Note[] {
    const notes: Note[] = [];
    for (const object of this.simperium.notesBucket.allObjects()) {
      if (object instanceof Note) {
        notes.push(object as Note);
      }
    }
    return notes;
  }

  fetchTags(): Tag[] {
    const tags: Tag[] = [];
    for (const object of this.simperium.tagsBucket.allObjects()) {
      if (object instanceof Tag) {
        tags.push(object as Tag);
      }
    }
    return tags;
  }

  insertNote(): Note {
    return this.simperium.notesBucket.insertNewObject() as Note;
  }

  insertTag(simperiumKey: string): Tag {
    return this.simperium.tagsBucket.insertNewObjectForKey(simperiumKey) as Tag;
  }

  deleteNote(note: Note): void {
    this.simperium.notesBucket.deleteObject(note);
  }

  deleteTag(tag: Tag): void {
    this.simperium.tagsBucket.deleteObject(tag);
  }

  async save(): Promise<void> {
    await this.simperium.save();
  }
}

/** The Simperium half of SPCredentials.swift (demo values, as shipped in the source). */
export class SPCredentials {
  static readonly SIMPERIUM_APP_ID: string = 'history-analyst-dad';
  static readonly SIMPERIUM_API_KEY: string = '6805ca9a091e45ada8a9d8988367f14e';
  static readonly SIMPERIUM_EMAIL_VERIFICATION_OBJECT_KEY: string = 'not-required';
  static readonly SIMPERIUM_PREFERENCES_OBJECT_KEY: string = 'not-required';
  static readonly SIMPERIUM_SETTINGS_OBJECT_KEY: string = 'not-required';
  static readonly DEFAULT_ENGINE_URL: string = 'https://app.simplenote.com';
}

/** The synced entities of Simplenote.xcdatamodeld, as SPCoreDataExporter would export them. */
export function simplenoteEntityDescriptions(): SPEntityDescription[] {
  return [
    new SPEntityDescription(ManagedObjectModel.ENTITY_NOTE, Note.SCHEMA_MEMBERS, () => new Note()),
    new SPEntityDescription(ManagedObjectModel.ENTITY_TAG, Tag.SCHEMA_MEMBERS, () => new Tag()),
    new SPEntityDescription(ManagedObjectModel.ENTITY_SETTINGS, Settings.SCHEMA_MEMBERS, () => new Settings()),
    new SPEntityDescription(ManagedObjectModel.ENTITY_PREFERENCES, Preferences.SCHEMA_MEMBERS, () => new Preferences())
  ];
}

/**
 * Builds the app's Simperium stack (SPAppDelegate -setupSimperium): opens the Core Data store,
 * creates Simperium over it, loads every persisted entity and publishes it as Simperium.shared.
 * The caller then sets delegates / presenters and calls authenticateWithAppID(...).
 */
export async function buildSimplenoteSimperium(context: common.Context): Promise<Simperium> {
  if (Simperium.shared !== null) {
    return Simperium.shared;
  }
  const manager = await CoreDataManager.create(context);
  const simperium = new Simperium(manager, simplenoteEntityDescriptions());
  await simperium.loadPersistedObjects();
  Simperium.shared = simperium;
  return simperium;
}

