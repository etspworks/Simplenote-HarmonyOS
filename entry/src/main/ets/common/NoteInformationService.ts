// Port of Simplenote/Information/NoteInformationController.swift: the Info card's data — the note's
// metrics (modified, created, words, characters) and every note that links to it ("Referenced In").
// CoreData's EntityObserver + ResultsController pair maps onto NoteStore's change listener: the
// store reports every local save and remote sync, and both halves re-read on it.
import { i18n, intl } from '@kit.LocalizationKit';
import { Note } from '../model/Note';
import { NoteMetrics } from '../model/NoteMetrics';
import { formatDateTime, formatMediumDate } from './DateFormatters';
import { NoteStore } from './NoteStore';

/// Row kind (the Swift enum's cases)
export enum NoteInformationRowKind {
  METRIC = 'metric',
  REFERENCE = 'reference',
  HEADER = 'header'
}

/// Row
export class NoteInformationRow {
  kind: NoteInformationRowKind;
  title: string;
  /// metric: the value; reference: the "N References, Last Modified <date>" line
  value: string | null = null;
  /// reference: the linking note's internal link (opens that note)
  interLink: string | null = null;

  constructor(kind: NoteInformationRowKind, title: string) {
    this.kind = kind;
    this.title = title;
  }

  static metric(title: string, value: string | null): NoteInformationRow {
    const row: NoteInformationRow = new NoteInformationRow(NoteInformationRowKind.METRIC, title);
    row.value = value;
    return row;
  }

  static reference(interLink: string | null, title: string, reference: string): NoteInformationRow {
    const row: NoteInformationRow = new NoteInformationRow(NoteInformationRowKind.REFERENCE, title);
    row.interLink = interLink;
    row.value = reference;
    return row;
  }

  static header(title: string): NoteInformationRow {
    return new NoteInformationRow(NoteInformationRowKind.HEADER, title);
  }
}

/// Section
export class NoteInformationSection {
  rows: NoteInformationRow[];

  constructor(rows: NoteInformationRow[]) {
    this.rows = rows;
  }
}

export type NoteInformationObserver = (sections: NoteInformationSection[]) => void;

// Localization
const LOCALIZATION_MODIFIED: string = 'Modified';
const LOCALIZATION_CREATED: string = 'Created';
const LOCALIZATION_WORDS: string = 'Words';
const LOCALIZATION_CHARACTERS: string = 'Characters';
const LOCALIZATION_REFERENCES: string = 'Referenced In';
const LOCALIZATION_REFERENCE_SINGULAR: string = '%i Reference';
const LOCALIZATION_REFERENCE_PLURAL: string = '%i References';
const LOCALIZATION_LAST_MODIFIED: string = 'Last Modified %1$@';

function interlinkReferences(references: number): string {
  const template: string = references > 1 ? LOCALIZATION_REFERENCE_PLURAL : LOCALIZATION_REFERENCE_SINGULAR;
  return template.replace('%i', String(references));
}

function lastModified(dateString: string): string {
  return LOCALIZATION_LAST_MODIFIED.replace('%1$@', dateString);
}

// NumberFormatter.decimalFormatter
const DECIMAL_FORMATTER: intl.NumberFormat = new intl.NumberFormat(i18n.System.getSystemLocale(),
  { style: 'decimal' } as intl.NumberOptions);
const SHORT_TIME_FORMATTER: intl.DateTimeFormat = new intl.DateTimeFormat(i18n.System.getSystemLocale(),
  { timeStyle: 'short' } as intl.DateTimeOptions);

/// DateFormatter.dateTimeFormatter (.medium date, .short time). Apple joins the two with "at" in
/// English ("6 Oct 2026 at 17:32"); ICU's medium pattern uses ", ". Other languages keep ICU's pattern.
function formatInformationDate(date: Date): string {
  if (!i18n.System.getSystemLanguage().startsWith('en')) {
    return formatDateTime(date);
  }
  return `${formatMediumDate(date)} at ${SHORT_TIME_FORMATTER.format(date)}`;
}

/// ResultsController<Note> analogue: notes whose content contains the link, sorted by content.
class NoteReferencesController {
  private readonly noteLink: string;
  fetchedObjects: Note[] = [];
  onDidChangeContent: (() => void) | null = null;

  constructor(noteLink: string) {
    this.noteLink = noteLink;
  }

  performFetch(): void {
    // NSPredicate.predicateForNotes(exactMatch:) = "content CONTAINS %@"
    const matches: Note[] = NoteStore.sharedManager().notes().filter((candidate: Note) => {
      return candidate.content.includes(this.noteLink);
    });
    // NSSortDescriptor(keyPath: \Note.content, ascending: true)
    matches.sort((lhs: Note, rhs: Note) => lhs.content < rhs.content ? -1 : (lhs.content > rhs.content ? 1 : 0));
    this.fetchedObjects = matches;
  }

