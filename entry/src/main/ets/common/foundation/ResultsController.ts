// Port of SimplenoteFoundation-Swift: ResultsController/*.swift (ResultsController,
// ResultsObjectsChangeset, ResultsSectionsChangeset, IndexPath+ResultsController and the internal
// FetchedResultsControllerDelegateWrapper).
//
// relationalStore has no NSFetchedResultsController, so FetchedResultsController below is its
// port: it fetches through the storage layer's `fetchObjects`, applies predicate / sort / limit /
// sectioning in memory, and on every ManagedObjectContext ObjectsDidChange re-fetches and diffs
// the result against the previous one, emitting the same will-change / did-change-object /
// did-change-section / did-change callbacks the Core Data delegate did.
// ponytail: whole-result refetch + O(n) diff per change; fine for note-sized lists, move to
// incremental SQL deltas if a store ever holds tens of thousands of rows.
import {
  ManagedObjectContext,
  ObjectsDidChangeNotification,
  NS_UPDATED_OBJECTS_KEY,
  NS_REFRESHED_OBJECTS_KEY
} from './EntityObserver';

// MARK: - IndexPath

export class IndexPath {
  section: number;
  row: number;

  constructor(row: number, section: number) {
    this.row = row;
    this.section = section;
  }

  transpose(newSection: number): IndexPath {
    return new IndexPath(this.row, newSection);
  }

  equals(other: IndexPath | null): boolean {
    return other !== null && other.row === this.row && other.section === this.section;
  }
}

// MARK: - Fetch request pieces (NSPredicate / NSSortDescriptor / NSFetchRequest analogues)

export type ResultsPredicate<T> = (object: T) => boolean;
export type ResultsComparator<T> = (lhs: T, rhs: T) => number;

export class SortDescriptor<T> {
  compare: ResultsComparator<T>;
  ascending: boolean;

  constructor(compare: ResultsComparator<T>, ascending: boolean = true) {
    this.compare = compare;
    this.ascending = ascending;
  }
}

/// Loads every object of `entityName` from the store (the fetch request narrows them).
export type ResultsFetcher<T> = (entityName: string) => Promise<T[]>;
/// NSManagedObject.objectID analogue — must match the identifiers the store posts on change.
export type ResultsIdentifier<T> = (object: T) => string;
/// sectionNameKeyPath analogue.
export type ResultsSectionName<T> = (object: T) => string;

export class ResultsFetchRequest<T> {
  entityName: string;
  predicate: ResultsPredicate<T> | null = null;
  sortDescriptors: SortDescriptor<T>[] | null = null;
  fetchLimit: number = 0;

  constructor(entityName: string) {
    this.entityName = entityName;
  }
}

export class ResultsSectionInfo<T> {
  name: string;
  objects: T[];

  constructor(name: string, objects: T[]) {
    this.name = name;
    this.objects = objects;
  }

  get numberOfObjects(): number {
    return this.objects.length;
  }
}

// MARK: - Changeset: Objects

export class MovedIndexPath {
  from: IndexPath;
  to: IndexPath;

  constructor(from: IndexPath, to: IndexPath) {
    this.from = from;
    this.to = to;
  }
}

export class ResultsObjectsChangeset {
  deleted: IndexPath[];
  inserted: IndexPath[];
  moved: MovedIndexPath[];
  updated: IndexPath[];

  constructor(deleted: IndexPath[] = [], inserted: IndexPath[] = [], moved: MovedIndexPath[] = [],
    updated: IndexPath[] = []) {
    this.deleted = deleted;
    this.inserted = inserted;
    this.moved = moved;
    this.updated = updated;
  }

  deletedIndexPath(indexPath: IndexPath): void {
    this.deleted.push(indexPath);
  }

  insertedIndexPath(indexPath: IndexPath): void {
    this.inserted.push(indexPath);
  }

  movedIndexPath(from: IndexPath, to: IndexPath): void {
    this.moved.push(new MovedIndexPath(from, to));
  }

  updatedIndexPath(indexPath: IndexPath): void {
    this.updated.push(indexPath);
  }

