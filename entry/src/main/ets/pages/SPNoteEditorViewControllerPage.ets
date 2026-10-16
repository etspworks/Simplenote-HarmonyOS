// Port of SPNoteEditorViewController (.m + +Extensions.swift). Structure (S3): top bar (back + the
// right bar items in source order), the editor text view with the search map on its trailing edge,
// the floating tag bar, the search toolbar, and the two autocomplete popovers (interlinks, tag
// suggestions). Options / History / Information are sheets hosted here, reading this page's note.
import { router, window, LengthMetrics, KeyboardAvoidMode } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { systemShare } from '@kit.ShareKit';
import { uniformTypeDescriptor } from '@kit.ArkData';
import { pasteboard } from '@kit.BasicServicesKit';
import { KeyCode } from '@kit.InputKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { NoteRouteParams } from './SPNoteListViewControllerPage';
import { OptionsViewController, REOPEN_NOTE_OPTIONS_KEY } from './OptionsViewControllerPage';
import { SPNoteHistoryViewController } from './SPNoteHistoryViewControllerPage';
import { NoteInformationViewController } from './NoteInformationViewControllerPage';
import { ArrayDataSource } from '../common/ArrayDataSource';
import {
  InterlinkProcessor,
  InterlinkPoint,
  InterlinkProcessorDelegate,
  InterlinkRect,
  InterlinkViewController
} from '../common/InterlinkService';
import { NoteStore, isValidEmailAddress } from '../common/NoteStore';
import { NoteScrollPositionCache } from '../common/NoteScrollPositionCache';
import { clearOpenNoteKey, encodeOpenNoteKey } from '../common/OpenNoteRestoration';
import { ShortcutsHandler } from '../common/DeepLinkRouter';
import { NoticeController, NoticeFactory } from '../common/NoticeCenter';
import { SessionStore } from '../common/SessionStore';
import { SPTracker } from '../common/Tracker';
import { SearchQuery } from '../common/search/SearchQuery';
import { Note, TextRange } from '../model/Note';
import { TextRange as StringTextRange } from '../common/foundation/StringLine';
import { Tag } from '../model/Tag';
import {
  SPEditorTextController,
  SPEditorTextView,
  EditorTextEdit,
  insertOrRemoveChecklist
} from '../components/EditorTextView';
import { NoteEditorTagListViewController } from '../components/EditorTagBar';
import { Popover, PopoverLayout, PopoverPresenter } from '../components/Popover';
import { SearchMapView } from '../components/SearchMap';
import { NoticeToast } from '../components/NoticeToast';
import { HmIconButton } from '../components/HmIconButton';

const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'NoteEditor';
/// UIKitConstants.animationDelayShort: wait for the options dismiss before presenting the next UI
const OPTIONS_DISMISS_DELAY_MS: number = 250;
// ArkUI router pop transition; the list's NoticeToast re-attaches when its page shows.
const POP_TRANSITION_MS: number = 400;
/// Metrics.searchMapWidth
const SEARCH_MAP_WIDTH: number = 15;
/// NoteEditorTagListViewController Constants.clearRecentlyCreatedTagTimeout
const CLEAR_RECENTLY_CREATED_TAG_TIMEOUT_MS: number = 3500;
/// NoteEditorTagSuggestionsViewController: 3.5 visible rows (48vp HarmonyOS menu rows)
const TAG_SUGGESTIONS_DESIRED_HEIGHT: number = 48 * 3.5;
/// Words, as String.contentSlice(matching:) splits them
/// SPEditorTextView vertical insets (8pt top + 8pt bottom)
const EDITOR_VERTICAL_INSETS: number = 16;
/// restoreScrollPosition waits for the RichEditor to lay the note out
const RESTORE_SCROLL_RETRY_MS: number = 50;
const RESTORE_SCROLL_MAX_ATTEMPTS: number = 20;
/// The silent focus that scrolls the caret in takes two 80 ms settles; read the offset back after it
const RESTORE_SCROLL_VERIFY_MS: number = 250;
/// One body line (EditorTextView bodyStyle lineHeight): the margin RichEditor keeps below a caret it scrolls in
const RESTORE_CARET_MARGIN: number = 24;
const WORD_PATTERN: string = '[^\\s.,;:!?"()\\[\\]{}<>\\/\\\\|@#$%^&*+=~`\\-]+';

export class MarkdownRouteParams {
  noteKey: string = '';
}

function fold(text: string): string {
  return text.normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toLowerCase();
}

/// Delegate bridge: InterlinkProcessorDelegate -> the page's insert handler.
class EditorInterlinkDelegate implements InterlinkProcessorDelegate {
  private readonly onInsert: (text: string, range: StringTextRange) => void;

  constructor(onInsert: (text: string, range: StringTextRange) => void) {
    this.onInsert = onInsert;
  }

  interlinkProcessor(processor: InterlinkProcessor, text: string, range: StringTextRange): void {
    this.onInsert(text, range);
    processor.dismissInterlinkLookup();
  }
}

@Entry
@Component
struct SPNoteEditorViewControllerPage {
  @State noteKey: string = '';
  /// Note loaded by simperiumKey router param from svc_note_store
  @State note: Note | null = null;
  /// Editor text bound to Note.content
  @State content: string = '';
  /// Note.tags (tag chips, email tags hidden)
  @State tags: string[] = [];
  /// keyboard height listener
  @State isKeyboardVisible: boolean = false;
  /// editor focus
  @State isEditingNote: boolean = false;
  /// search keyword passed from the list (search highlight mode); empty when not searching
  @State searchQuery: string = '';
  /// current match
  @State searchResultIndex: number = 0;
  @State searchResultCount: number = 0;
  @State searchMapPositions: number[] = [];
  @State showOptions: boolean = false;
  /// bounceMarkdownPreview: editor x offset and the dimmed fake preview shown on its trailing side
  @State markdownBounceX: number = 0;
  @State markdownPeek: boolean = false;
  private markdownBeforeOptions: boolean = false;
  @State showHistory: boolean = false;
  @State showInformation: boolean = false;
  /// svc_interlinks results for the '[keyword' popover (folded screen_interlink)
  @State interlinkMatches: Note[] = [];
  @State interlinkLayout: PopoverLayout | null = null;
  /// existing tags matching the tag field (folded screen_tag_suggestions)
  @State tagSuggestions: string[] = [];
  @State tagSuggestionsLayout: PopoverLayout | null = null;
  @State tagEntryText: string = '';
  @State pageVisible: boolean = true;

