// Port of CoreDataManager.swift: the local persistence stack, over @kit.ArkData relationalStore.
//
// Core Data concept      -> HarmonyOS
//   NSManagedObjectModel        -> ManagedObjectModel (the entity tables of Simplenote 7.xcdatamodel)
//   NSPersistentStoreCoordinator -> relationalStore.RdbStore (one SQLite store)
//   NSManagedObjectContext      -> ManagedObjectContext (row reads / writes on the store, serialised)
//
// Every Simperium entity (Note, Tag, Settings, Preferences) is one table keyed by simperiumKey,
// holding the entity's member data as JSON plus its ghostData — exactly the two attributes
// SPManagedObject adds to every synced entity.
//
// This module also hosts UserDefaults: the NSUserDefaults.standard equivalent (@kit.ArkData
// preferences) that Options, the ratings helper and the Simperium port all read and write.
import { application, common } from '@kit.AbilityKit';
import { preferences, relationalStore } from '@kit.ArkData';

export enum CoreDataUsageType {
  STANDARD = 0,
  INTENTS = 1,
  WIDGETS = 2
}

/** StorageSettings: where the model and store live. */
export class StorageSettings {
  storeName: string = 'Simplenote.sqlite';
  modelVersion: number = 7;
}

/** The entity list of Simplenote.xcdatamodeld (current version: Simplenote 7). */
export class ManagedObjectModel {
  static readonly ENTITY_NOTE: string = 'Note';
  static readonly ENTITY_TAG: string = 'Tag';
  static readonly ENTITY_SETTINGS: string = 'Settings';
  static readonly ENTITY_PREFERENCES: string = 'Preferences';

  version: number;
  entities: string[] = [
    ManagedObjectModel.ENTITY_NOTE,
    ManagedObjectModel.ENTITY_TAG,
    ManagedObjectModel.ENTITY_SETTINGS,
    ManagedObjectModel.ENTITY_PREFERENCES
  ];

  constructor(version: number) {
    this.version = version;
  }

  createStatements(): string[] {
    const statements: string[] = [];
    for (const entity of this.entities) {
      statements.push(`CREATE TABLE IF NOT EXISTS ${entity} (` +
        'simperiumKey TEXT PRIMARY KEY NOT NULL, ghostData TEXT, data TEXT NOT NULL)');
    }
    return statements;
  }
}

/** One persisted entity row. */
export class StoredEntityRow {
  simperiumKey: string;
  ghostData: string | null;
  data: string;

  constructor(simperiumKey: string, ghostData: string | null, data: string) {
    this.simperiumKey = simperiumKey;
    this.ghostData = ghostData;
    this.data = data;
  }
}

export class CoreDataManagerError extends Error {
  static readonly ERROR_DOMAIN: string = 'CoreDataManager';
  code: number = 0;

  constructor(message: string) {
    super(`${CoreDataManagerError.ERROR_DOMAIN}: ${message}`);
  }
}

/** NSManagedObjectContext equivalent: serialised reads / writes against the attached store. */
export class ManagedObjectContext {
  persistentStoreCoordinator: relationalStore.RdbStore | null = null;
  // Kept for parity with `moc.undoManager = nil`: the main context never records undo.
  undoManager: null = null;
  private queue: Promise<void> = Promise.resolve();

  private store(): relationalStore.RdbStore {
    if (this.persistentStoreCoordinator === null) {
      throw new CoreDataManagerError('the context has no persistent store attached');
    }
    return this.persistentStoreCoordinator;
  }

  /** Runs `work` after every previously enqueued write finished (a serial queue). A failed write is
   * logged and never blocks the writes queued behind it. */
  perform(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work, work).catch((e: Error) => {
      console.error(`CoreDataManager write failed: ${e.message}`);
    });
    this.queue = next;
    return next;
  }

  async fetchAll(entity: string): Promise<StoredEntityRow[]> {
    await this.queue;
    const rows: StoredEntityRow[] = [];
    let resultSet: relationalStore.ResultSet | undefined = undefined;
    try {
      resultSet = await this.store().querySql(`SELECT simperiumKey, ghostData, data FROM ${entity}`);
      const keyIndex = resultSet.getColumnIndex('simperiumKey');
      const ghostIndex = resultSet.getColumnIndex('ghostData');
      const dataIndex = resultSet.getColumnIndex('data');
      while (resultSet.goToNextRow()) {
        const ghost = resultSet.isColumnNull(ghostIndex) ? null : resultSet.getString(ghostIndex);
        rows.push(new StoredEntityRow(resultSet.getString(keyIndex), ghost, resultSet.getString(dataIndex)));
      }
    } finally {
      if (resultSet !== undefined) {
        resultSet.close();
      }
    }
    return rows;
  }

  upsert(entity: string, row: StoredEntityRow): Promise<void> {
    return this.perform(async () => {
      const values: relationalStore.ValuesBucket = {
        'simperiumKey': row.simperiumKey,
        'ghostData': row.ghostData,
        'data': row.data
      };
      await this.store().insert(entity, values, relationalStore.ConflictResolution.ON_CONFLICT_REPLACE);
    });
  }

  delete(entity: string, simperiumKey: string): Promise<void> {
    return this.perform(async () => {
      const predicates = new relationalStore.RdbPredicates(entity);
      predicates.equalTo('simperiumKey', simperiumKey);
      await this.store().delete(predicates);
    });
  }

  deleteAll(entity: string): Promise<void> {
    return this.perform(async () => {
      await this.store().executeSql(`DELETE FROM ${entity}`);
    });
  }

  /** Resolves once every enqueued write has been committed. */
  async commitPendingOperations(): Promise<void> {
    await this.queue;
  }
}