  /// Displaying data coming from multiple ResultsControllers on screen requires adjusting sectionIndexes
  transposed(section: number): ResultsObjectsChangeset {
    const newDeleted: IndexPath[] = this.deleted.map((p: IndexPath) => p.transpose(section));
    const newInserted: IndexPath[] = this.inserted.map((p: IndexPath) => p.transpose(section));
    const newUpdated: IndexPath[] = this.updated.map((p: IndexPath) => p.transpose(section));
    const newMoved: MovedIndexPath[] = this.moved.map((m: MovedIndexPath) =>
      new MovedIndexPath(m.from.transpose(section), m.to.transpose(section)));
    return new ResultsObjectsChangeset(newDeleted, newInserted, newMoved, newUpdated);
  }
}

// MARK: - Changeset: Sections

export class ResultsSectionsChangeset {
  deleted: Set<number>;
  inserted: Set<number>;

  constructor(deleted: Set<number> = new Set<number>(), inserted: Set<number> = new Set<number>()) {
    this.deleted = deleted;
    this.inserted = inserted;
  }

  deletedSection(index: number): void {
    this.deleted.add(index);
  }

  insertedSection(index: number): void {
    this.inserted.add(index);
  }

  transposed(section: number): ResultsSectionsChangeset {
    const newDeleted: Set<number> = new Set<number>();
    const newInserted: Set<number> = new Set<number>();
    if (this.deleted.size > 0) {
      newDeleted.add(section);
    }
    if (this.inserted.size > 0) {
      newInserted.add(section);
    }
    return new ResultsSectionsChangeset(newDeleted, newInserted);
  }
}

// MARK: - NSFetchedResultsChangeType

export enum ResultsChangeType {
  INSERT = 1,
  DELETE = 2,
  MOVE = 3,
  UPDATE = 4
}

// MARK: - FetchedResultsControllerDelegateWrapper (internal)

export type ResultsOnDidChangeObject<T> = (object: T, type: ResultsChangeType, indexPath: IndexPath | null,
  newIndexPath: IndexPath | null) => void;
export type ResultsOnDidChangeSection<T> = (sectionInfo: ResultsSectionInfo<T>, sectionIndex: number,
  type: ResultsChangeType) => void;

class FetchedResultsControllerDelegateWrapper<T> {
  onWillChangeContent: (() => void) | null = null;
  onDidChangeContent: (() => void) | null = null;
  onDidChangeObject: ResultsOnDidChangeObject<T> | null = null;
  onDidChangeSection: ResultsOnDidChangeSection<T> | null = null;
}

// MARK: - FetchedResultsController (NSFetchedResultsController port)

class FetchedResultsController<T> {
  readonly fetchRequest: ResultsFetchRequest<T>;
  delegate: FetchedResultsControllerDelegateWrapper<T> | null = null;
  fetchedObjects: T[] | null = null;
  sections: ResultsSectionInfo<T>[] | null = null;

  private context: ManagedObjectContext;
  private fetchObjects: ResultsFetcher<T>;
  private identifierOf: ResultsIdentifier<T>;
  private sectionNameOf: ResultsSectionName<T> | null;
  private notificationsToken: number = 0;
  private generation: number = 0;

  constructor(fetchRequest: ResultsFetchRequest<T>, context: ManagedObjectContext, fetchObjects: ResultsFetcher<T>,
    identifierOf: ResultsIdentifier<T>, sectionNameOf: ResultsSectionName<T> | null) {
    this.fetchRequest = fetchRequest;
    this.context = context;
    this.fetchObjects = fetchObjects;
    this.identifierOf = identifierOf;
    this.sectionNameOf = sectionNameOf;
  }

  async performFetch(): Promise<void> {
    const generation: number = ++this.generation;
    const objects: T[] = await this.load();
    if (generation !== this.generation) {
      return;
    }
    this.apply(objects);
    if (this.notificationsToken === 0) {
      this.notificationsToken = this.context.addObserver((note: ObjectsDidChangeNotification) => {
        this.contextDidChange(note);
      });
    }
  }

  stop(): void {
    if (this.notificationsToken !== 0) {
      this.context.removeObserver(this.notificationsToken);
      this.notificationsToken = 0;
    }
    this.generation++;
  }

  object(indexPath: IndexPath): T {
    const sections: ResultsSectionInfo<T>[] = this.sections ?? [];
    return sections[indexPath.section].objects[indexPath.row];
  }

  indexPath(object: T): IndexPath | null {
    return this.indexPathForIdentifier(this.identifierOf(object), this.sections ?? []);
  }