  private modified: boolean = false;
  private cursorLocationBeforeRemoteUpdate: number = 0;
  private noteContentBeforeRemoteUpdate: string = '';
  private historyFinished: boolean = false;
  private didCleanUp: boolean = false;
  /// aboutToDisappear ran: a cold-launch store load that finishes later must not create a note for this editor
  private isDisappeared: boolean = false;
  private didRestoreScrollPosition: boolean = false;
  private searchResultRanges: TextRange[] = [];
  private recentlyCreatedTag: string = '';
  private recentlyCreatedTagTimer: number = -1;
  private editor: SPEditorTextController = new SPEditorTextController();
  private interlinkDataSource: ArrayDataSource<Note> = new ArrayDataSource<Note>([]);
  private tagSuggestionsDataSource: ArrayDataSource<string> = new ArrayDataSource<string>([]);
  private interlinkController: InterlinkViewController | null = null;
  private interlinkPresenter: PopoverPresenter = new PopoverPresenter(
    (): InterlinkRect => this.visibleEditingRect(),
    (layout: PopoverLayout | null): void => {
      this.interlinkLayout = layout;
    });
  private tagPopoverPresenter: PopoverPresenter = new PopoverPresenter(
    (): InterlinkRect => this.editor.editingRectInWindow(),
    (layout: PopoverLayout | null): void => {
      this.tagSuggestionsLayout = layout;
    });
  private interlinkProcessor: InterlinkProcessor | null = null;
  private keyboardWindow: window.Window | null = null;
  /// Keyboard and window heights (vp): the part of the editor the keyboard covers is no popover viewport
  private keyboardHeight: number = 0;
  private windowHeight: number = 0;
  /// The window's avoid mode before this editor showed (restored when it hides)
  private savedKeyboardAvoidMode: KeyboardAvoidMode | undefined = undefined;
  private keyboardListener: (height: number) => void = (height: number): void => {
    this.isKeyboardVisible = height > 0;
    this.keyboardHeight = this.getUIContext().px2vp(height);
  };

  private deletedNoteHook = (key: string): void => {
    if (key === this.noteKey) {
      this.didDeleteCurrentNote();
    }
  };

  private willReceiveNewContentHook = (key: string): void => {
    if (key === this.noteKey) {
      this.willReceiveNewContent();
    }
  };

  private didReceiveNewContentHook = (key: string): void => {
    if (key === this.noteKey) {
      this.didReceiveNewContent();
    }
  };

  aboutToAppear(): void {
    const params: NoteRouteParams | undefined = router.getParams() as NoteRouteParams | undefined;
    SessionStore.shared().hooks.noteEditorDidDeleteNote = this.deletedNoteHook;
    SessionStore.shared().hooks.noteEditorWillReceiveNewContent = this.willReceiveNewContentHook;
    SessionStore.shared().hooks.noteEditorDidReceiveNewContent = this.didReceiveNewContentHook;
    this.tagPopoverPresenter.dismissOnInteractionWithPassthruView = true;
    this.interlinkPresenter.clampsAnchorToViewport = true;
    this.startListeningToKeyboardNotifications();
    // A cold deep link can open the editor before the note store's backend is attached: loading
    // then yielded a null note, so every note action (new note, options, history) did nothing.
    const store: NoteStore = NoteStore.sharedManager();
    if (store.isReady) {
      this.loadNoteAndOverlay(params);
    } else {
      store.whenReady().then((): void => {
        // Closed before the store was ready: no editor shows the note, and nothing would trash a blank one.
        if (!this.isDisappeared) {
          this.loadNoteAndOverlay(params);
        }
      });
    }
  }

  private loadNoteAndOverlay(params: NoteRouteParams | undefined): void {
    this.loadNote(params);
    // After loadNote: the processor excludes this note (by key) from its results.
    this.configureInterlinksProcessor();
    if (params !== undefined && params !== null) {
      this.updateWithSearchQuery(params.searchQuery ?? '');
      // Cold path: onPageShow ran before the query was known.
      this.highlightSearchResultsIfNeeded();
      const overlay: string = params.overlay ?? '';
      if (overlay === 'options') {
        this.presentOptionsController();
      } else if (overlay === 'history') {
        this.presentHistoryController();
      } else if (overlay === 'information') {
        this.presentInformationController();
      }
    }
    // Cold path: the store became ready after onPageShow already ran.
    this.ensureEditorIsFirstResponder();
    // viewWillAppear: -> restoreScrollPosition (async, once the frames are laid out)
    this.restoreScrollPosition(0);
  }

  aboutToDisappear(): void {
    this.isDisappeared = true;
    this.stopListeningToKeyboardNotifications();
    // router.replaceUrl can build the next editor first: only clear the hook while it is still ours.
    const hooks = SessionStore.shared().hooks;
    if (hooks.noteEditorDidDeleteNote === this.deletedNoteHook) {
      hooks.noteEditorDidDeleteNote = null;
    }
    if (hooks.noteEditorWillReceiveNewContent === this.willReceiveNewContentHook) {
      hooks.noteEditorWillReceiveNewContent = null;
    }
    if (hooks.noteEditorDidReceiveNewContent === this.didReceiveNewContentHook) {
      hooks.noteEditorDidReceiveNewContent = null;
    }
    if (this.recentlyCreatedTagTimer >= 0) {
      clearTimeout(this.recentlyCreatedTagTimer);
      this.recentlyCreatedTagTimer = -1;
    }
    this.ensureEmptyNoteIsDeleted();
    // The editor left the stack: relaunch shows the note list only.
    clearOpenNoteKey(this.noteKey);
  }

  onPageShow(): void {
    this.pageVisible = true;
    this.useKeyboardAdjustedInsets();
    // Collaborators -> Options back item: Options is presented again over the editor.
    if (AppStorage.get<boolean>(REOPEN_NOTE_OPTIONS_KEY) === true) {
      AppStorage.setOrCreate<boolean>(REOPEN_NOTE_OPTIONS_KEY, false);
      this.presentOptionsController();
    }
    this.highlightSearchResultsIfNeeded();
    // viewDidAppear: -> ensureEditorIsFirstResponder
    this.ensureEditorIsFirstResponder();
  }

  /// ensureEditorIsFirstResponder: an empty note opens with the caret and keyboard up. The Markdown
  /// preview is its own page, so pageVisible stands in for !isPreviewing.
  private ensureEditorIsFirstResponder(): void {
    if (this.note !== null && this.content.length === 0 && !this.showHistory && this.pageVisible) {
      this.editor.becomeFirstResponder();
    }
  }

  onPageHide(): void {
    this.pageVisible = false;
    this.restoreKeyboardAvoidMode();
    this.saveScrollPosition();
    // encodeRestorableState: persist the note before its key is encoded for relaunch.
    this.saveIfNeeded();
    encodeOpenNoteKey(this.noteKey);
  }

  onBackPress(): boolean | void {
    if (this.showHistory) {
      this.showHistory = false;
      return true;
    }
    this.dismissEditor();
    return true;
  }

  // MARK: - Note

  private loadNote(params: NoteRouteParams | undefined): void {
    const store: NoteStore = NoteStore.sharedManager();
    let note: Note | null = null;
    if (params !== undefined && params !== null && (params.noteKey ?? '').length > 0) {
      this.noteKey = params.noteKey;
      const found: Note | undefined = store.notes().find((n: Note): boolean => n.simperiumKey === this.noteKey);
      note = found === undefined ? null : found;
    } else {
      note = this.newNote(params === undefined || params === null ? true : params.useSelectedTag);
    }
    this.note = note;
    this.displayNote();
  }

  /// EditorFactory.newNote() — a blank note carrying the list's selected tag.
  private newNote(useSelectedTag: boolean): Note | null {
    const note: Note | null = NoteStore.sharedManager().newDefaultNote();
    if (note === null) {
      return null;
    }
    const tagName: string | null = SessionStore.shared().selectedTag;
    if (useSelectedTag && tagName !== null && tagName.length > 0) {
      note.addTag(tagName);
    }
    this.noteKey = note.simperiumKey;
    return note;
  }

