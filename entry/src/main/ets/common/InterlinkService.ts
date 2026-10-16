// Port of Simplenote/Classes/InterlinkResultsController.swift + InterlinkProcessor.swift
// (with InterlinkViewController's non-UI state and UITextView+Simplenote's interlink lookup).
// UIKit pieces (the editor text view, the popover presenter) are interfaces the editor page implements.
import { Note } from '../model/Note';
import { NoteStore } from './NoteStore';
import { SPTracker } from './Tracker';
import { interlinkKeyword, InterlinkKeyword, INTERLINK_CLOSING } from './interlinks/StringInterlinking';
import { TextRange } from './foundation/StringLine';

// MARK: - Settings

/// InterlinkResultsController Settings.defaultMaximumResults
export const DEFAULT_MAXIMUM_RESULTS: number = 15;
/// InterlinkProcessor Settings.maximumAllowedScrollOffset
export const MAXIMUM_ALLOWED_SCROLL_OFFSET: number = 20;
/// InterlinkViewController Metrics
export const INTERLINK_DEFAULT_CELL_HEIGHT: number = 44;
export const INTERLINK_MAXIMUM_VISIBLE_CELLS: number = 3.5;
export const INTERLINK_MAXIMUM_TABLE_HEIGHT: number = INTERLINK_DEFAULT_CELL_HEIGHT * INTERLINK_MAXIMUM_VISIBLE_CELLS;
export const INTERLINK_MINIMUM_TABLE_HEIGHT: number = INTERLINK_DEFAULT_CELL_HEIGHT;

// MARK: - Geometry

export class InterlinkPoint {
  x: number;
  y: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

export class InterlinkRect {
  x: number;
  y: number;
  width: number;
  height: number;

  constructor(x: number, y: number, width: number, height: number) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }
}

// MARK: - Editor / presenter surfaces (implemented by the editor page)

/// The UITextView surface InterlinkProcessor reads.
export interface InterlinkTextView {
  /// Full editor text
  text: string;
  /// Selected range, UTF-16 offsets (TextArea caret units)
  selectionStart: number;
  selectionEnd: number;
  /// Editor focus (isFirstResponder)
  isFirstResponder: boolean;
  /// undoManager?.isUndoing == true
  isUndoingEditOP: boolean;
  /// Scroll offset of the editor
  contentOffset: InterlinkPoint;
  /// Frame (window coordinates) of the text in `range`
  locationInWindowForText(range: TextRange): InterlinkRect;
}

/// The PopoverPresenter surface InterlinkProcessor drives.
export interface InterlinkPopoverPresenter {
  isPresented: boolean;
  show(controller: InterlinkViewController, anchorInWindow: InterlinkRect, desiredHeight: number): void;
  relocate(anchorInWindow: InterlinkRect): void;
  relocateBy(deltaY: number): void;
  dismiss(): void;
}

/// Invoked whenever an Autocomplete Row has been selected: the handler should insert `text` at `range`.
export interface InterlinkProcessorDelegate {
  interlinkProcessor(processor: InterlinkProcessor, text: string, range: TextRange): void;
}

export type InterlinkNotesChanged = (notes: Note[]) => void;

/// InterlinkViewController state: the popover's list of notes + its insert callback.
export class InterlinkViewController {
  /// Closure executed whenever a Note is selected; the Interlink markdown is passed along.
  onInsertInterlink: ((text: string) => void) | null = null;
  /// Invoked whenever `notes` changes (tableView.reloadData analogue)
  onNotesChanged: InterlinkNotesChanged | null = null;

  private notesValue: Note[] = [];

  get notes(): Note[] {
    return this.notesValue;
  }

  set notes(newValue: Note[]) {
    this.notesValue = newValue;
    if (this.onNotesChanged !== null) {
      this.onNotesChanged(newValue);
    }
  }

  get desiredHeight(): number {
    return INTERLINK_MAXIMUM_TABLE_HEIGHT;
  }

  /// tableView(_:didSelectRowAt:) — the tapped row's note (the list passes the note itself, see the editor's
  /// interlinkList).
  didSelectNote(note: Note): void {
    this.performInterlinkInsert(note);
  }