  private indexPathForIdentifier(identifier: string, sections: ResultsSectionInfo<T>[]): IndexPath | null {
    for (let s = 0; s < sections.length; s++) {
      const objects: T[] = sections[s].objects;
      for (let r = 0; r < objects.length; r++) {
        if (this.identifierOf(objects[r]) === identifier) {
          return new IndexPath(r, s);
        }
      }
    }
    return null;
  }

  private async load(): Promise<T[]> {
    const all: T[] = await this.fetchObjects(this.fetchRequest.entityName);
    const predicate: ResultsPredicate<T> | null = this.fetchRequest.predicate;
    let objects: T[] = predicate === null ? all.slice() : all.filter((o: T) => predicate(o));
    const descriptors: SortDescriptor<T>[] = this.fetchRequest.sortDescriptors ?? [];
    if (descriptors.length > 0) {
      objects.sort((lhs: T, rhs: T) => {
        for (const d of descriptors) {
          const result: number = d.compare(lhs, rhs);
          if (result !== 0) {
            return d.ascending ? result : -result;
          }
        }
        return 0;
      });
    }
    if (this.fetchRequest.fetchLimit > 0 && objects.length > this.fetchRequest.fetchLimit) {
      objects = objects.slice(0, this.fetchRequest.fetchLimit);
    }
    return objects;
  }

  private buildSections(objects: T[]): ResultsSectionInfo<T>[] {
    const sectionNameOf: ResultsSectionName<T> | null = this.sectionNameOf;
    if (sectionNameOf === null) {
      return [new ResultsSectionInfo<T>('', objects)];
    }
    const output: ResultsSectionInfo<T>[] = [];
    for (const object of objects) {
      const name: string = sectionNameOf(object);
      const last: ResultsSectionInfo<T> | undefined = output.length > 0 ? output[output.length - 1] : undefined;
      if (last !== undefined && last.name === name) {
        last.objects.push(object);
      } else {
        output.push(new ResultsSectionInfo<T>(name, [object]));
      }
    }
    return output;
  }

  private apply(objects: T[]): void {
    this.fetchedObjects = objects;
    this.sections = this.buildSections(objects);
  }

  private contextDidChange(note: ObjectsDidChangeNotification): void {
    const updatedIdentifiers: Set<string> = new Set<string>();
    if (note.userInfo !== null) {
      const keys: string[] = [NS_UPDATED_OBJECTS_KEY, NS_REFRESHED_OBJECTS_KEY];
      for (const key of keys) {
        const ids: Set<string> | undefined = note.userInfo.get(key);
        if (ids !== undefined) {
          ids.forEach((id: string) => {
            updatedIdentifiers.add(id);
          });
        }
      }
    }
    this.refetchAndDiff(updatedIdentifiers);
  }

  private async refetchAndDiff(updatedIdentifiers: Set<string>): Promise<void> {
    const generation: number = ++this.generation;
    const objects: T[] = await this.load();
    if (generation !== this.generation) {
      return;
    }

    const oldSections: ResultsSectionInfo<T>[] = this.sections ?? [];
    const newSections: ResultsSectionInfo<T>[] = this.buildSections(objects);

    const oldIds: Map<string, IndexPath> = this.mapIdentifiers(oldSections);
    const newIds: Map<string, IndexPath> = this.mapIdentifiers(newSections);
    const oldNames: string[] = oldSections.map((s: ResultsSectionInfo<T>) => s.name);
    const newNames: string[] = newSections.map((s: ResultsSectionInfo<T>) => s.name);

    const sectionChanges: number = oldNames.filter((n: string) => !newNames.includes(n)).length +
      newNames.filter((n: string) => !oldNames.includes(n)).length;
    let objectChanges: number = 0;
    oldIds.forEach((path: IndexPath, id: string) => {
      const newPath: IndexPath | undefined = newIds.get(id);
      if (newPath === undefined || !newPath.equals(path) || updatedIdentifiers.has(id)) {
        objectChanges++;
      }
    });
    newIds.forEach((path: IndexPath, id: string) => {
      if (!oldIds.has(id)) {
        objectChanges++;
      }
    });
    if (sectionChanges === 0 && objectChanges === 0) {
      return;
    }

    const delegate: FetchedResultsControllerDelegateWrapper<T> | null = this.delegate;
    if (delegate !== null && delegate.onWillChangeContent !== null) {
      delegate.onWillChangeContent();
    }

    this.apply(objects);

    if (delegate !== null) {
      const onSection: ResultsOnDidChangeSection<T> | null = delegate.onDidChangeSection;
      if (onSection !== null) {
        for (let i = 0; i < oldSections.length; i++) {
          if (!newNames.includes(oldSections[i].name)) {
            onSection(oldSections[i], i, ResultsChangeType.DELETE);
          }
        }
        for (let i = 0; i < newSections.length; i++) {
          if (!oldNames.includes(newSections[i].name)) {
            onSection(newSections[i], i, ResultsChangeType.INSERT);
          }
        }
      }

      const onObject: ResultsOnDidChangeObject<T> | null = delegate.onDidChangeObject;
      if (onObject !== null) {
        oldIds.forEach((path: IndexPath, id: string) => {
          if (!newIds.has(id)) {
            onObject(oldSections[path.section].objects[path.row], ResultsChangeType.DELETE, path, null);
          }
        });
        newIds.forEach((newPath: IndexPath, id: string) => {
          const object: T = newSections[newPath.section].objects[newPath.row];
          const oldPath: IndexPath | undefined = oldIds.get(id);
          if (oldPath === undefined) {
            onObject(object, ResultsChangeType.INSERT, null, newPath);
          } else if (!oldPath.equals(newPath)) {
            onObject(object, ResultsChangeType.MOVE, oldPath, newPath);
          } else if (updatedIdentifiers.has(id)) {
            onObject(object, ResultsChangeType.UPDATE, oldPath, newPath);
          }
        });
      }

      if (delegate.onDidChangeContent !== null) {
        delegate.onDidChangeContent();
      }
    }
  }