  /// displayNote
  private displayNote(): void {
    const note: Note | null = this.note;
    if (note === null) {
      return;
    }
    this.content = note.content;
    this.editor.text = note.content;
    this.reloadTags();
    note.unread = false;
    this.modified = false;
    hilog.info(DOMAIN, LOG_TAG, 'NoteEditor: opened note %{public}s', note.simperiumKey);
    encodeOpenNoteKey(note.simperiumKey);
    // updateHomeScreenQuickActions
    ShortcutsHandler.shared.updateHomeScreenQuickActions(note);
  }

  /// NoteEditorTagListViewController.reload
  private reloadTags(): void {
    const note: Note | null = this.note;
    this.tags = note === null ? [] :
      note.tagsArray.filter((tag: string): boolean => !isValidEmailAddress(tag));
  }

  // MARK: - Saving

  private handleTextDidChange(text: string): void {
    const note: Note | null = this.note;
    // textViewDidChange: only fires for user edits. TextArea.onChange can also fire when displayNote loads the
    // note's own text; that is no edit, and counting it made closing an untouched note save a new modificationDate.
    if (this.showHistory || (!this.modified && note !== null && text === note.content)) {
      return;
    }
    this.modified = true;
    if (note !== null) {
      NoteStore.sharedManager().updateContent(note, text);
    }
    this.interlinkProcessor?.processInterlinkLookup();
  }

  private saveIfNeeded(): void {
    if (!this.modified) {
      return;
    }
    this.save();
  }

  /// save
  private save(): void {
    const note: Note | null = this.note;
    if (note === null || this.showHistory) {
      return;
    }
    if (this.modified || note.deleted) {
      note.content = this.content;
      note.modificationDate = new Date();
      note.createPreview();
      NoteStore.sharedManager().flushPendingContent();
      NoteStore.sharedManager().save();
      SPTracker.trackEditorNoteEdited();
      this.modified = false;
    }
  }

  /// ensureEmptyNoteIsDeleted (willMove(toParent: nil) + dismissEditor:)
  private ensureEmptyNoteIsDeleted(): void {
    const note: Note | null = this.note;
    if (note === null || this.didCleanUp) {
      return;
    }
    this.didCleanUp = true;
    if (!this.isNoteBlank(note) || this.content.length > 0) {
      this.save();
      return;
    }
    NoteStore.sharedManager().trashNote(note);
  }

  /// Note.isBlank: `objectID.isTemporaryID && content.count == 0 && tagsArray.count == 0`. The port's store
  /// assigns a localID on creation, so the temporary-ID half never holds for a new note here; an editor
  /// note with no content and no tags is the blank note the source discards.
  private isNoteBlank(note: Note): boolean {
    return note.content.length === 0 && note.tagsArray.length === 0;
  }

  private saveScrollPosition(): void {
    if (this.noteKey.length === 0) {
      return;
    }
    this.editor.syncContentOffset();
    NoteScrollPositionCache.shared().store(this.editor.contentOffset.y, this.noteKey);
  }

  /// restoreScrollPosition: once per open. A search keeps its own scroll to the highlighted match.
  // ponytail: RichEditor exposes no scroll API, so the caret goes to the glyph at the bottom of the stored
  // viewport and the editor scrolls it into view during a keyboard-less focus: lands within a line.
  private restoreScrollPosition(attempt: number): void {
    if (this.didRestoreScrollPosition || this.isDisappeared || this.noteKey.length === 0 ||
      this.searchQuery.length > 0) {
      return;
    }
    if (!this.editor.isReady || this.editor.frameInWindow.height <= 0) {
      if (attempt < RESTORE_SCROLL_MAX_ATTEMPTS) {
        setTimeout((): void => this.restoreScrollPosition(attempt + 1), RESTORE_SCROLL_RETRY_MS);
      }
      return;
    }
    this.didRestoreScrollPosition = true;
    const offsetY: number | null = NoteScrollPositionCache.shared().position(this.noteKey);
    // No stored offset -> scrollToTop: the editor already opens at the top.
    if (offsetY === null || offsetY <= 0) {
      return;
    }
    // The editor lays out the note after onReady: wait one more tick before reading glyph positions.
    setTimeout((): void => this.scrollToStoredOffset(offsetY, 0), RESTORE_SCROLL_RETRY_MS);
  }

  /// Scrolls the editor to `offsetY`. A focus taken while the push transition still runs does not scroll
  /// (device: a scroll-only reopen stayed at the top), so it is checked and retried.
  private scrollToStoredOffset(offsetY: number, attempt: number): void {
    if (this.isDisappeared || this.isEditingNote) {
      return;
    }
    // The editor scrolls the caret in with one body line of margin below it (device: every reopen landed
    // exactly RESTORE_CARET_MARGIN lower), so aim one line, plus 1 vp off the line boundary, above the bottom.
    const bottom: number = offsetY + this.editor.frameInWindow.height - EDITOR_VERTICAL_INSETS -
      RESTORE_CARET_MARGIN - 1;
    const position: PositionWithAffinity = this.editor.controller.getLayoutManager()
      .getGlyphPositionAtCoordinate(0, this.getUIContext().vp2px(bottom));
    this.editor.scrollCaretIntoView(position.position);
    // contentOffset is only re-read on touch: leaving untouched must store this offset again, not 0.
    this.editor.contentOffset = new InterlinkPoint(0, offsetY);
    setTimeout((): void => {
      if (this.isDisappeared || this.isEditingNote) {
        return;
      }
      this.editor.syncContentOffset();
      if (this.editor.contentOffset.y < offsetY / 2 && attempt < RESTORE_SCROLL_MAX_ATTEMPTS / 4) {
        this.scrollToStoredOffset(offsetY, attempt + 1);
      }
    }, RESTORE_SCROLL_VERIFY_MS);
  }

  // MARK: - Keyboard