  private performInterlinkInsert(note: Note): void {
    const markdownInterlink: string | null = note.markdownInternalLink;
    if (markdownInterlink === null) {
      return;
    }
    if (this.onInsertInterlink !== null) {
      this.onInsertInterlink(markdownInterlink);
    }
  }
}

// MARK: - InterlinkResultsController

export class InterlinkResultsController {
  /// NSManagedObjectContext analogue: the note store
  private viewContext: NoteStore;
  /// NSPredicate.predicateForNotes(deleted: false)
  private predicate: (note: Note) => boolean = (note: Note): boolean => !note.deleted;
  /// Limits the maximum number of results to fetch
  maximumNumberOfResults: number = DEFAULT_MAXIMUM_RESULTS;

  constructor(viewContext: NoteStore) {
    this.viewContext = viewContext;
  }

  /// resultsController.fetchedObjects: non-deleted notes sorted by content ascending.
  private get fetchedObjects(): Note[] {
    const notes: Note[] = this.viewContext.notes().filter((note: Note): boolean => this.predicate(note));
    notes.sort((a: Note, b: Note): number => {
      const lhs: string = a.content;
      const rhs: string = b.content;
      return lhs < rhs ? -1 : (lhs > rhs ? 1 : 0);
    });
    return notes;
  }

  /// Returns the Notes whose title contains `keyword`, excluding `excludedID` (a simperiumKey).
  /// Returns null when there are no results.
  searchNotes(keyword: string, excludedID: string | null): Note[] | null {
    return this.filter(this.fetchedObjects, keyword, excludedID);
  }

  /// In-memory, diacritic + case insensitive title filter.
  filter(notes: Note[], keyword: string, excludedID: string | null): Note[] | null {
    const normalizedKeyword: string = foldForComparison(keyword.trim());
    const output: Note[] = [];

    for (const note of notes) {
      if (note.simperiumKey === excludedID) {
        continue;
      }
      note.ensurePreviewStringsAreAvailable();
      const title: string | null = note.titlePreview;
      if (title === null || foldForComparison(title).indexOf(normalizedKeyword) < 0) {
        continue;
      }
      output.push(note);
      if (output.length >= this.maximumNumberOfResults) {
        break;
      }
    }

    return output.length === 0 ? null : output;
  }
}

/// [.diacriticInsensitive, .caseInsensitive]
function foldForComparison(text: string): string {
  return text.normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toLocaleLowerCase();
}

// MARK: - InterlinkProcessor

export class InterlinkProcessor {
  private viewContext: NoteStore;
  private popoverPresenter: InterlinkPopoverPresenter;
  private parentTextView: InterlinkTextView;
  private excludedEntityID: string;

  private interlinkViewController: InterlinkViewController | null = null;

  private lastKnownEditorOffset: InterlinkPoint | null = null;
  private lastKnownKeywordRange: TextRange | null = null;
  private initialEditorOffset: InterlinkPoint | null = null;
  private resultsControllerValue: InterlinkResultsController | null = null;

  delegate: InterlinkProcessorDelegate | null = null;

  constructor(viewContext: NoteStore, popoverPresenter: InterlinkPopoverPresenter, parentTextView: InterlinkTextView,
    excludedEntityID: string) {
    this.viewContext = viewContext;
    this.popoverPresenter = popoverPresenter;
    this.parentTextView = parentTextView;
    this.excludedEntityID = excludedEntityID;
  }

  private get resultsController(): InterlinkResultsController {
    if (this.resultsControllerValue === null) {
      this.resultsControllerValue = new InterlinkResultsController(this.viewContext);
    }
    return this.resultsControllerValue;
  }

  /// Displays the Interlink Lookup UI at the cursor when the editor is focused, not undoing nor selecting,
  /// there is a `[keyword` at the cursor, and some Notes carry `keyword` in their title. Otherwise dismisses.
  processInterlinkLookup(): void {
    const lookup: InterlinkKeyword | null = this.mustProcessInterlinkLookup ? this.interlinkKeywordAtSelectedLocation() : null;
    const notes: Note[] | null = lookup === null ? null :
      this.resultsController.searchNotes(lookup.keyword, this.excludedEntityID);
    if (lookup === null || notes === null) {
      this.dismissInterlinkLookup();
      return;
    }

    this.showInterlinkController(notes, lookup.keywordRange);
    this.setupInterlinkEventListeners(lookup.markdownRange);

    const offset: InterlinkPoint = this.parentTextView.contentOffset;
    this.initialEditorOffset = new InterlinkPoint(offset.x, offset.y);
    this.lastKnownEditorOffset = new InterlinkPoint(offset.x, offset.y);
    this.lastKnownKeywordRange = lookup.keywordRange;
  }

