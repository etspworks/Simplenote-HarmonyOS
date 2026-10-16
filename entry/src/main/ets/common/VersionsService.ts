// Port of Controllers/VersionsController.swift and SPNoteHistoryController.swift.
// Simperium entity-version requests (e:<key>.<version>) over the notes bucket, and the
// history screen's state machine (version / loadingVersion / error).
import { SPBucket } from './simperium/Bucket';
import { SPDict } from './simperium/JsonDiff';
import { Simperium } from './simperium/Simperium';
import { Note } from '../model/Note';
import { SPHistoryVersion } from '../model/SPHistoryVersion';

class VersionsConstants {
  static readonly MIN_VERSION: number = 1;
  static readonly MAX_NUMBER_OF_VERSIONS: number = 30;
}

/** ClosedRange<Int> */
export class VersionRange {
  readonly lowerBound: number;
  readonly upperBound: number;

  constructor(lowerBound: number, upperBound: number) {
    this.lowerBound = lowerBound;
    this.upperBound = upperBound;
  }

  get count(): number {
    return this.upperBound - this.lowerBound + 1;
  }

  contains(value: number): boolean {
    return value >= this.lowerBound && value <= this.upperBound;
  }
}

/** Note.versionInt: the ghost version as an Int, defaulting to 1 */
export function noteVersionInt(note: Note): number {
  const parsed: number = parseInt(note.version() ?? '1', 10);
  return isNaN(parsed) ? 1 : parsed;
}

/** Opaque receipt returned by requestVersions. Call `cancel()` to stop receiving versions. */
export class ListenerWrapper {
  readonly block: (version: SPHistoryVersion) => void;
  cancelled: boolean = false;

  constructor(block: (version: SPHistoryVersion) => void) {
    this.block = block;
  }

  cancel(): void {
    this.cancelled = true;
  }
}

// MARK: - VersionsController

export class VersionsController {
  private static sharedInstance: VersionsController | null = null;

  private readonly bucket: SPBucket;

  /** Map of event listeners (one per SimperiumKey, by design) */
  private readonly callbackMap: Map<string, ListenerWrapper> = new Map<string, ListenerWrapper>();

  constructor(bucket: SPBucket) {
    this.bucket = bucket;
  }

  /** SPAppDelegate.shared().versionsController: built over Simperium's notes bucket */
  static shared(): VersionsController | null {
    if (VersionsController.sharedInstance === null && Simperium.shared !== null) {
      VersionsController.sharedInstance = new VersionsController((Simperium.shared as Simperium).notesBucket);
    }
    return VersionsController.sharedInstance;
  }

  /**
   * Requests the versions of a Note. `onResponse` may be invoked N times.
   * Returns a receipt; once cancelled no further events are relayed.
   */
  requestVersions(simperiumKey: string, currentVersion: number,
    onResponse: (version: SPHistoryVersion) => void): ListenerWrapper {
    const wrapper: ListenerWrapper = new ListenerWrapper(onResponse);
    this.callbackMap.set(simperiumKey, wrapper);

    const versionRange: VersionRange = VersionsController.range(currentVersion);
    this.bucket.requestVersions(versionRange.count, simperiumKey);
    return wrapper;
  }

  /**
   * Notifies the subscriber a new Version has been retrieved from Simperium.
   * Must be invoked every time the notes SPBucket delegate receives a version
   * (bucketDidReceiveObjectForKey).
   */
  didReceiveObject(simperiumKey: string, version: number, data: SPDict): void {
    const wrapper: ListenerWrapper | undefined = this.callbackMap.get(simperiumKey);
    if (wrapper === undefined) {
      return;
    }
    if (wrapper.cancelled) {
      this.callbackMap.delete(simperiumKey);
      return;
    }
    const item: SPHistoryVersion | null = SPHistoryVersion.fromPayload(version, data);
    if (item === null) {
      return;
    }
    wrapper.block(item);
  }

  /** Returns the range of versions which can be requested */
  static range(version: number): VersionRange {
    const upperBound: number = Math.max(version, VersionsConstants.MIN_VERSION);
    const lowerBound: number = Math.max(upperBound - VersionsConstants.MAX_NUMBER_OF_VERSIONS + 1,
      VersionsConstants.MIN_VERSION);
    return new VersionRange(lowerBound, upperBound);
  }
}

// MARK: - SPNoteHistoryController

export interface SPNoteHistoryControllerDelegate {
  noteHistoryControllerDidCancel(): void;
  noteHistoryControllerDidFinish(): void;
  noteHistoryControllerDidSelectVersion(content: string): void;
}

export enum NoteHistoryStateKind {
  VERSION = 0,
  LOADING_VERSION = 1,
  ERROR = 2
}