  private mapIdentifiers(sections: ResultsSectionInfo<T>[]): Map<string, IndexPath> {
    const output: Map<string, IndexPath> = new Map<string, IndexPath>();
    for (let s = 0; s < sections.length; s++) {
      const objects: T[] = sections[s].objects;
      for (let r = 0; r < objects.length; r++) {
        output.set(this.identifierOf(objects[r]), new IndexPath(r, s));
      }
    }
    return output;
  }
}

// MARK: - ResultsController

export interface ResultsControllerOptions<T> {
  /// Main thread MOC analogue: the change-notification source
  viewContext: ManagedObjectContext;
  /// T.entityName
  entityName: string;
  fetchObjects: ResultsFetcher<T>;
  identifierOf: ResultsIdentifier<T>;
  sectionNameKeyPath?: ResultsSectionName<T>;
  predicate?: ResultsPredicate<T>;
  sortDescriptors: SortDescriptor<T>[];
  limit?: number;
}

export type ResultsOnDidChangeContent = (sections: ResultsSectionsChangeset, objects: ResultsObjectsChangeset) => void;

export class ResultsController<T> {
  /// FetchedResultsController Delegate Wrapper.
  private internalDelegate: FetchedResultsControllerDelegateWrapper<T> = new FetchedResultsControllerDelegateWrapper<T>();

  /// Results Controller
  private resultsController: FetchedResultsController<T>;

  /// Pending Changesets
  private sectionsChangeset: ResultsSectionsChangeset = new ResultsSectionsChangeset();
  private objectsChangeset: ResultsObjectsChangeset = new ResultsObjectsChangeset();

  /// Closure to be executed before the results are changed.
  onWillChangeContent: (() => void) | null = null;

  /// Closure to be executed after the results are changed.
  onDidChangeContent: ResultsOnDidChangeContent | null = null;

  constructor(options: ResultsControllerOptions<T>) {
    const request: ResultsFetchRequest<T> = new ResultsFetchRequest<T>(options.entityName);
    request.predicate = options.predicate ?? null;
    request.sortDescriptors = options.sortDescriptors;
    request.fetchLimit = options.limit ?? 0;

    this.resultsController = new FetchedResultsController<T>(request, options.viewContext, options.fetchObjects,
      options.identifierOf, options.sectionNameKeyPath ?? null);

    this.setupResultsController();
    this.setupDelegateWrapper();
  }

  /// ResultsController's Fetch Request
  private get fetchRequest(): ResultsFetchRequest<T> {
    return this.resultsController.fetchRequest;
  }

  /// Limits the number of entries to retrieve (null / 0 = unlimited)
  get limit(): number | null {
    return this.fetchRequest.fetchLimit;
  }

  set limit(newValue: number | null) {
    this.fetchRequest.fetchLimit = newValue ?? 0;
  }