  /// Dismisses the Interlink UI (if it's onscreen!)
  dismissInterlinkLookup(): void {
    this.popoverPresenter.dismiss();
    this.interlinkViewController = null;
  }

  // MARK: - Presenting

  showInterlinkController(notes: Note[], range: TextRange): void {
    const keywordFrame: InterlinkRect = this.parentTextView.locationInWindowForText(range);

    if (this.popoverPresenter.isPresented) {
      this.refreshInterlinkController(notes);
      this.popoverPresenter.relocate(keywordFrame);
      return;
    }

    const viewController: InterlinkViewController = new InterlinkViewController();
    this.interlinkViewController = viewController;
    this.refreshInterlinkController(notes);

    this.popoverPresenter.show(viewController, keywordFrame, viewController.desiredHeight);

    SPTracker.trackEditorInterlinkAutocompleteViewed();
  }

  refreshInterlinkController(notes: Note[]): void {
    if (this.interlinkViewController !== null) {
      this.interlinkViewController.notes = notes;
    }
  }

  setupInterlinkEventListeners(replacementRange: TextRange): void {
    if (this.interlinkViewController === null) {
      return;
    }
    this.interlinkViewController.onInsertInterlink = (text: string): void => {
      if (this.delegate !== null) {
        this.delegate.interlinkProcessor(this, text, replacementRange);
      }
    };
  }

  // MARK: - Scrolling

  /// Relocates the Interlink UI to match the new editor offset; a user drag beyond the maximum
  /// allowed scroll offset dismisses it.
  refreshInterlinkControllerWithNewOffset(contentOffset: InterlinkPoint, isDragging: boolean): void {
    const oldOffset: InterlinkPoint | null = this.lastKnownEditorOffset;
    const initialOffset: InterlinkPoint | null = this.initialEditorOffset;
    this.lastKnownEditorOffset = contentOffset;

    if (oldOffset === null || initialOffset === null) {
      return;
    }

    this.popoverPresenter.relocateBy(oldOffset.y - contentOffset.y);
    if (isDragging) {
      this.dismissInterlinkLookupIfNeeded(initialOffset.y, contentOffset.y);
    }
  }

  private dismissInterlinkLookupIfNeeded(initialY: number, currentY: number): void {
    if (Math.abs(currentY - initialY) <= MAXIMUM_ALLOWED_SCROLL_OFFSET) {
      return;
    }
    this.dismissInterlinkLookup();
  }

  // MARK: - State

  private get mustProcessInterlinkLookup(): boolean {
    const editor: InterlinkTextView = this.parentTextView;
    const isTextSelected: boolean = editor.selectionEnd - editor.selectionStart > 0;
    return editor.isFirstResponder && !isTextSelected && !editor.isUndoingEditOP;
  }

  /// UITextView.interlinkKeywordAtSelectedLocation
  private interlinkKeywordAtSelectedLocation(): InterlinkKeyword | null {
    const text: string = this.parentTextView.text;
    const location: number = this.parentTextView.selectionStart;
    if (location < 0 || location > text.length) {
      return null;
    }
    const lookup: InterlinkKeyword | null = interlinkKeyword(text, location);
    if (lookup !== null || text.charAt(location) !== INTERLINK_CLOSING) {
      return lookup;
    }
    // The HarmonyOS input method pairs a typed `[` with `]`, leaving `[keyword|]`: look it up as `[keyword|`
    // and let the inserted link replace that `]` too.
    const unpaired: InterlinkKeyword | null =
      interlinkKeyword(text.substring(0, location) + text.substring(location + 1), location);
    if (unpaired === null) {
      return null;
    }
    return new InterlinkKeyword(new TextRange(unpaired.markdownRange.start, unpaired.markdownRange.end + 1),
      unpaired.keywordRange, unpaired.keyword);
  }
}