export class CoreDataManager {
  managedObjectModel: ManagedObjectModel | null = null;
  managedObjectContext: ManagedObjectContext | null = null;
  persistentStoreCoordinator: relationalStore.RdbStore | null = null;

  /** `init(_ storageURL:storageSettings:for:) throws` — async, since opening the store is. */
  static async create(context: common.Context, storageSettings: StorageSettings = new StorageSettings(),
    usageType: CoreDataUsageType = CoreDataUsageType.STANDARD): Promise<CoreDataManager> {
    const manager = new CoreDataManager();
    manager.managedObjectModel = new ManagedObjectModel(storageSettings.modelVersion);
    manager.managedObjectContext = manager.buildMainContext();
    manager.persistentStoreCoordinator =
      await manager.buildStoreCoordinator(context, manager.managedObjectModel, storageSettings.storeName);
    manager.setupStackIfNeeded(manager.managedObjectContext, manager.persistentStoreCoordinator, usageType);
    return manager;
  }

  private buildMainContext(): ManagedObjectContext {
    const moc = new ManagedObjectContext();
    moc.undoManager = null;
    return moc;
  }

  private async buildStoreCoordinator(context: common.Context, model: ManagedObjectModel,
    storageName: string): Promise<relationalStore.RdbStore> {
    console.info(`Loading PersistentStore named: ${storageName}`);
    try {
      const config: relationalStore.StoreConfig = {
        name: storageName,
        securityLevel: relationalStore.SecurityLevel.S1
      };
      const psc = await relationalStore.getRdbStore(context, config);
      // NSMigratePersistentStoresAutomaticallyOption + NSInferMappingModelAutomaticallyOption:
      // tables are created idempotently and the model version is recorded on the store.
      for (const statement of model.createStatements()) {
        await psc.executeSql(statement);
      }
      if (psc.version < model.version) {
        psc.version = model.version;
      }
      return psc;
    } catch (e) {
      throw new CoreDataManagerError(`could not open the persistent store (${(e as Error).message})`);
    }
  }

  private setupStackIfNeeded(mainContext: ManagedObjectContext, psc: relationalStore.RdbStore,
    usageType: CoreDataUsageType): void {
    switch (usageType) {
      case CoreDataUsageType.STANDARD:
        // Simperium's storage attaches the coordinator to the main context itself.
        break;
      case CoreDataUsageType.INTENTS:
      case CoreDataUsageType.WIDGETS:
        mainContext.persistentStoreCoordinator = psc;
        break;
    }
  }
}

/**
 * NSUserDefaults.standard over @kit.ArkData preferences (file "SimplenoteDefaults", shared with
 * OptionsStore). Synchronous like its source: every write
 * is flushed to disk in the background.
 */
export class UserDefaults {
  private static instance: UserDefaults | null = null;
  private store: preferences.Preferences;

  private constructor(store: preferences.Preferences) {
    this.store = store;
  }

  static get standard(): UserDefaults {
    if (UserDefaults.instance === null) {
      const context: common.Context = application.getApplicationContext();
      const options: preferences.Options = { name: 'SimplenoteDefaults' };
      UserDefaults.instance = new UserDefaults(preferences.getPreferencesSync(context, options));
    }
    return UserDefaults.instance;
  }

  containsObject(key: string): boolean {
    return this.store.hasSync(key);
  }

  bool(key: string): boolean {
    const value = this.store.getSync(key, false);
    if (typeof value === 'number') {
      return (value as number) !== 0;
    }
    return value === true;
  }

  integer(key: string): number {
    const value = this.store.getSync(key, 0);
    if (typeof value === 'boolean') {
      return (value as boolean) ? 1 : 0;
    }
    if (typeof value === 'string') {
      const parsed = parseInt(value as string, 10);
      return isNaN(parsed) ? 0 : parsed;
    }
    return typeof value === 'number' ? Math.trunc(value as number) : 0;
  }

  string(key: string): string | null {
    if (!this.store.hasSync(key)) {
      return null;
    }
    const value = this.store.getSync(key, '');
    return typeof value === 'string' ? value as string : String(value);
  }

  number(key: string): number | null {
    if (!this.store.hasSync(key)) {
      return null;
    }
    const value = this.store.getSync(key, 0);
    return typeof value === 'number' ? value as number : null;
  }

  set(key: string, value: string | number | boolean | null): void {
    if (value === null) {
      this.removeObject(key);
      return;
    }
    this.store.putSync(key, value);
    this.synchronize();
  }

  removeObject(key: string): void {
    if (this.store.hasSync(key)) {
      this.store.deleteSync(key);
      this.synchronize();
    }
  }

  synchronize(): void {
    this.store.flush().catch((e: Error) => {
      console.error(`UserDefaults flush failed: ${e.message}`);
    });
  }
}