/** SPNoteHistoryController.State */
export class NoteHistoryState {
  readonly kind: NoteHistoryStateKind;
  /** Set for VERSION and LOADING_VERSION */
  readonly versionNumber: number | null;
  /** Formatted date of the version (VERSION only) */
  readonly date: string;
  /** Possibility to restore to this version (VERSION only) */
  readonly isRestorable: boolean;
  /** Error message (ERROR only) */
  readonly errorMessage: string;

  private constructor(kind: NoteHistoryStateKind, versionNumber: number | null, date: string,
    isRestorable: boolean, errorMessage: string) {
    this.kind = kind;
    this.versionNumber = versionNumber;
    this.date = date;
    this.isRestorable = isRestorable;
    this.errorMessage = errorMessage;
  }

  static version(versionNumber: number, date: string, isRestorable: boolean): NoteHistoryState {
    return new NoteHistoryState(NoteHistoryStateKind.VERSION, versionNumber, date, isRestorable, '');
  }

  static loadingVersion(versionNumber: number): NoteHistoryState {
    return new NoteHistoryState(NoteHistoryStateKind.LOADING_VERSION, versionNumber, '', false, '');
  }

  static error(message: string): NoteHistoryState {
    return new NoteHistoryState(NoteHistoryStateKind.ERROR, null, '', false, message);
  }
}

const NETWORK_ERROR: string = 'Couldn\'t Retrieve History';

export class SPNoteHistoryController {
  /** Range of versions available to load; contains at least the current version */
  readonly versionRange: VersionRange;

  /** Delegate */
  delegate: SPNoteHistoryControllerDelegate | null = null;

  private readonly note: Note;
  private readonly versionsController: VersionsController | null;
  private versionsToken: ListenerWrapper | null = null;
  private stateValue: NoteHistoryState;
  private observerValue: ((state: NoteHistoryState) => void) | null = null;
  private versions: Map<number, SPHistoryVersion> = new Map<number, SPHistoryVersion>();

  constructor(note: Note, versionsController: VersionsController | null = VersionsController.shared()) {
    this.note = note;
    this.versionsController = versionsController;
    this.versionRange = VersionsController.range(noteVersionInt(note));
    this.stateValue = NoteHistoryState.loadingVersion(this.versionRange.upperBound);
  }

  /** Observer receives state changes; when assigned, it receives the current state */
  get observer(): ((state: NoteHistoryState) => void) | null {
    return this.observerValue;
  }

  set observer(newValue: ((state: NoteHistoryState) => void) | null) {
    this.observerValue = newValue;
    if (newValue !== null) {
      newValue(this.stateValue);
    }
  }

  get state(): NoteHistoryState {
    return this.stateValue;
  }

  private setState(state: NoteHistoryState): void {
    this.stateValue = state;
    if (this.observerValue !== null) {
      this.observerValue(state);
    }
  }

  // MARK: Communications from UI

  /** User tapped on close button */
  handleTapOnCloseButton(): void {
    if (this.delegate !== null) {
      this.delegate.noteHistoryControllerDidCancel();
    }
  }

  /** User tapped on restore button */
  handleTapOnRestoreButton(): void {
    if (this.delegate !== null) {
      this.delegate.noteHistoryControllerDidFinish();
    }
  }

  /** User selected a version */
  select(versionNumber: number): void {
    this.switchToVersion(versionNumber);
  }

  /** Invoked when view is loaded */
  onViewLoad(): void {
    const simperium: Simperium | null = Simperium.shared;
    if (simperium === null || !simperium.authenticator.connected || this.versionsController === null) {
      this.setState(NoteHistoryState.error(NETWORK_ERROR));
      return;
    }
    this.loadData();
  }

  /** Stops relaying versions (the source releases its token on deinit) */
  dispose(): void {
    if (this.versionsToken !== null) {
      this.versionsToken.cancel();
      this.versionsToken = null;
    }
  }

  // MARK: Private

  private loadData(): void {
    if (this.versionsController === null) {
      return;
    }
    this.versionsToken = this.versionsController.requestVersions(this.note.simperiumKey, noteVersionInt(this.note),
      (version: SPHistoryVersion) => {
        this.process(version);
      });
  }

  private process(noteVersion: SPHistoryVersion): void {
    this.versions.set(noteVersion.version, noteVersion);
    // We received a note version with the same version as currently showing: update state
    if (this.stateValue.versionNumber === noteVersion.version) {
      this.switchToVersion(noteVersion.version);
    }
  }

  private switchToVersion(versionNumber: number): void {
    const noteVersion: SPHistoryVersion | undefined = this.versions.get(versionNumber);
    if (noteVersion !== undefined) {
      this.setState(NoteHistoryState.version(versionNumber,
        this.note.dateString(noteVersion.modificationDate, false),
        noteVersion.version !== noteVersionInt(this.note)));
      if (this.delegate !== null) {
        this.delegate.noteHistoryControllerDidSelectVersion(noteVersion.content);
      }
    } else {
      this.setState(NoteHistoryState.loadingVersion(versionNumber));
    }
  }
}