  /// The store changed: refetch, then report.
  storeDidChange(): void {
    this.performFetch();
    if (this.onDidChangeContent !== null) {
      this.onDidChangeContent();
    }
  }
}

export class NoteInformationController {
  private readonly note: Note;

  /// ResultsController: in charge of the references query
  private referencesController: NoteReferencesController | null = null;

  /// Note changes observer (EntityObserver's delegate slot)
  private noteChangesObserverActive: boolean = false;
  private readonly noteChangesObserver: () => void = () => {
    this.storeDidChange();
  };

  private observerValue: NoteInformationObserver | null = null;

  constructor(note: Note) {
    this.note = note;
    this.configureReferencesController();
  }

  /// Main Context
  private get mainContext(): NoteStore {
    return NoteStore.sharedManager();
  }

  /// Observer sends changes in data. When assigned, it sends current state.
  get observer(): NoteInformationObserver | null {
    return this.observerValue;
  }

  set observer(newValue: NoteInformationObserver | null) {
    this.observerValue = newValue;
    if (newValue !== null) {
      newValue(this.allSections());
    }
    if (newValue === null) {
      this.stopListeningForChanges();
    } else {
      this.startListeningForChanges();
    }
  }

  // MARK: - Private

  private configureReferencesController(): void {
    const noteLink: string | null = this.note.plainInternalLink;
    if (noteLink === null) {
      return;
    }
    const controller: NoteReferencesController = new NoteReferencesController(noteLink);
    this.referencesController = controller;
    controller.performFetch();
  }

  // MARK: - Listening for changes

  private startListeningForChanges(): void {
    if (!this.noteChangesObserverActive) {
      this.mainContext.addChangeListener(this.noteChangesObserver);
      this.noteChangesObserverActive = true;
    }
    if (this.referencesController !== null) {
      this.referencesController.onDidChangeContent = () => {
        this.sendNewDataToObserver();
      };
    }
  }

  private stopListeningForChanges(): void {
    if (this.noteChangesObserverActive) {
      this.mainContext.removeChangeListener(this.noteChangesObserver);
      this.noteChangesObserverActive = false;
    }
    if (this.referencesController !== null) {
      this.referencesController.onDidChangeContent = null;
    }
  }

  /// One store change drives both halves: the references refetch (which reports through
  /// onDidChangeContent) and, for the note itself, the EntityObserver delegate callback.
  private storeDidChange(): void {
    if (this.referencesController !== null) {
      this.referencesController.storeDidChange();
    }
    this.entityObserver([this.note.simperiumKey]);
  }

  // MARK: - Data

  allSections(): NoteInformationSection[] {
    const sections: NoteInformationSection[] = [];
    sections.push(this.metricSection());
    for (const section of this.referenceSections()) {
      sections.push(section);
    }
    return sections;
  }

  metricSection(): NoteInformationSection {
    const metrics: NoteMetrics = new NoteMetrics(this.note);
    const rows: NoteInformationRow[] = [
      NoteInformationRow.metric(LOCALIZATION_MODIFIED, formatInformationDate(metrics.modifiedDate)),
      NoteInformationRow.metric(LOCALIZATION_CREATED, formatInformationDate(metrics.creationDate)),
      NoteInformationRow.metric(LOCALIZATION_WORDS, DECIMAL_FORMATTER.format(metrics.numberOfWords)),
      NoteInformationRow.metric(LOCALIZATION_CHARACTERS, DECIMAL_FORMATTER.format(metrics.numberOfChars))
    ];
    return new NoteInformationSection(rows);
  }

  referenceSections(): NoteInformationSection[] {
    if (this.referencesController === null) {
      return [];
    }
    const references: Note[] = this.referencesController.fetchedObjects;
    if (references.length === 0) {
      return [];
    }

    const referenceRows: NoteInformationRow[] = references.map((referenceNote: Note) => {
      const date: string = formatMediumDate(referenceNote.modificationDate);
      const instancesOfReference: number = referenceNote.instancesOfReference(this.note);
      const value: string = `${interlinkReferences(instancesOfReference)}, ${lastModified(date)}`;
      referenceNote.ensurePreviewStringsAreAvailable();
      return NoteInformationRow.reference(referenceNote.plainInternalLink, referenceNote.titlePreview ?? '', value);
    });

    const header: NoteInformationSection = new NoteInformationSection([
      NoteInformationRow.header(LOCALIZATION_REFERENCES)
    ]);
    return [header, new NoteInformationSection(referenceRows)];
  }

  sendNewDataToObserver(): void {
    if (this.observerValue !== null) {
      this.observerValue(this.allSections());
    }
  }

  // MARK: - EntityObserverDelegate

  entityObserver(identifiers: string[]): void {
    if (identifiers.length === 0) {
      return;
    }
    this.sendNewDataToObserver();
  }
}

export { NoteInformationController as NoteInformationService };