  /// Filtering Predicate to be applied to the Results.
  get predicate(): ResultsPredicate<T> | null {
    return this.fetchRequest.predicate;
  }

  set predicate(newValue: ResultsPredicate<T> | null) {
    this.fetchRequest.predicate = newValue;
  }

  /// Results's Sort Descriptors.
  get sortDescriptors(): SortDescriptor<T>[] | null {
    return this.fetchRequest.sortDescriptors;
  }

  set sortDescriptors(newValue: SortDescriptor<T>[] | null) {
    this.fetchRequest.sortDescriptors = newValue;
  }

  // MARK: - Public Methods

  /// Executes the fetch request on the store to get objects, then keeps observing the context.
  async performFetch(): Promise<void> {
    this.resetPendingChangesets();
    await this.resultsController.performFetch();
  }

  /// Stops observing the context (ArkTS has no deinit; owners call this in aboutToDisappear).
  stopObserving(): void {
    this.resultsController.stop();
  }

  /// Returns the Object at the specified IndexPath
  object(indexPath: IndexPath): T {
    return this.resultsController.object(indexPath);
  }

  /// Returns the IndexPath for a given Object
  indexPath(object: T): IndexPath | null {
    return this.resultsController.indexPath(object);
  }

  /// Returns the number of fetched objects.
  get numberOfObjects(): number {
    const objects: T[] | null = this.resultsController.fetchedObjects;
    return objects === null ? 0 : objects.length;
  }

  /// Returns an array of all of the Fetched Objects.
  get fetchedObjects(): T[] {
    return this.resultsController.fetchedObjects ?? [];
  }

  /// Returns an array of SectionInfo Entities.
  get sections(): ResultsSectionInfo<T>[] {
    return this.resultsController.sections ?? [];
  }

  // MARK: - Private Methods

  /// Initializes the FetchedResultsController
  private setupResultsController(): void {
    this.resultsController.delegate = this.internalDelegate;
  }

  /// Initializes FRC's Event Forwarding.
  private setupDelegateWrapper(): void {
    this.internalDelegate.onWillChangeContent = () => {
      if (this.onWillChangeContent !== null) {
        this.onWillChangeContent();
      }
      this.resetPendingChangesets();
    };

    this.internalDelegate.onDidChangeContent = () => {
      if (this.onDidChangeContent !== null) {
        this.onDidChangeContent(this.sectionsChangeset, this.objectsChangeset);
      }
      this.resetPendingChangesets();
    };

    this.internalDelegate.onDidChangeObject = (object: T, type: ResultsChangeType, indexPath: IndexPath | null,
      newIndexPath: IndexPath | null) => {
      // Update reported for a relocated row is a move (pre-iOS 13 FRC quirk, kept for parity)
      let fixedType: ResultsChangeType = type;
      if (type === ResultsChangeType.UPDATE && newIndexPath !== null && !newIndexPath.equals(indexPath)) {
        fixedType = ResultsChangeType.MOVE;
      }

      if (fixedType === ResultsChangeType.DELETE && indexPath !== null) {
        this.objectsChangeset.deletedIndexPath(indexPath);
      } else if (fixedType === ResultsChangeType.INSERT && newIndexPath !== null) {
        this.objectsChangeset.insertedIndexPath(newIndexPath);
      } else if (fixedType === ResultsChangeType.MOVE && indexPath !== null && newIndexPath !== null) {
        this.objectsChangeset.movedIndexPath(indexPath, newIndexPath);
      } else if (fixedType === ResultsChangeType.UPDATE && newIndexPath !== null) {
        // Switch `indexPath` > `newIndexPath` for reload OP(s)
        this.objectsChangeset.updatedIndexPath(newIndexPath);
      } else {
        console.error('[ResultsController] Unrecognized Row Change!');
      }
    };

    this.internalDelegate.onDidChangeSection = (section: ResultsSectionInfo<T>, sectionIndex: number,
      type: ResultsChangeType) => {
      if (type === ResultsChangeType.DELETE) {
        this.sectionsChangeset.deletedSection(sectionIndex);
      } else if (type === ResultsChangeType.INSERT) {
        this.sectionsChangeset.insertedSection(sectionIndex);
      } else {
        console.error('[ResultsController] Unrecognized Section Change!');
      }
    };
  }

  private resetPendingChangesets(): void {
    this.sectionsChangeset = new ResultsSectionsChangeset();
    this.objectsChangeset = new ResultsObjectsChangeset();
  }
}