  private startListeningToKeyboardNotifications(): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    window.getLastWindow(context).then((win: window.Window): void => {
      this.keyboardWindow = win;
      this.windowHeight = this.getUIContext().px2vp(win.getWindowProperties().windowRect.height);
      win.on('keyboardHeightChange', this.keyboardListener);
    }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'keyboard listener failed: %{public}s', e.message);
    });
  }

  /// KeyboardObservable / keyboard-adjusted content insets: the editor shrinks above the keyboard and scrolls
  /// the caret into view, the nav bar stays put. The default OFFSET lifts the whole page instead, so near the
  /// bottom the caret either stayed under the keyboard or the nav bar slid under the status bar (T-0310).
  private useKeyboardAdjustedInsets(): void {
    if (this.savedKeyboardAvoidMode === undefined) {
      this.savedKeyboardAvoidMode = this.getUIContext().getKeyboardAvoidMode();
      this.getUIContext().setKeyboardAvoidMode(KeyboardAvoidMode.RESIZE_WITH_CARET);
    }
  }

  private restoreKeyboardAvoidMode(): void {
    if (this.savedKeyboardAvoidMode !== undefined) {
      this.getUIContext().setKeyboardAvoidMode(this.savedKeyboardAvoidMode);
      this.savedKeyboardAvoidMode = undefined;
    }
  }

  private stopListeningToKeyboardNotifications(): void {
    if (this.keyboardWindow !== null) {
      this.keyboardWindow.off('keyboardHeightChange', this.keyboardListener);
      this.keyboardWindow = null;
    }
  }

  /// The editor's frame above the keyboard: the interlink list is laid out in it, so it never ends up under
  /// the keyboard (UIKit's keyboard layout guide shrinks the editor instead).
  private visibleEditingRect(): InterlinkRect {
    const frame: InterlinkRect = this.editor.editingRectInWindow();
    if (this.keyboardHeight <= 0 || this.windowHeight <= 0) {
      return frame;
    }
    const bottom: number = Math.min(frame.y + frame.height, this.windowHeight - this.keyboardHeight);
    return new InterlinkRect(frame.x, frame.y, frame.width, Math.max(bottom - frame.y, 0));
  }

  private endEditing(): void {
    this.editor.endEditing();
    this.dismissTagSuggestions();
  }

  // MARK: - Bar button actions

  /// dismissEditor: popToRootViewControllerAnimated
  dismissEditor(): void {
    if (this.showHistory) {
      return;
    }
    this.endEditing();
    this.ensureEmptyNoteIsDeleted();
    router.back();
  }

  /// handleTapOnCreateNewNoteButton
  private handleTapOnCreateNewNoteButton(): void {
    this.saveIfNeeded();
    const note: Note | null = this.note;
    if (note !== null && this.isNoteBlank(note)) {
      this.editor.becomeFirstResponder();
      return;
    }
    SPTracker.trackEditorNoteCreated();
    this.presentNewNoteReplacingCurrentEditor();
  }

  /// presentNewNoteReplacingCurrentEditor — this editor is replaced by a fresh one on a blank note.
  private presentNewNoteReplacingCurrentEditor(): void {
    const params: NoteRouteParams = new NoteRouteParams();
    params.newNote = true;
    params.useSelectedTag = true;
    router.replaceUrl({ url: 'pages/SPNoteEditorViewControllerPage', params: params }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'new note failed: %{public}s', e.message);
    });
  }

  /// keyCommands' presentedViewController == nil guard
  private anySheetShown(): boolean {
    return this.showOptions || this.showHistory || this.showInformation;
  }

  /// keyCommands that keyboardShortcut cannot express: Cmd+Shift+C on Apple/Meta keyboards, Tab only while the
  /// editor is not focused (keyboardFocusOnEditor), Cmd+Return (Ctrl here) -> keyboardGoBack. True = handled.
  private handleKeyCommand(e: KeyEvent): boolean {
    if (e.type !== KeyType.Down || this.anySheetShown()) {
      return false;
    }
    if (e.keyCode === KeyCode.KEYCODE_C && e.metaKey === 1 && e.getModifierKeyState?.(['Shift']) &&
      this.isEditingNote) {
      this.insertChecklistAction();
      return true;
    }
    if (e.keyCode === KeyCode.KEYCODE_TAB && !this.isEditingNote && !e.getModifierKeyState?.(['Ctrl']) &&
      !e.getModifierKeyState?.(['Shift']) && !e.getModifierKeyState?.(['Alt'])) {
      // keyboardFocusOnEditor: caret at the beginning of the document
      this.editor.becomeFirstResponder();
      this.editor.setCaretAfterTextChange(0);
      return true;
    }
    // SPSidebarContainerViewController keyboardGoBack: the leading arrow pops back to the list, only
    // while no text view or field (note text, tag entry) has the keyboard.
    if (e.keyCode === KeyCode.KEYCODE_DPAD_LEFT && e.metaKey !== 1 &&
      !(e.getModifierKeyState?.(['Ctrl']) ?? false) && !(e.getModifierKeyState?.(['Shift']) ?? false) &&
      !(e.getModifierKeyState?.(['Alt']) ?? false) && !this.isEditingNote && !this.isKeyboardVisible) {
      this.dismissEditor();
      return true;
    }
    if ((e.keyCode === KeyCode.KEYCODE_ENTER || e.keyCode === KeyCode.KEYCODE_NUMPAD_ENTER) &&
      e.getModifierKeyState?.(['Ctrl'])) {
      this.dismissEditor();
      return true;
    }
    return false;
  }

  /// keyboardButtonAction:
  private keyboardButtonAction(): void {
    this.endEditing();
  }

  /// insertChecklistAction:
  private insertChecklistAction(): void {
    const edit: EditorTextEdit = insertOrRemoveChecklist(this.content, this.editor.selectionStart,
      this.editor.selectionEnd);
    this.content = edit.text;
    this.editor.text = edit.text;
    this.handleTextDidChange(edit.text);
    this.editor.setCaretAfterTextChange(edit.caret);
    SPTracker.trackEditorChecklistInserted();
  }

  /// noteOptionsWasPressed(_:) -> presentOptionsController(for:from:)
  presentOptionsController(): void {
    this.endEditing();
    this.save();
    this.markdownBeforeOptions = this.note !== null && this.note.markdown;
    this.showOptions = true;
    SPTracker.trackEditorActivitiesAccessed();
  }

  /// bounceMarkdownPreviewIfNeeded(note:oldMarkdownState:) — Options dismissed after turning Markdown on
  private bounceMarkdownPreviewIfNeeded(): void {
    if (this.note !== null && this.note.markdown && !this.markdownBeforeOptions) {
      this.bounceMarkdownPreview();
    }
    this.markdownBeforeOptions = this.note !== null && this.note.markdown;
  }

  /// bounceMarkdownPreview: the editor bounces left twice (40, then 20 vp) over a dimmed copy of the text on its
  /// trailing side, hinting that a swipe opens the preview.
  // ponytail: LTR only; the source mirrors the bounce for RTL.
  private bounceMarkdownPreview(): void {
    this.markdownPeek = true;
    const steps: Array<[number, number, Curve]> = [
      [-40, 250, Curve.EaseOut], [0, 250, Curve.EaseIn], [-20, 200, Curve.EaseOut], [0, 200, Curve.EaseIn]
    ];
    const run = (index: number): void => {
      if (index >= steps.length) {
        this.markdownPeek = false;
        return;
      }
      const step: [number, number, Curve] = steps[index];
      this.getUIContext().animateTo({ duration: step[1], curve: step[2], onFinish: (): void => run(index + 1) },
        (): void => {
          this.markdownBounceX = step[0];
        });
    };
    run(0);
  }

  /// presentHistoryController
  presentHistoryController(): void {
    this.ensureSearchIsDismissed();
    this.save();
    this.showOptions = false;
    this.showHistory = true;
    SPTracker.trackEditorVersionsAccessed();
  }

  // MARK: - History Delegate

  /// noteHistoryControllerDidCancel: dismiss + restoreOriginalNoteContent
  private noteHistoryControllerDidCancel(): void {
    this.historyFinished = false;
    this.showHistory = false;
  }

  /// noteHistoryControllerDidFinish: dismiss, modified = true, save
  private noteHistoryControllerDidFinish(): void {
    this.historyFinished = true;
    this.showHistory = false;
  }

  /// cardDidDismiss / dismissHistoryController -> cleanUpAfterHistoryDismissal (+ restore or save)
  private historyDidDismiss(): void {
    if (this.historyFinished) {
      this.historyFinished = false;
      this.modified = true;
      this.save();
      return;
    }
    this.restoreOriginalNoteContent();
  }

  /// updateEditor(with:) — the editor previews a version's content (not saved while history shows).
  private updateEditor(content: string): void {
    this.content = content;
    this.editor.text = content;
  }

  private restoreOriginalNoteContent(): void {
    const note: Note | null = this.note;
    if (note !== null) {
      this.updateEditor(note.content);
    }
  }

  /// noteInformationWasPressed(_:) -> presentInformationController(for:from:)
  presentInformationController(): void {
    this.showInformation = true;
  }

  /// presentMarkdownPreview -> push SPMarkdownPreviewViewController.
  presentMarkdownPreview(): void {
    const note: Note | null = this.note;
    if (note === null || !note.markdown) {
      return;
    }
    this.endEditing();
    const params: MarkdownRouteParams = new MarkdownRouteParams();
    params.noteKey = this.noteKey;
    router.pushUrl({ url: 'pages/SPMarkdownPreviewViewControllerPage', params: params }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'markdown preview failed: %{public}s', e.message);
    });
  }

  /// OptionsControllerDelegate.optionsControllerDidPressHistory: dismiss, then present the history card
  private optionsControllerDidPressHistory(): void {
    this.showOptions = false;
    setTimeout((): void => {
      this.presentHistoryController();
    }, OPTIONS_DISMISS_DELAY_MS);
  }

  /// OptionsControllerDelegate.optionsControllerDidPressShare: dismiss, then presentShareController
  private optionsControllerDidPressShare(): void {
    this.showOptions = false;
    setTimeout((): void => {
      this.presentShareController();
    }, OPTIONS_DISMISS_DELAY_MS);
  }

  /// presentShareController(for:from:) — the source's activity sheet -> the system share panel;
  /// clipboard + toast is the fallback when the panel cannot be shown.
  private presentShareController(): void {
    const note: Note | null = this.note;
    // The source's activity sheet only bails on a nil content; an empty note still shares.
    if (note === null) {
      return;
    }
    const content: string = note.content;
    try {
      const record: systemShare.SharedRecord = {
        utd: uniformTypeDescriptor.UniformDataType.PLAIN_TEXT,
        content: content
      };
      const controller: systemShare.ShareController = new systemShare.ShareController(new systemShare.SharedData(record));
      controller.on('dismiss', () => {
        hilog.info(DOMAIN, LOG_TAG, 'share panel dismissed');
      });
      const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
      controller.show(context, {
        previewMode: systemShare.SharePreviewMode.DETAIL,
        selectionMode: systemShare.SelectionMode.SINGLE
      }).then((): void => {
        SPTracker.trackEditorNoteContentShared();
      }).catch((e: Error) => {
        hilog.error(DOMAIN, LOG_TAG, 'share failed: %{public}s', e.message);
        this.copyForShareFallback(content);
      });
    } catch (e) {
      hilog.error(DOMAIN, LOG_TAG, 'share panel unavailable: %{public}s', (e as Error).message);
      this.copyForShareFallback(content);
    }
  }

  /// Fallback when the system share panel cannot be shown: copy the note and say so.
  private copyForShareFallback(content: string): void {
    const data: pasteboard.PasteData = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, content);
    pasteboard.getSystemPasteboard().setData(data).then((): void => {
      this.getUIContext().getPromptAction().showToast({ message: 'Sharing is unavailable; the note was copied instead' });
    }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'share fallback copy failed: %{public}s', e.message);
    });
  }

  /// OptionsControllerDelegate.optionsControllerDidPressTrash -> delete(note:) + dismissEditor
  private deleteNoteAndDismiss(): void {
    this.showOptions = false;
    // Wait until the Options dismiss animation concludes (animationDelayShort), then delete + dismiss.
    setTimeout((): void => {
      const note: Note | null = this.note;
      if (note !== null) {
        SPTracker.trackEditorNoteDeleted();
        NoteStore.sharedManager().trashNote(note);
      }
      this.dismissEditor();
      if (note !== null) {
        // The source's notice lives in the key window and outlives the editor. Here the toast is per
        // page, so present once the note list has re-attached its NoticeToast (onPageShow).
        // ponytail: fixed wait for the pop transition; a list-side "notice pending" hook would remove it.
        setTimeout((): void => {
          NoticeController.shared.present(NoticeFactory.noteTrashed((): void => {
            NoteStore.sharedManager().restoreNote(note);
          }));
        }, POP_TRANSITION_MS);
      }
    }, OPTIONS_DISMISS_DELAY_MS);
  }

  // MARK: - Search

  /// updateWithSearchQuery:
  private updateWithSearchQuery(text: string): void {
    const query: SearchQuery = new SearchQuery(text);
    if (text.trim().length === 0 || query.isEmpty) {
      return;
    }
    this.searchQuery = text;
    this.searchResultRanges = [];
  }

  /// highlightSearchResultsIfNeeded — once the editor has laid the note out (the match is scrolled into view).
  private highlightSearchResultsIfNeeded(attempt: number = 0): void {
    if (this.searchQuery.length === 0 || this.searchResultRanges.length > 0 || this.isDisappeared) {
      return;
    }
    if (!this.editor.isReady || this.editor.frameInWindow.height <= 0 || this.note === null) {
      if (attempt < RESTORE_SCROLL_MAX_ATTEMPTS) {
        setTimeout((): void => this.highlightSearchResultsIfNeeded(attempt + 1), RESTORE_SCROLL_RETRY_MS);
      }
      return;
    }
    const query: SearchQuery = new SearchQuery(this.searchQuery);
    this.searchResultRanges = this.searchResultRangesIn(this.content, query.keywords);
    this.searchResultCount = this.searchResultRanges.length;
    this.showSearchMap();
    this.highlightSearchResultAtIndex(0);
  }

  /// searchResultRanges(in:withKeywords:) — contentSlice(matching:).nsMatches: every matching word.
  private searchResultRangesIn(text: string, keywords: string[]): TextRange[] {
    const folded: string[] = keywords.map((keyword: string): string => fold(keyword));
    const ranges: TextRange[] = [];
    const regex: RegExp = new RegExp(WORD_PATTERN, 'g');
    let match: RegExpExecArray | null = regex.exec(text);
    while (match !== null) {
      const word: string = fold(match[0]);
      for (const keyword of folded) {
        if (keyword.length > 0 && word.indexOf(keyword) >= 0) {
          ranges.push(new TextRange(match.index, match.index + match[0].length));
          break;
        }
      }
      match = regex.exec(text);
    }
    return ranges;
  }

  /// showSearchMap(with:) — bar positions as a fraction of the text length.
  private showSearchMap(): void {
    const length: number = Math.max(this.content.length, 1);
    this.searchMapPositions = this.searchResultRanges.map((range: TextRange): number =>
      Math.max((range.lower + range.upper) / 2 / length, 0.0001));
  }

  private highlightNextSearchResult(): void {
    this.highlightSearchResultAtIndex(this.searchResultIndex + 1);
  }

  private highlightPrevSearchResult(): void {
    this.highlightSearchResultAtIndex(this.searchResultIndex - 1);
  }

  /// highlightSearchResultAtIndex:animated:
  private highlightSearchResultAtIndex(index: number): void {
    const count: number = this.searchResultRanges.length;
    if (count < 1) {
      return;
    }
    const clamped: number = Math.max(Math.min(index, count - 1), 0);
    this.searchResultIndex = clamped;
    this.editor.highlightSearchResults(this.searchResultRanges, clamped);
  }

  /// willReceiveNewContent: remember the caret and text, and put unsaved editor text into the note so Simperium
  /// rebases it over the incoming change instead of losing it. While History previews a version the editor does
  /// not hold the note's text, so nothing is written (save() skips then too).
  private willReceiveNewContent(): void {
    this.cursorLocationBeforeRemoteUpdate = this.editor.selectionStart;
    this.noteContentBeforeRemoteUpdate = this.content;
    const note: Note | null = this.note;
    if (note !== null && !this.showHistory && this.content.length > 0) {
      NoteStore.sharedManager().cancelPendingContent();
      note.content = this.content;
    }
  }

  /// didReceiveNewContent: show the merged note text and keep the caret where it was relative to the text.
  private didReceiveNewContent(): void {
    const note: Note | null = this.note;
    if (note === null) {
      return;
    }
    this.reloadTags();
    if (this.showHistory || note.content === this.content) {
      return;
    }
    const location: number = newCursorLocation(note.content, this.noteContentBeforeRemoteUpdate,
      this.cursorLocationBeforeRemoteUpdate);
    this.content = note.content;
    this.editor.text = note.content;
    this.editor.setCaretAfterTextChange(location);
  }

  /// didDeleteCurrentNote: "This note was deleted on another device" -> Accept: endSearching + dismissEditor.
  private didDeleteCurrentNote(): void {
    AlertDialog.show({
      title: $r('app.string.this_note_was_deleted_on_another_device'),
      message: '', // iOS: message nil
      autoCancel: false,
      confirm: {
        value: $r('app.string.accept'),
        action: (): void => {
          this.endSearching();
          this.showHistory = false; // dismissEditor is a no-op while history is up; iOS pops regardless
          this.dismissEditor();
        }
      }
    });
  }

  /// endSearching:
  private endSearching(): void {
    this.searchMapPositions = [];
    this.searchQuery = '';
    this.searchResultRanges = [];
    this.searchResultCount = 0;
    this.searchResultIndex = 0;
    this.editor.clearHighlights();
  }

  private ensureSearchIsDismissed(): void {
    if (this.searchQuery.length > 0) {
      this.endSearching();
    }
  }

  // MARK: - Interlinks

  private configureInterlinksProcessor(): void {
    const presenter: PopoverPresenter = this.interlinkPresenter;
    presenter.onShowController = (controller: InterlinkViewController): void => {
      this.interlinkController = controller;
      controller.onNotesChanged = (notes: Note[]): void => {
        this.interlinkMatches = notes;
        this.interlinkDataSource.reload(notes);
      };
      this.interlinkMatches = controller.notes;
      this.interlinkDataSource.reload(controller.notes);
    };
    presenter.onDismiss = (): void => {
      this.interlinkController = null;
      this.interlinkMatches = [];
    };
    const processor: InterlinkProcessor = new InterlinkProcessor(NoteStore.sharedManager(), presenter, this.editor,
      this.noteKey);
    processor.delegate = new EditorInterlinkDelegate((text: string, range: StringTextRange): void => {
      this.insertInterlink(text, range);
    });
    this.interlinkProcessor = processor;
  }

  /// InterlinkProcessorDelegate: noteEditorTextView.insertText(text:in:)
  private insertInterlink(text: string, range: StringTextRange): void {
    const updated: string = this.content.substring(0, range.start) + text + this.content.substring(range.end);
    this.content = updated;
    this.editor.text = updated;
    this.handleTextDidChange(updated);
    this.editor.setCaretAfterTextChange(range.start + text.length);
  }

  private didSelectInterlinkNote(note: Note): void {
    if (this.interlinkController !== null) {
      this.interlinkController.didSelectNote(note);
    }
  }

  // MARK: - Tags

  /// tagView(_:wantsToCreateTagWithName:)
  private createTag(tagName: string): void {
    const note: Note | null = this.note;
    if (note === null || note.hasTag(tagName)) {
      return;
    }
    if (isValidEmailAddress(tagName)) {
      AlertDialog.show({
        title: $r('app.string.collaboration_has_moved'),
        message: $r('app.string.sharing_notes_is_now_accessed_through_the_action_menu_from_t'),
        confirm: {
          value: $r('app.string.ok'),
          action: (): void => {
            hilog.info(DOMAIN, LOG_TAG, 'collaboration alert dismissed');
          }
        }
      });
      return;
    }
    this.createTagIfNotExists(tagName);
    note.addTag(tagName);
    this.reloadTags();
    this.tagListDidUpdate();
    SPTracker.trackEditorTagAdded();
    this.updateTagSuggestions();
  }

  /// tagView(_:wantsToRemoveTagWithName:)
  private removeTag(tagName: string): void {
    const note: Note | null = this.note;
    if (note === null) {
      return;
    }
    note.stripTag(tagName);
    this.deleteTagIfCreatedRecently(tagName);
    this.reloadTags();
    this.tagListDidUpdate();
    SPTracker.trackEditorTagRemoved();
    this.updateTagSuggestions();
  }

  private createTagIfNotExists(tagName: string): void {
    const store: NoteStore = NoteStore.sharedManager();
    if (store.tagExists(tagName)) {
      return;
    }
    store.createTagFromString(tagName);
    this.recentlyCreatedTag = tagName;
    if (this.recentlyCreatedTagTimer >= 0) {
      clearTimeout(this.recentlyCreatedTagTimer);
    }
    this.recentlyCreatedTagTimer = setTimeout((): void => {
      this.recentlyCreatedTagTimer = -1;
      this.recentlyCreatedTag = '';
    }, CLEAR_RECENTLY_CREATED_TAG_TIMEOUT_MS);
  }

  private deleteTagIfCreatedRecently(tagName: string): void {
    if (this.recentlyCreatedTag.length === 0 || this.recentlyCreatedTag !== tagName) {
      return;
    }
    this.recentlyCreatedTag = '';
    if (this.recentlyCreatedTagTimer >= 0) {
      clearTimeout(this.recentlyCreatedTagTimer);
      this.recentlyCreatedTagTimer = -1;
    }
    NoteStore.sharedManager().removeTagName(tagName);
  }

  /// NoteEditorTagListViewControllerDelegate.tagListDidUpdate
  private tagListDidUpdate(): void {
    this.modified = true;
    this.save();
  }

  /// tagViewDidBeginEditing / tagViewDidChange -> updateSuggestions()
  private handleTagEntryEditing(entryFieldFrame: InterlinkRect): void {
    this.updateTagSuggestions(entryFieldFrame);
  }

  /// NoteEditorTagSuggestionsViewController.update(with:) + the presenter show / relocate / dismiss.
  private updateTagSuggestions(anchor?: InterlinkRect): void {
    const keywords: string = this.tagEntryText.trim();
    const note: Note | null = this.note;
    let suggestions: string[] = [];
    if (keywords.length > 0 && note !== null) {
      const folded: string = fold(keywords);
      suggestions = NoteStore.sharedManager().tags()
        .filter((tag: Tag): boolean => !note.hasTag(tag.name) && fold(tag.name).indexOf(folded) >= 0)
        .map((tag: Tag): string => tag.name);
    }
    this.tagSuggestions = suggestions;
    this.tagSuggestionsDataSource.reload(suggestions);
    if (suggestions.length === 0) {
      this.dismissTagSuggestions();
      return;
    }
    if (anchor === undefined) {
      return;
    }
    if (this.tagPopoverPresenter.isPresented) {
      this.tagPopoverPresenter.relocate(anchor);
    } else {
      this.tagPopoverPresenter.showAround(anchor, TAG_SUGGESTIONS_DESIRED_HEIGHT);
    }
  }

  private dismissTagSuggestions(): void {
    this.tagPopoverPresenter.dismiss();
  }

  /// onSelectionCallback: the suggested tag is added through the tag view's create path.
  private didSelectTagSuggestion(tagName: string): void {
    this.tagEntryText = '';
    this.createTag(tagName);
  }

  // MARK: - Views

  /// Localised accessibility text for HmIconButton (its label is a plain string).
  private localized(res: Resource): string {
    return this.getUIContext().getHostContext()?.resourceManager.getStringSync(res) ?? '';
  }

  /// HarmonyOS title bar: back arrow on the left, symbol buttons on the right. Right items keep the source order
  /// (refreshNavigationBarButtons): (checklist), information, options, [new note | hide keyboard].
  @Builder
  navigationBar() {
    Row() {
      HmIconButton({
        buttonId: 'note_editor_back',
        symbol: $r('sys.symbol.arrow_left'),
        label: 'Back',
        action: (): void => this.dismissEditor()
      })

      Blank()

      Row({ space: 8 }) {
        if (this.isEditingNote) {
          HmIconButton({
            buttonId: 'note_editor_checklist',
            symbol: $r('sys.symbol.list_checkmark'),
            label: this.localized($r('app.string.inserts_a_new_checklist_item')),
            action: (): void => this.insertChecklistAction()
          })
        }
        HmIconButton({
          buttonId: 'note_editor_information',
          symbol: $r('sys.symbol.info_circle'),
          label: this.localized($r('app.string.information')),
          action: (): void => this.presentInformationController()
        })
        HmIconButton({
          buttonId: 'note-menu',
          symbol: $r('sys.symbol.dot_grid_2x2'),
          label: this.localized($r('app.string.menu')),
          action: (): void => this.presentOptionsController()
        })
        if (!this.isKeyboardVisible) {
          HmIconButton({
            buttonId: 'note_editor_new_note',
            symbol: $r('sys.symbol.square_and_pencil'),
            label: this.localized($r('app.string.new_note')),
            action: (): void => this.handleTapOnCreateNewNoteButton()
          })
        } else {
          // No keyboard-dismiss symbol exists in sys.symbol; chevron_down reads as "lower the keyboard".
          HmIconButton({
            buttonId: 'note_editor_hide_keyboard',
            symbol: $r('sys.symbol.chevron_down'),
            label: this.localized($r('app.string.dismiss_keyboard')),
            action: (): void => this.keyboardButtonAction()
          })
        }
      }
    }
    .width('100%')
    .height(56)
    .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16) })
    .backgroundColor($r('sys.color.background_primary'))
  }

  /// configureSearchToolbar: '%d Results', previous / next, Done, as a HarmonyOS bottom bar
  @Builder
  searchToolbar() {
    Row({ space: 8 }) {
      Text(this.searchResultCount === 1 ? $r('app.string.d_result', this.searchResultCount) :
        $r('app.string.d_results', this.searchResultCount))
        .fontSize($r('sys.float.Body_M'))
        .fontColor($r('sys.color.font_secondary'))
        .layoutWeight(1)
      HmIconButton({
        buttonId: 'note_editor_search_previous',
        symbol: $r('sys.symbol.chevron_up'),
        label: this.localized($r('app.string.previous_match')),
        isEnabled: this.searchResultIndex > 0,
        action: (): void => this.highlightPrevSearchResult()
      })
      HmIconButton({
        buttonId: 'note_editor_search_next',
        symbol: $r('sys.symbol.chevron_down'),
        label: this.localized($r('app.string.next_match')),
        isEnabled: this.searchResultIndex < this.searchResultCount - 1,
        action: (): void => this.highlightNextSearchResult()
      })
      HmIconButton({
        buttonId: 'note_editor_search_done',
        symbol: $r('sys.symbol.checkmark'),
        label: this.localized($r('app.string.done')),
        action: (): void => this.endSearching()
      })
    }
    .width('100%')
    .height(56)
    .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16) })
    .backgroundColor($r('sys.color.background_primary'))
    .border({ width: { top: 0.5 }, color: { top: $r('sys.color.comp_divider') } })
  }

  /// InterlinkViewController: one Value1 row per matching note title
  @Builder
  interlinkList() {
    List() {
      LazyForEach(this.interlinkDataSource, (note: Note) => {
        ListItem() {
          Text(note.titlePreview ?? '')
            .width('100%')
            .fontSize($r('sys.float.Body_L'))
            .fontColor($r('sys.color.font_primary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .constraintSize({ minHeight: 48 })
        .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16) })
        .width('100%')
        .id('interlink_itemroot')
        // The row's note, not its index: a key-reused LazyForEach item keeps the index it was built with, so
        // after the results reorder an index picked the wrong note (device: tapping R3 link A inserted B).
        .onClick((): void => {
          this.didSelectInterlinkNote(note);
        })
      }, (note: Note): string => note.simperiumKey)
    }
    .width('100%')
    .divider({
      strokeWidth: 0.5,
      color: $r('sys.color.comp_divider'),
      startMargin: 16,
      endMargin: 16
    })
  }

  /// NoteEditorTagSuggestionsViewController: one Value1 row per matching tag
  @Builder
  tagSuggestionsList() {
    List() {
      LazyForEach(this.tagSuggestionsDataSource, (tagName: string) => {
        ListItem() {
          Text(tagName)
            .width('100%')
            .fontSize($r('sys.float.Body_L'))
            .fontColor($r('sys.color.font_primary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .constraintSize({ minHeight: 48 })
        .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16) })
        .id('tag_suggestions_itemroot')
        .onClick((): void => {
          this.didSelectTagSuggestion(tagName);
        })
      }, (tagName: string): string => tagName)
    }
    .width('100%')
    .divider({
      strokeWidth: 0.5,
      color: $r('sys.color.comp_divider'),
      startMargin: 16,
      endMargin: 16
    })
  }

  @Builder
  optionsSheet() {
    OptionsViewController({
      note: $note,
      onHistory: (): void => {
        this.optionsControllerDidPressHistory();
      },
      onShare: (): void => {
        this.optionsControllerDidPressShare();
      },
      onDismiss: (): void => {
        this.showOptions = false;
      },
      onTrash: (): void => {
        this.deleteNoteAndDismiss();
      }
    })
  }

  @Builder
  historySheet() {
    SPNoteHistoryViewController({
      note: $note,
      onCancel: (): void => {
        this.noteHistoryControllerDidCancel();
      },
      onFinish: (): void => {
        this.noteHistoryControllerDidFinish();
      },
      onSelectVersion: (content: string): void => {
        this.updateEditor(content);
      }
    })
  }

  @Builder
  informationSheet() {
    NoteInformationViewController({
      note: $note,
      onDismiss: (): void => {
        this.showInformation = false;
      }
    })
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      Column() {
        Column() {
          this.navigationBar()

          // bounceMarkdownPreview: the editor and a dimmed fake preview, clipped to the editor area
          Stack({ alignContent: Alignment.TopStart }) {
          // noteEditorTextView + the search map on its trailing edge
          Stack({ alignContent: Alignment.TopEnd }) {
            SPEditorTextView({
              text: $content,
              editor: this.editor,
              onTextDidChange: (text: string): void => {
                this.handleTextDidChange(text);
              },
              onEditingChange: (isEditing: boolean): void => {
                this.isEditingNote = isEditing;
                if (isEditing) {
                  this.ensureSearchIsDismissed();
                } else {
                  this.interlinkProcessor?.dismissInterlinkLookup();
                  this.save();
                }
              },
              onSelectionDidChange: (): void => {
                this.interlinkProcessor?.processInterlinkLookup();
              },
              onContentOffsetChange: (offsetY: number): void => {
                this.interlinkProcessor?.refreshInterlinkControllerWithNewOffset(this.editor.contentOffset, true);
              }
            })
            if (this.searchQuery.length > 0 && this.searchMapPositions.length > 0) {
              SearchMapView({
                positions: this.searchMapPositions,
                onSelectionChange: (index: number): void => {
                  this.highlightSearchResultAtIndex(index);
                }
              })
                .width(SEARCH_MAP_WIDTH)
                .height('100%')
            }
          }
          .width('100%')
          .height('100%')
          .translate({ x: this.markdownBounceX })

            if (this.markdownPeek) {
              // fakeMarkdownPreviewSnapshot: the plain text, dimmed, one editor width to the trailing side at the
              // editor's scroll offset (the source snapshots the visible text view)
              Column() {
                Text(this.content)
                  .width('100%')
                  .opacity(0.3)
                  .fontSize(17)
                  .padding({ left: 16, right: 16, top: 8 })
                  .translate({ y: -this.editor.contentOffset.y })
              }
              .width('100%')
              .height('100%')
              .clip(true)
              .offset({ x: '100%' })
              .translate({ x: this.markdownBounceX })
            }
          }
          .width('100%')
          .layoutWeight(1)
          .clip(true)

          // tagListViewController.view (floating tag bar)
          NoteEditorTagListViewController({
            tagNames: this.tags,
            addTagFieldText: $tagEntryText,
            onCreateTag: (tagName: string): void => {
              this.createTag(tagName);
            },
            onRemoveTag: (tagName: string): void => {
              this.removeTag(tagName);
            },
            onEditing: (entryFieldFrame: InterlinkRect): void => {
              this.handleTagEntryEditing(entryFieldFrame);
            }
          })

          // navigationController toolbar (search mode only)
          if (this.searchQuery.length > 0) {
            this.searchToolbar()
          }
        }
        .width('100%')
        .height('100%')
        .bindSheet($$this.showInformation, this.informationSheet(), {
          showClose: false,
          // SPCardPresentationController: content-sized card with the system drag bar
          height: SheetSize.FIT_CONTENT,
          dragBar: true,
          maskColor: $r('app.color.simplenote_dimming'),
          backgroundColor: $r('sys.color.background_secondary')
        })
      }
      .width('100%')
      .height('100%')
      .bindSheet($$this.showHistory, this.historySheet(), {
        showClose: false,
        height: SheetSize.FIT_CONTENT,
        dragBar: false,
        maskColor: $r('app.color.simplenote_dimming'),
        backgroundColor: $r('app.color.simplenote_card_background'),
        onDisappear: (): void => {
          this.historyDidDismiss();
        }
      })

      // PopoverPresenter containers (interlink autocomplete / tag suggestions)
      if (this.interlinkLayout !== null) {
        Popover({
          left: (this.interlinkLayout as PopoverLayout).left,
          top: (this.interlinkLayout as PopoverLayout).top,
          maxHeight: (this.interlinkLayout as PopoverLayout).maxHeight
        }) {
          this.interlinkList()
        }
      }
      if (this.tagSuggestionsLayout !== null) {
        Popover({
          left: (this.tagSuggestionsLayout as PopoverLayout).left,
          top: (this.tagSuggestionsLayout as PopoverLayout).top,
          maxHeight: (this.tagSuggestionsLayout as PopoverLayout).maxHeight
        }) {
          this.tagSuggestionsList()
        }
      }

      NoticeToast({ active: this.pageVisible })
    }
    .id('screen_note_editor')
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.simplenote_background'))
    // parallelGesture: the TextArea child consumes plain .gesture() swipes (device review T-0126)
    .parallelGesture(
      // SPInteractivePushPopAnimationController is only active for a markdown note
      SwipeGesture({
        direction: (this.note !== null && this.note.markdown) ? SwipeDirection.Horizontal : SwipeDirection.None
      })
        .onAction((event: GestureEvent): void => {
          // SPInteractivePushPopAnimationController: swipe toward the leading edge pushes the preview
          if (event.angle > 90 || event.angle < -90) {
            this.presentMarkdownPreview();
          }
        })
    )
    // keyCommands: Cmd maps to Ctrl (ModifierKey has no Cmd); all are nil while a sheet is presented.
    // Cmd+Shift+C as on iOS for Apple/Meta keyboards: keyboardShortcut has no Meta modifier, but the key
    // event carries it (T-0121 device check). Cmd+N cannot follow: HarmonyOS keeps Meta+N for the
    // notification panel, so Ctrl+N stays the new-note shortcut.
    .onKeyEvent((e: KeyEvent): boolean => this.handleKeyCommand(e))
    // Ctrl+Return reaches the editor's input method first, which would type a newline.
    .onKeyPreIme((e: KeyEvent): boolean => this.handleKeyCommand(e))
    .keyboardShortcut('n', [ModifierKey.CTRL], () => {
      if (!this.anySheetShown()) {
        this.presentNewNoteReplacingCurrentEditor();
      }
    })
    .keyboardShortcut('c', [ModifierKey.CTRL, ModifierKey.SHIFT], () => {
      if (!this.anySheetShown() && this.isEditingNote) {
        this.insertChecklistAction();
      }
    })
    // keyboardToggleMarkdownPreview (markdown notes only)
    .keyboardShortcut('p', [ModifierKey.CTRL, ModifierKey.SHIFT], () => {
      if (!this.anySheetShown() && this.note !== null && this.note.markdown) {
        this.presentMarkdownPreview();
      }
    })
    // keyboardHighlightNextMatch / keyboardHighlightPrevMatch (while searching)
    .keyboardShortcut('g', [ModifierKey.CTRL], () => {
      if (!this.anySheetShown() && this.searchQuery.length > 0) {
        this.highlightNextSearchResult();
      }
    })
    .keyboardShortcut('g', [ModifierKey.CTRL, ModifierKey.SHIFT], () => {
      if (!this.anySheetShown() && this.searchQuery.length > 0) {
        this.highlightPrevSearchResult();
      }
    })
    .bindSheet($$this.showOptions, this.optionsSheet(), {
      onDisappear: (): void => {
        this.bounceMarkdownPreviewIfNeeded();
      },
      showClose: false,
      dragBar: true,
      backgroundColor: $r('sys.color.background_secondary')
    })
  }
}

/// SPNoteEditorViewController newCursorLocation:oldText:currentLocation:. Text added/removed only before the
/// caret moves it by the length delta; only after it, or on both sides, leaves it; text cut short puts it at the end.
export function newCursorLocation(newText: string, oldText: string, location: number): number {
  if (newText.length < location) {
    return newText.length;
  }
  const deltaLength: number = newText.length - oldText.length;
  // NSString substring* throws out of range (caught on iOS -> no match); JS would clamp instead.
  if (location > oldText.length || location + deltaLength < 0) {
    return location;
  }
  const beforeCursorMatches: boolean = oldText.substring(0, location) === newText.substring(0, location);
  const afterCursorMatches: boolean = oldText.substring(location) === newText.substring(location + deltaLength);
  return !beforeCursorMatches && afterCursorMatches ? location + deltaLength : location;
}
