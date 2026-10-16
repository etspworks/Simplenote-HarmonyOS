// Port of SPNoteListViewController (root of the app's navigation stack) — S2 shell: presentation + navigation.
// It is also the DeepLinkPresenter (SPAppDelegate's presentation methods) and the host of the app-level
// presentations the source makes over the list: onboarding (Simperium login UI), the PIN lock and the
// account-verification prompt.
import { display, LengthMetrics, promptAction, router, SymbolGlyphModifier, UIObserver, uiObserver } from '@kit.ArkUI';
import { common, Want } from '@kit.AbilityKit';
import { BusinessError, emitter } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { KeyCode } from '@kit.InputKit';
import { systemShare } from '@kit.ShareKit';
import { uniformTypeDescriptor } from '@kit.ArkData';
import { productViewManager } from '@kit.StoreKit';
import { DeepLinkPresenter, ShortcutsHandler } from '../common/DeepLinkRouter';
import { SessionEvent, SessionKeys, SessionStore } from '../common/SessionStore';
import { SPPinLockManager } from '../common/PinLockManager';
import { Note, noteStructure } from '../model/Note';
import { Tag } from '../model/Tag';
import { SortMode } from '../model/SortMode';
import { Notice } from '../model/Notice';
import { ArrayDataSource } from '../common/ArrayDataSource';
import { formatListDate } from '../common/DateFormatters';
import { copyInternalLink } from '../common/NotePasteboard';
import { NoteStore } from '../common/NoteStore';
import { Options, OptionsEvent } from '../common/OptionsStore';
import { NoticeController, NoticeFactory } from '../common/NoticeCenter';
import { RatingsService } from '../common/RatingsService';
import { SPTracker } from '../common/Tracker';
import {
  ListFilter,
  ListFilterKind,
  ListObject,
  ListSearchQuery,
  NotesListController,
  NotesListMode,
  NotesListSection,
  SearchItemKind,
  SIMPLENOTE_TRASH_KEY
} from '../common/NotesListController';
import { HmIconButton } from '../components/HmIconButton';
import { SPNoteTableViewCell } from '../components/NoteRow';
import { NoticeToast } from '../components/NoticeToast';
import { SPPlaceholderView, PlaceholderImage, PlaceholderMode } from '../components/SPPlaceholderView';
import { SPRatingsPromptView } from '../components/RatingsPrompt';
import { SearchDisplayController } from '../components/SearchBar';
import { InAppBrowserSheet } from '../components/InAppBrowserSheet';
import { SPSectionHeaderView } from '../components/SectionHeader';
import { SIDEBAR_VISIBLE_KEY, SPSidebarContainerViewController } from '../components/SidebarContainer';
import { SPTagTableViewCell } from '../components/TagSearchRow';
import { TagListKeyController, TagListViewController } from './TagListViewControllerPage';
import { AccountVerificationRouteParams, VerificationConfiguration } from './AccountVerificationViewControllerPage';

const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'NoteList';

const NOTE_LIST_URL: string = 'pages/SPNoteListViewControllerPage';
const NOTE_EDITOR_URL: string = 'pages/SPNoteEditorViewControllerPage';
const SETTINGS_URL: string = 'pages/SPSettingsViewControllerPage';
const TAG_LIST_URL: string = 'pages/TagListViewControllerPage';

/// Router params the pages of this app read.
export class NoteRouteParams {
  noteKey: string = '';
  newNote: boolean = false;
  useSelectedTag: boolean = false;
  overlay: string = '';
  /// The list's active search text, carried into the editor's keyword highlight
  /// (editor.updateWithSearchQuery). Empty when not searching / ignoringSearchQuery.
  searchQuery: string = '';
}

export class PinLockRouteParams {
  mode: string = 'verify';
}

/// A targetPage resolved to a routed page and, for an overlay screen, the overlay its host opens.
class ResolvedTarget {
  url: string = '';
  overlay: string = '';
}

/// Screen id / source class name -> routeUrl (plan routeTable). Overlays resolve to their host page.
const ROUTES: Map<string, string> = new Map<string, string>([
  ['screen_note_list', NOTE_LIST_URL],
  ['screen_note_editor', NOTE_EDITOR_URL],
  ['screen_account_verification', 'pages/AccountVerificationViewControllerPage'],
  ['screen_onboarding', 'pages/SPOnboardingViewControllerPage'],
  ['screen_pin_lock', 'pages/PinLockViewControllerPage'],
  ['screen_markdown_preview', 'pages/SPMarkdownPreviewViewControllerPage'],
  ['screen_auth', 'pages/SPAuthViewControllerPage'],
  ['screen_add_collaborators', 'pages/SPAddCollaboratorsViewControllerPage'],
  ['screen_settings', 'pages/SPSettingsViewControllerPage'],
  ['screen_signup_verification', 'pages/SignupVerificationViewControllerPage'],
  ['screen_tag_list', 'pages/TagListViewControllerPage'],
  ['screen_about', 'pages/SPAboutViewControllerPage'],
  ['screen_privacy', 'pages/SPPrivacyViewControllerPage'],
  ['screen_sort_order', 'pages/SPSortOrderViewControllerPage'],
  ['screen_theme', 'pages/SPThemeViewControllerPage']
]);

/// Overlay screens (sheets) -> [host routeUrl, overlay key the host opens].
const OVERLAYS: Map<string, string[]> = new Map<string, string[]>([
  ['screen_note_history', [NOTE_EDITOR_URL, 'history']],
  ['SPNoteHistoryViewController', [NOTE_EDITOR_URL, 'history']],
  ['screen_note_information', [NOTE_EDITOR_URL, 'information']],
  ['NoteInformationViewController', [NOTE_EDITOR_URL, 'information']],
  ['screen_note_options', [NOTE_EDITOR_URL, 'options']],
  ['OptionsViewController', [NOTE_EDITOR_URL, 'options']],
  ['screen_diagnostics', ['pages/SPAuthViewControllerPage', 'diagnostics']],
  ['SPDiagnosticsViewController', ['pages/SPAuthViewControllerPage', 'diagnostics']],
  ['screen_magic_link_invalid', ['pages/SPOnboardingViewControllerPage', 'magicLinkInvalid']],
  ['MagicLinkInvalidView', ['pages/SPOnboardingViewControllerPage', 'magicLinkInvalid']]
]);

/// Screens the source presents ON TOP of onboarding (pushed FROM SPOnboardingViewController), not gated
/// by it: SPAuthViewController, its signup-verification follow-on, and the diagnostics overlay it hosts.
/// A deep link straight into one of these while signed out must still show onboarding underneath it.
const PRE_AUTH_TARGET_URLS: Set<string> = new Set<string>([
  'pages/SPAuthViewControllerPage',
  'pages/SignupVerificationViewControllerPage'
]);

/// Screens the source only reaches FROM SPSettingsViewController (pushed, or presented for the PIN lock):
/// a deep link to one of them must put Settings underneath so Back / Done / Cancel returns to Settings.
const SETTINGS_CHILD_URLS: Set<string> = new Set<string>([
  'pages/SPAboutViewControllerPage',
  'pages/SPPrivacyViewControllerPage',
  'pages/SPThemeViewControllerPage',
  'pages/SPSortOrderViewControllerPage',
  'pages/PinLockViewControllerPage'
]);

/// Screens the source only reaches FROM the note editor (presentMarkdownPreview; collaborators via its
/// options sheet): a deep link must push the editor, on a real note, underneath them.
const EDITOR_CHILD_URLS: Set<string> = new Set<string>([
  'pages/SPMarkdownPreviewViewControllerPage',
  'pages/SPAddCollaboratorsViewControllerPage'
]);

/// The first note of the list as the list currently shows it (selected tag filter + sort mode) — the note
/// the source gallery opened the editor and its children on. Empty when the list is empty.
async function firstListedNoteKey(): Promise<string> {
  const store: NoteStore = NoteStore.sharedManager();
  await store.whenReady();
  const controller: NotesListController = new NotesListController(store);
  try {
    controller.filter = ListFilter.fromSelectedTag(SessionStore.shared().selectedTag);
    controller.sortMode = Options.shared.listSortMode;
    controller.performFetch();
    const notes: Note[] = controller.notes;
    return notes.length > 0 ? notes[0].simperiumKey : '';
  } finally {
    controller.destroy();
  }
}

function pushTarget(url: string, params: NoteRouteParams, page: string): Promise<void> {
  return router.pushUrl({ url: url, params: params }).catch((e: Error) => {
    hilog.error(DOMAIN, LOG_TAG, 'targetPage %{public}s failed: %{public}s', page, e.message);
  });
}

/// Accepts a screen id, a routeUrl, a page name (`XPage`) or a source class name (`X`).
function resolveTargetPage(page: string): ResolvedTarget {
  const out: ResolvedTarget = new ResolvedTarget();
  const overlay: string[] | undefined = OVERLAYS.get(page);
  if (overlay !== undefined) {
    out.url = overlay[0];
    out.overlay = overlay[1];
    return out;
  }
  const routed: string | undefined = ROUTES.get(page);
  if (routed !== undefined) {
    out.url = routed;
    return out;
  }
  if (page.startsWith('pages/')) {
    out.url = page;
    return out;
  }
  const name: string = page.endsWith('Page') ? page.substring(0, page.length - 4) : page;
  out.url = 'pages/' + name + 'Page';
  return out;
}

/// SPAppDelegate's presentation methods, driven by ShortcutsHandler routes.
class NoteListPresenter implements DeepLinkPresenter {
  private readonly onSearch: () => void;
  private readonly onOpenPreAuthTarget: (url: string, params: NoteRouteParams, page: string) => void;

  constructor(onSearch: () => void, onOpenPreAuthTarget: (url: string, params: NoteRouteParams, page: string) => void) {
    this.onSearch = onSearch;
    this.onOpenPreAuthTarget = onOpenPreAuthTarget;
  }

  presentNewNoteEditor(useSelectedTag: boolean): void {
    const params: NoteRouteParams = new NoteRouteParams();
    params.newNote = true;
    params.useSelectedTag = useSelectedTag;
    performActionAfterUnlock((): void => {
      popToList();
      pushEditor(params);
    });
  }

  presentSearch(): void {
    performActionAfterUnlock((): void => {
      popToList();
      this.onSearch();
    });
  }

  presentNoteWithSimperiumKey(simperiumKey: string): void {
    const params: NoteRouteParams = new NoteRouteParams();
    params.noteKey = simperiumKey;
    performActionAfterUnlock((): void => {
      popToList();
      pushEditor(params);
    });
  }

  /// SPAppDelegate.presentNote: popToNoteList, then open the note over the list.
  presentNote(note: Note): void {
    const params: NoteRouteParams = new NoteRouteParams();
    params.noteKey = note.simperiumKey;
    performActionAfterUnlock((): void => {
      popToList();
      pushEditor(params);
    });
  }

  popToNoteList(): void {
    performActionAfterUnlock((): void => {
      popToList();
    });
  }

  openTargetPage(page: string): void {
    const target: ResolvedTarget = resolveTargetPage(page);
    if (target.url === NOTE_LIST_URL) {
      return;
    }
    const params: NoteRouteParams = new NoteRouteParams();
    params.overlay = target.overlay;
    // Signed out and the target lives ABOVE onboarding in the source (pushed FROM it) -> onboarding
    // must sit under it, not be skipped: list -> onboarding -> target.
    if (AppStorage.get<boolean>(SessionKeys.AUTHENTICATED) === false && PRE_AUTH_TARGET_URLS.has(target.url)) {
      this.onOpenPreAuthTarget(target.url, params, page);
      return;
    }
    // TagListViewController lives in the list's sidebar (SPSidebarContainerViewController): open it there,
    // over the list, rather than as a page of its own.
    if (target.url === TAG_LIST_URL) {
      AppStorage.setOrCreate<boolean>(SIDEBAR_VISIBLE_KEY, true);
      return;
    }
    if (SETTINGS_CHILD_URLS.has(target.url)) {
      pushTarget(SETTINGS_URL, new NoteRouteParams(), page).then((): void => {
        pushTarget(target.url, params, page);
      });
      return;
    }
    if (target.url === NOTE_EDITOR_URL || EDITOR_CHILD_URLS.has(target.url)) {
      firstListedNoteKey().then((noteKey: string): void => {
        params.noteKey = noteKey;
        if (target.url === NOTE_EDITOR_URL) {
          pushTarget(NOTE_EDITOR_URL, params, page);
          return;
        }
        const editorParams: NoteRouteParams = new NoteRouteParams();
        editorParams.noteKey = noteKey;
        pushTarget(NOTE_EDITOR_URL, editorParams, page).then((): void => {
          pushTarget(target.url, params, page);
        });
      });
      return;
    }
    pushTarget(target.url, params, page);
  }
}

/// A run of preview text; `link` runs are tinted like UITextView's detected links.
class PreviewRun {
  text: string = '';
  link: boolean = false;
}

/// dataDetectorTypes = UIDataDetectorTypeAll stand-in, same pattern as EditorTextView.linkRanges: splits
/// `text` into plain and http(s)/simplenote:// URL runs (trailing punctuation stays plain).
function previewRuns(text: string): PreviewRun[] {
  const runs: PreviewRun[] = [];
  const regex: RegExp = new RegExp('(https?|simplenote)://[^\\s<>"]+', 'gi');
  let last: number = 0;
  let match: RegExpExecArray | null = regex.exec(text);
  while (match !== null) {
    const url: string = match[0].replace(new RegExp('[.,;:!?)]+$'), '');
    if (match.index > last) {
      runs.push({ text: text.substring(last, match.index), link: false });
    }
    runs.push({ text: url, link: true });
    last = match.index + url.length;
    match = regex.exec(text);
  }
  if (last < text.length) {
    runs.push({ text: text.substring(last), link: false });
  }
  return runs;
}

/// SPAppDelegate.performActionAfterUnlock. The lock is a page in the router stack here (not a window over
/// it), so popping or pushing under it is impossible: hold the action until the lock page goes away.
let pendingUnlockAction: (() => void) | null = null;

function performActionAfterUnlock(action: () => void): void {
  if (isPresentingPasscodeLock() && SPPinLockManager.shared.isEnabled) {
    pendingUnlockAction = action;
    return;
  }
  action();
}

/// Called once the verify lock page has been popped (unlocked, or dismissed within the Lock Timeout).
export function runActionAfterUnlock(): void {
  const action: (() => void) | null = pendingUnlockAction;
  pendingUnlockAction = null;
  if (action !== null) {
    action();
  }
}

/// SPAppDelegate.popToNoteList: hide the sidebar, back to the list page wherever it sits in the stack.
function popToList(): void {
  AppStorage.setOrCreate<boolean>(SIDEBAR_VISIBLE_KEY, false);
  if (router.getState().name !== 'SPNoteListViewControllerPage') {
    router.back({ url: NOTE_LIST_URL });
  }
}

/// SPAppDelegate.isPresentingPasscodeLock: the verify lock page is on top.
function isPresentingPasscodeLock(): boolean {
  if (router.getState().name !== 'PinLockViewControllerPage') {
    return false;
  }
  const params: PinLockRouteParams | undefined = router.getParams() as PinLockRouteParams | undefined;
  return params !== undefined && params !== null && params.mode === 'verify';
}

/// openNote:ignoringSearchQuery:animated: -> push the editor over the list.
function pushEditor(params: NoteRouteParams): void {
  router.pushUrl({ url: 'pages/SPNoteEditorViewControllerPage', params: params }).catch((e: Error) => {
    hilog.error(DOMAIN, LOG_TAG, 'open editor failed: %{public}s', e.message);
  });
}

/// One rendered row of the notes list: the table's sections flattened (section header, tag row, note row).
enum RowKind {
  NOTE = 0,
  TAG = 1,
  HEADER = 2
}

class ListRow {
  kind: RowKind = RowKind.NOTE;
  key: string = '';
  note: Note | null = null;
  tag: Tag | null = null;
  title: string = '';
  body: string = '';
  prefix: string = '';
  pinned: boolean = false;
  published: boolean = false;
  /// searchQuery?.keywords, highlighted in the row (cell.keywords).
  keywords: string[] = [];
}

/// Search debounce (searchDisplayController:updateSearchResults:).
const SEARCH_DELAY_MS: number = 200;
const SIMPLENOTE_FEEDBACK_MAIL: string = 'not.required@not.required.com';
/// SPCredentials.simplenoteFeedbackURL (SPFeedbackManager's Safari fallback when mail is unavailable).
const SIMPLENOTE_FEEDBACK_URL: string = 'https://not.required';
/// iOS Trash list: the first row sits ~22pt below the bar (search bar hidden; plain UITableView's
/// default sectionHeaderTopPadding). Measured on device in review-dev-3.
const TRASH_TOP_INSET: number = 22;
/// HarmonyOS list side margin: the note row's text inset and the divider inset.
const LIST_SIDE_MARGIN: number = 16;
/// SPNoteTableViewCell.separatorInsets: the divider starts under the labels (6 + 16 pin column + 6).
const NOTE_LABEL_INSET: number = 28;
/// Swipe actions: 40vp round symbol buttons, 8vp apart.
const SWIPE_BUTTON_SIZE: number = 40;
const SWIPE_BUTTON_GAP: number = 8;

@Entry
@Component
struct SPNoteListViewControllerPage {
  @StorageProp('authenticated') authenticated: boolean = true;
  /// SPAppDelegate.selectedTag, written by the tag sidebar (svc_session).
  @Watch('selectedTagDidChange') @StorageLink('selectedTag') selectedTag: string = '';
  /// Tag sidebar visibility (SPSidebarContainerViewController's SIDEBAR_VISIBLE_KEY), also written by the sidebar.
  @Watch('sidebarVisibleDidChange') @StorageLink('sidebarVisible') sidebarVisible: boolean = false;
  /// Mirror of sidebarVisible bound to SPSidebarContainerViewController's showSideBar.
  @Watch('showSidebarDidChange') @State showSidebar: boolean = false;
  /// Simperium bucketWillStartIndexing / bucketDidFinishIndexing.
  @Watch('notesWaitingForIndexDidChange') @StorageProp('notesWaitingForIndex') notesWaitingForIndex: boolean = false;
  /// Mirror of notesWaitingForIndex read by the placeholder logic.
  @State isIndexing: boolean = false;
  @StorageProp('bSigningUserOut') @Watch('indexingDidChange') signingUserOut: boolean = false;
  @StorageProp('firstLaunch') firstLaunch: boolean = false;
  /// SearchDisplayController.active
  @State searchActive: boolean = false;
  /// SPFeedbackManager's SFSafariViewController fallback, shown in InAppBrowserSheet.
  @State showFeedbackWebPage: boolean = false;
  @State searchText: string = '';
  /// NotesListController.state (results | searching)
  @State listState: NotesListMode = NotesListMode.RESULTS;
  @State sections: NotesListSection[] = [];
  @State numberOfObjects: number = 0;
  @State isEditing: boolean = false;
  @State selectedKeys: string[] = [];
  /// Options.condensedNotesList, mirrored into AppStorage by the options listener below.
  @StorageProp('condensedNotesList') condensed: boolean = false;
  /// Options.listSortMode, mirrored into AppStorage by update().
  @StorageProp('listSortMode') sortMode: SortMode = SortMode.MODIFIED_NEWEST;
  @State filterTitle: string = 'All Notes';
  @State showRatingsPrompt: boolean = false;
  @State placeholderMode: PlaceholderMode = PlaceholderMode.GENERIC;
  @State placeholderImage: PlaceholderImage = PlaceholderImage.ALL_NOTES;
  @State placeholderText: string = '';
  @State placeholderActionText: string = '';
  /// UIToolbar scrollEdgeAppearance: the editing toolbar is transparent while the list's end is on screen.
  @State listAtEnd: boolean = true;
  @State pageVisible: boolean = true;
  /// tableView.indexPathForSelectedRow while navigating with the keyboard: the selected row's identity
  /// (ListRow.key without its generation prefix), '' for none.
  @State keyboardSelection: string = '';
  /// navigatingUsingKeyboard: a note opened from the keyboard keeps its selection when the list shows again.
  private navigatingUsingKeyboard: boolean = false;
  /// searchBar.isFirstResponder
  private searchFieldEditing: boolean = false;
  private tagListKeys: TagListKeyController = new TagListKeyController();
  private dataSource: ArrayDataSource<ListRow> = new ArrayDataSource<ListRow>([]);
  private generation: number = 0;
  private notesListController: NotesListController | null = null;
  private searchTimer: number = -1;
  private scroller: ListScroller = new ListScroller();
  private onboardingPresented: boolean = false;
  /// The account verified while a page (the PIN lock) sat above the verification screen.
  private verificationDismissPending: boolean = false;
  private authRequiredListener: ((data: emitter.EventData) => void) | null = null;
  private authDismissedListener: ((data: emitter.EventData) => void) | null = null;
  private condensedListener: ((data: emitter.EventData) => void) | null = null;
  private sortModeListener: ((data: emitter.EventData) => void) | null = null;

  aboutToAppear(): void {
    const required: (data: emitter.EventData) => void = (data: emitter.EventData): void => {
      this.presentOnboarding();
    };
    const dismissed: (data: emitter.EventData) => void = (data: emitter.EventData): void => {
      this.onboardingPresented = false;
    };
    this.authRequiredListener = required;
    this.authDismissedListener = dismissed;
    emitter.on(SessionEvent.AUTHENTICATION_REQUIRED, required);
    emitter.on(SessionEvent.AUTHENTICATION_DISMISSED, dismissed);
    SessionStore.shared().hooks.showPasscodeLockIfNecessary = (): void => {
      this.showPasscodeLockIfNecessary();
    };
    SessionStore.shared().hooks.dismissPasscodeLockIfPossible = (): void => {
      this.dismissPasscodeLockIfPossible();
    };
    // [self.window isKeyWindow]: never refresh the last-used time while the lock is on top,
    // or backgrounding the lock and coming straight back would dismiss it without the passcode.
    SessionStore.shared().hooks.storeLastUsedTime = (): void => {
      if (!isPresentingPasscodeLock()) {
        SPPinLockManager.shared.storeLastUsedTime();
      }
    };
    SessionStore.shared().hooks.showVerificationViewController = (): void => {
      this.showVerificationViewController();
    };
    SessionStore.shared().hooks.dismissVerificationViewController = (): void => {
      this.dismissVerificationViewController();
    };
    ShortcutsHandler.shared.attachPresenter(new NoteListPresenter(
      (): void => {
        this.startSearching();
      },
      (url: string, params: NoteRouteParams, page: string): void => {
        this.openPreAuthTarget(url, params, page);
      }
    ));

    // configureResultsController + startDisplayingEntities
    const controller: NotesListController = new NotesListController(NoteStore.sharedManager());
    controller.onBatchChanges = (): void => {
      this.reloadTableData();
    };
    this.notesListController = controller;
    this.startListeningToNotifications();
    AppStorage.setOrCreate<boolean>('condensedNotesList', Options.shared.condensedNotesList);
    this.showSidebar = this.sidebarVisible;
    this.isIndexing = this.notesWaitingForIndex;
    this.update();

    if (AppStorage.get<boolean>(SessionKeys.AUTHENTICATED) === false) {
      this.presentOnboarding();
    }
    // Cold launch: the first onPageShow runs before setupAppRatings; check again once it has (viewDidAppear).
    RatingsService.shared().ratings.onInitialized = (): void => {
      if (this.pageVisible) {
        this.showRatingViewIfNeeded();
      }
    };
  }

  aboutToDisappear(): void {
    if (this.authRequiredListener !== null) {
      emitter.off(SessionEvent.AUTHENTICATION_REQUIRED, this.authRequiredListener);
    }
    if (this.authDismissedListener !== null) {
      emitter.off(SessionEvent.AUTHENTICATION_DISMISSED, this.authDismissedListener);
    }
    if (this.condensedListener !== null) {
      emitter.off(OptionsEvent.CONDENSED_NOTE_LIST_PREFERENCE_CHANGED, this.condensedListener);
    }
    if (this.sortModeListener !== null) {
      emitter.off(OptionsEvent.NOTES_LIST_SORT_MODE_CHANGED, this.sortModeListener);
    }
    this.invalidateSearchTimer();
    if (this.notesListController !== null) {
      this.notesListController.destroy();
    }
    ShortcutsHandler.shared.detachPresenter();
    RatingsService.shared().ratings.onInitialized = null;
  }

  /// viewWillAppear + viewDidAppear
  onPageShow(): void {
    this.pageVisible = true;
    if (!this.navigatingUsingKeyboard) {
      this.keyboardSelection = '';
    }
    this.navigatingUsingKeyboard = false;
    this.showRatingViewIfNeeded();
    this.showVerificationViewController();
  }

  onPageHide(): void {
    this.pageVisible = false;
  }

  // MARK: - Notifications

  private startListeningToNotifications(): void {
    const condensed: (data: emitter.EventData) => void = (data: emitter.EventData): void => {
      AppStorage.setOrCreate<boolean>('condensedNotesList', Options.shared.condensedNotesList);
      this.reloadTableData();
    };
    const sortMode: (data: emitter.EventData) => void = (data: emitter.EventData): void => {
      this.update();
    };
    this.condensedListener = condensed;
    this.sortModeListener = sortMode;
    emitter.on(OptionsEvent.CONDENSED_NOTE_LIST_PREFERENCE_CHANGED, condensed);
    emitter.on(OptionsEvent.NOTES_LIST_SORT_MODE_CHANGED, sortMode);
  }

  selectedTagDidChange(): void {
    this.update();
    // contentStartOffset changes with the filter; without this the list keeps the old top and hides Trash's inset.
    setTimeout((): void => { this.scroller.scrollEdge(Edge.Top); }, 0);
  }

  sidebarVisibleDidChange(): void {
    if (this.showSidebar !== this.sidebarVisible) {
      this.showSidebar = this.sidebarVisible;
    }
  }

  showSidebarDidChange(): void {
    if (this.sidebarVisible !== this.showSidebar) {
      this.sidebarVisible = this.showSidebar;
    }
  }

  notesWaitingForIndexDidChange(): void {
    this.isIndexing = this.notesWaitingForIndex;
    this.displayPlaceholdersIfNeeded();
  }

  indexingDidChange(): void {
    this.displayPlaceholdersIfNeeded();
  }

  // MARK: - Presentations (SPAppDelegate)

  /// Simperium authenticateWithAppID presents SPOnboardingViewController when signed out.
  private presentOnboarding(): void {
    // Sign-out from Settings already replaced Settings with the onboarding page.
    if (this.onboardingPresented || router.getState().name === 'SPOnboardingViewControllerPage') {
      return;
    }
    this.onboardingPresented = true;
    router.pushUrl({ url: 'pages/SPOnboardingViewControllerPage' }).catch((e: Error) => {
      this.onboardingPresented = false;
      hilog.error(DOMAIN, LOG_TAG, 'onboarding failed: %{public}s', e.message);
    });
  }

  /// Signed-out deep link into a screen the source pushes FROM onboarding (auth, its signup-verification
  /// follow-on, the diagnostics overlay hosted on auth): put onboarding under it first, target on top.
  private openPreAuthTarget(url: string, params: NoteRouteParams, page: string): void {
    if (this.onboardingPresented || router.getState().name === 'SPOnboardingViewControllerPage') {
      router.pushUrl({ url: url, params: params }).catch((e: Error) => {
        hilog.error(DOMAIN, LOG_TAG, 'targetPage %{public}s failed: %{public}s', page, e.message);
      });
      return;
    }
    this.onboardingPresented = true;
    router.pushUrl({ url: 'pages/SPOnboardingViewControllerPage' }).then(() => {
      router.pushUrl({ url: url, params: params }).catch((e: Error) => {
        hilog.error(DOMAIN, LOG_TAG, 'targetPage %{public}s failed: %{public}s', page, e.message);
      });
    }).catch((e: Error) => {
      this.onboardingPresented = false;
      hilog.error(DOMAIN, LOG_TAG, 'onboarding-before-target failed: %{public}s', e.message);
    });
  }

  /// SPAppDelegate.showPasscodeLockIfNecessary (verify mode). Like the source it ignores the timeout here:
  /// the lock goes up on launch and background, and dismissPasscodeLockIfPossible drops it on return.
  private showPasscodeLockIfNecessary(): void {
    if (!SPPinLockManager.shared.isEnabled || isPresentingPasscodeLock()) {
      pendingUnlockAction = null;
      return;
    }
    const params: PinLockRouteParams = new PinLockRouteParams();
    params.mode = 'verify';
    router.pushUrl({ url: 'pages/PinLockViewControllerPage', params: params }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'pin lock failed: %{public}s', e.message);
    });
  }

  /// SPAppDelegate.dismissPasscodeLockIfPossible: back within the Lock Timeout -> drop the lock.
  private dismissPasscodeLockIfPossible(): void {
    if (!isPresentingPasscodeLock() || !SPPinLockManager.shared.shouldBypassPinLock) {
      return;
    }
    router.back();
    runActionAfterUnlock();
  }

  /// SPAppDelegate.showVerificationViewController(with:): pushes the configuration SessionStore requested.
  /// While another page (onboarding, pin lock, editor) is on top it waits; onPageShow tries again.
  showVerificationViewController(): void {
    if (router.getState().name !== 'SPNoteListViewControllerPage') {
      return;
    }
    const configuration: string | null = SessionStore.shared().takePendingVerificationConfiguration();
    if (configuration === null) {
      return;
    }
    const params: AccountVerificationRouteParams = new AccountVerificationRouteParams();
    params.configuration = configuration === VerificationConfiguration.VERIFY ? VerificationConfiguration.VERIFY :
      VerificationConfiguration.REVIEW;
    router.pushUrl({ url: 'pages/AccountVerificationViewControllerPage', params: params }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'verification failed: %{public}s', e.message);
    });
  }

  /// SPAppDelegate.dismissVerificationViewController (the account became verified).
  private dismissVerificationViewController(): void {
    if (router.getState().name === 'AccountVerificationViewControllerPage') {
      router.back();
      return;
    }
    if (this.verificationDismissPending ||
      router.getStateByUrl('pages/AccountVerificationViewControllerPage').length === 0) {
      return;
    }
    // iOS shows the PIN lock in its own window, so the verification screen is dismissed under it.
    // Here the PIN lock is a page above it: dismiss once the verification screen is on top again.
    this.verificationDismissPending = true;
    const observer: UIObserver = this.getUIContext().getUIObserver();
    const onPageUpdate = (info: uiObserver.RouterPageInfo): void => {
      if (info.state !== uiObserver.RouterPageState.ON_PAGE_SHOW) {
        return;
      }
      const onTop: boolean = info.name === 'AccountVerificationViewControllerPage';
      if (onTop || router.getStateByUrl('pages/AccountVerificationViewControllerPage').length === 0) {
        observer.off('routerPageUpdate', onPageUpdate);
        this.verificationDismissPending = false;
        if (onTop) {
          router.back();
        }
      }
    };
    observer.on('routerPageUpdate', onPageUpdate);
  }

  // MARK: - List controller

  /// update: filter + sort from the session / options, refetch, then refresh the chrome.
  private update(): void {
    this.refreshListController();
    this.displayPlaceholdersIfNeeded();
    this.hideRatingViewIfNeeded();
  }

  /// refreshListController
  private refreshListController(): void {
    const controller: NotesListController | null = this.notesListController;
    if (controller === null) {
      return;
    }
    const filter: ListFilter = ListFilter.fromSelectedTag(this.selectedTag);
    controller.filter = filter;
    controller.sortMode = Options.shared.listSortMode;
    controller.performFetch();
    this.filterTitle = filter.title;
    AppStorage.setOrCreate<SortMode>('listSortMode', controller.sortMode);
    this.reloadTableData();
  }

  /// reloadTableData: flattens NotesListController.sections into rows for the LazyForEach.
  private reloadTableData(): void {
    const controller: NotesListController | null = this.notesListController;
    if (controller === null) {
      return;
    }
    this.generation++;
    const gen: string = this.generation.toString();
    const keywords: string[] | null = this.searchKeywords();
    const searching: boolean = controller.state === NotesListMode.SEARCHING;
    const rows: ListRow[] = [];
    const sections: NotesListSection[] = controller.sections;
    for (let s: number = 0; s < sections.length; s++) {
      const section: NotesListSection = sections[s];
      if (section.displaysTitle) {
        const header: ListRow = new ListRow();
        header.kind = RowKind.HEADER;
        header.key = gen + ':h:' + s.toString();
        header.title = section.title === null ? '' : section.title as string;
        rows.push(header);
      }
      for (const object of section.objects) {
        rows.push(this.rowFor(object, gen, keywords, searching));
      }
    }
    this.listState = controller.state;
    this.sections = sections;
    this.numberOfObjects = controller.numberOfObjects;
    this.dataSource.reload(rows);
    this.displayPlaceholdersIfNeeded();
  }

  /// dequeueAndConfigureCell(for note:) / (for tag:)
  private rowFor(object: ListObject, gen: string, keywords: string[] | null, searching: boolean): ListRow {
    const row: ListRow = new ListRow();
    if (object instanceof Tag) {
      const tag: Tag = object as Tag;
      row.kind = RowKind.TAG;
      row.tag = tag;
      row.key = gen + ':t:' + tag.name;
      row.title = 'tag:' + tag.name;
      return row;
    }
    const note: Note = object as Note;
    note.ensurePreviewStringsAreAvailable();
    row.kind = RowKind.NOTE;
    row.note = note;
    row.key = gen + ':n:' + note.simperiumKey;
    row.title = note.titlePreview === null ? '' : note.titlePreview as string;
    const body: string | null = note.bodyExcerpt(keywords);
    row.body = body === null ? '' : body as string;
    row.pinned = note.pinned;
    row.published = note.published;
    row.prefix = this.prefixText(note, searching);
    row.keywords = keywords === null ? [] : keywords as string[];
    return row;
  }

  /// prefixText(for:): the creation / modification date, only while searching with a date sort mode.
  private prefixText(note: Note, searching: boolean): string {
    if (!searching) {
      return '';
    }
    const date: Date | null = note.date(this.sortMode);
    return date === null ? '' : formatListDate(date as Date);
  }

  /// searchQuery?.keywords
  private searchKeywords(): string[] | null {
    const controller: NotesListController | null = this.notesListController;
    if (controller === null || controller.searchQuery === null) {
      return null;
    }
    const query: ListSearchQuery = controller.searchQuery as ListSearchQuery;
    const keywords: string[] = [];
    for (const item of query.items) {
      if (item.kind === SearchItemKind.KEYWORD) {
        keywords.push(item.value);
      }
    }
    return keywords;
  }

  /// displayPlaceholdersIfNeeded + placeholderDisplayMode
  private displayPlaceholdersIfNeeded(): void {
    const controller: NotesListController | null = this.notesListController;
    if (controller === null || this.numberOfObjects > 0) {
      return;
    }
    if (this.isIndexing || this.signingUserOut) {
      this.placeholderMode = PlaceholderMode.GENERIC;
      return;
    }
    const query: ListSearchQuery | null = controller.searchQuery;
    if (query !== null && !(query as ListSearchQuery).isEmpty) {
      this.placeholderMode = PlaceholderMode.TEXT;
      this.placeholderText = 'No Results';
      this.placeholderActionText = 'Create a new note titled “' + (query as ListSearchQuery).searchText + '”';
      return;
    }
    const filter: ListFilter = controller.filter;
    this.placeholderMode = PlaceholderMode.PICTURE_AND_TEXT;
    if (filter.kind === ListFilterKind.DELETED) {
      this.placeholderImage = PlaceholderImage.TRASH;
      this.placeholderText = 'Your trash is empty';
    } else if (filter.kind === ListFilterKind.UNTAGGED) {
      this.placeholderImage = PlaceholderImage.UNTAGGED;
      this.placeholderText = 'No untagged notes';
    } else if (filter.kind === ListFilterKind.TAG) {
      this.placeholderImage = PlaceholderImage.TAG;
      this.placeholderText = 'No notes tagged “' + filter.tagName + '”';
    } else {
      this.placeholderImage = PlaceholderImage.ALL_NOTES;
      this.placeholderText = 'Create your first note';
    }
  }

  // MARK: - Navigation bar

  /// NotesListController.state, as last reloaded into the page (listState).
  private state(): NotesListMode {
    return this.listState;
  }

  /// refreshListViewTitle
  private listTitle(): string {
    if (this.isEditing && this.selectedKeys.length > 0) {
      return this.selectedKeys.length.toString() + ' Selected';
    }
    return this.filterTitle;
  }

  /// refreshSelectAllLabels
  private selectAllLabel(): string {
    const count: number = this.noteKeys().length;
    return count > 0 && this.selectedKeys.length === count ? 'Deselect All' : 'Select All';
  }

  /// sidebarButtonAction:
  private sidebarButtonAction(): void {
    this.setEditing(false);
    SPTracker.trackSidebarButtonPresed();
    this.showSidebar = !this.showSidebar;
  }

  /// addButtonAction: -> createNewNote -> open(nil): EditorFactory builds a new note tagged with the filter.
  private createNewNote(): void {
    SPTracker.trackListNoteCreated();
    this.setEditing(false);
    const params: NoteRouteParams = new NoteRouteParams();
    params.newNote = true;
    params.useSelectedTag = true;
    pushEditor(params);
  }

  /// emptyAction:
  private emptyAction(): void {
    this.getUIContext().getPromptAction().showDialog({
      message: 'Are you sure you want to empty the trash? This cannot be undone.',
      buttons: [
        { text: 'No', color: $r('sys.color.font_emphasize') },
        { text: 'Yes', color: $r('sys.color.warning') }
      ]
    }).then((result: promptAction.ShowDialogSuccessResponse) => {
      if (result.index === 1) {
        this.emptyTrash();
      }
    }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'empty trash dialog failed: %{public}s', e.message);
    });
  }

  private emptyTrash(): void {
    SPTracker.trackListTrashEmptied();
    NoteStore.sharedManager().emptyTrash().catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'empty trash failed: %{public}s', e.message);
    });
  }

  // MARK: - Search (SearchDisplayControllerDelegate)

  /// startSearching: focus the search field (the quick action / keyboard shortcut path).
  private startSearching(): void {
    focusControl.requestFocus('search-bar');
  }

  /// searchDisplayControllerWillBeginSearch:
  private searchWillBegin(): void {
    this.keyboardSelection = '';
    this.searchActive = true;
    this.setEditing(false);
    if (this.notesListController !== null) {
      this.notesListController.beginSearch();
    }
    this.reloadTableData();
  }

  /// searchDisplayController:updateSearchResults: (debounced 0.2 s)
  private updateSearchResults(keyword: string): void {
    this.invalidateSearchTimer();
    this.searchTimer = setTimeout(() => {
      this.performSearchWithKeyword(keyword);
    }, SEARCH_DELAY_MS);
  }

  /// performSearchWithKeyword:
  private performSearchWithKeyword(keyword: string): void {
    SPTracker.trackListNotesSearched();
    this.keyboardSelection = '';
    if (this.notesListController !== null) {
      this.notesListController.refreshSearchResults(keyword);
    }
    this.scroller.scrollToIndex(0);
    this.reloadTableData();
    this.invalidateSearchTimer();
  }

  /// SearchDisplayController.dismiss -> searchDisplayControllerDidEndSearch:
  private endSearching(): void {
    this.invalidateSearchTimer();
    this.searchActive = false;
    this.searchText = '';
    this.getUIContext().getFocusController().clearFocus();
    if (this.notesListController !== null) {
      this.notesListController.endSearch();
    }
    this.update();
  }

  private invalidateSearchTimer(): void {
    if (this.searchTimer !== -1) {
      clearTimeout(this.searchTimer);
      this.searchTimer = -1;
    }
  }

  /// refreshSearchText(appendFilterFor:): replace the last word with 'tag:<name> ' and search again.
  private refreshSearchText(tag: Tag): void {
    const keyword: string = 'tag:' + tag.name;
    const trimmedEnd: number = this.searchText.search(new RegExp('\\S*$'));
    const updated: string = trimmedEnd >= 0 ? this.searchText.substring(0, trimmedEnd) + keyword : keyword;
    this.searchText = updated + ' ';
    this.updateSearchResults(this.searchText);
  }

  // MARK: - Rows

  /// tableView(_:didSelectRowAt:)
  private didSelectRow(row: ListRow): void {
    if (this.isEditing) {
      if (row.note !== null) {
        this.toggleSelection((row.note as Note).simperiumKey);
      }
      return;
    }
    if (row.kind === RowKind.NOTE && row.note !== null) {
      RatingsService.shared().ratings.incrementSignificantEvent();
      this.openNote(row.note as Note, false);
    } else if (row.kind === RowKind.TAG && row.tag !== null) {
      this.refreshSearchText(row.tag as Tag);
    }
  }

  /// openNote:ignoringSearchQuery:animated:
  openNote(note: Note, ignoringSearchQuery: boolean): void {
    SPTracker.trackListNoteOpened();
    this.getUIContext().getFocusController().clearFocus();
    const params: NoteRouteParams = new NoteRouteParams();
    params.noteKey = note.simperiumKey;
    if (!ignoringSearchQuery && this.searchActive) {
      params.searchQuery = this.searchText;
    }
    pushEditor(params);
  }

  /// openNewNote(with:): the empty-search placeholder's action.
  private openNewNote(content: string): void {
    SPTracker.trackListNoteCreated();
    const note: Note | null = NoteStore.sharedManager().newDefaultNote();
    if (note === null) {
      return;
    }
    const created: Note = note as Note;
    created.content = content;
    const controller: NotesListController | null = this.notesListController;
    if (controller !== null && controller.filter.kind === ListFilterKind.TAG) {
      created.addTag(controller.filter.tagName);
    }
    this.openNote(created, true);
  }

  private openNewNoteFromSearch(): void {
    const controller: NotesListController | null = this.notesListController;
    if (controller === null || controller.searchQuery === null) {
      return;
    }
    this.openNewNote((controller.searchQuery as ListSearchQuery).searchText);
  }

  /// delete(note:)
  private trashNote(note: Note): void {
    SPTracker.trackListNoteDeleted();
    NoteStore.sharedManager().trashNote(note).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'trash failed: %{public}s', e.message);
    });
  }

  /// Trash + 'Note Trashed' notice with Undo (restoreNote).
  private trashNoteWithUndo(note: Note): void {
    this.trashNote(note);
    const notice: Notice = NoticeFactory.noteTrashed((): void => {
      NoteStore.sharedManager().restoreNote(note).catch((e: Error) => {
        hilog.error(DOMAIN, LOG_TAG, 'restore failed: %{public}s', e.message);
      });
    });
    NoticeController.shared.present(notice);
  }

  /// deletedContextActions: Restore Note
  private restoreNote(note: Note): void {
    NoteStore.sharedManager().restoreNote(note).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'restore failed: %{public}s', e.message);
    });
  }

  /// deletedContextActions: Delete Note
  private permanentlyDeleteNote(note: Note): void {
    SPTracker.trackListNoteDeleted();
    NoteStore.sharedManager().permenentlyDeleteNote(note).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'delete failed: %{public}s', e.message);
    });
  }

  /// togglePinnedState(note:)
  private togglePinnedState(note: Note): void {
    SPTracker.trackListPinToggled();
    NoteStore.sharedManager().updatePinnedState(!note.pinned, note).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'pin failed: %{public}s', e.message);
    });
  }

  /// copyInternalLink(to:) + 'Link copied' notice
  private onCopyInternalLink(note: Note): void {
    SPTracker.trackListCopiedInternalLink();
    const link: string | null = note.markdownInternalLink;
    copyInternalLink(link === null ? undefined : link as string).then((copied: boolean) => {
      if (copied) {
        NoticeController.shared.present(NoticeFactory.linkCopied());
      }
    }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'copy link failed: %{public}s', e.message);
    });
  }

  /// share(note:): the system share panel with the note's content; clipboard + toast as the fallback.
  private share(note: Note): void {
    if (note.content.length === 0) {
      return;
    }
    SPTracker.trackEditorNoteContentShared();
    const record: systemShare.SharedRecord = {
      utd: uniformTypeDescriptor.UniformDataType.PLAIN_TEXT,
      content: note.content
    };
    const controller: systemShare.ShareController = new systemShare.ShareController(new systemShare.SharedData(record));
    controller.on('dismiss', () => {
      hilog.info(DOMAIN, LOG_TAG, 'share panel dismissed');
    });
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    controller.show(context, {
      previewMode: systemShare.SharePreviewMode.DETAIL,
      selectionMode: systemShare.SelectionMode.SINGLE
    }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'share failed: %{public}s', e.message);
      this.getUIContext().getPromptAction().showToast({ message: 'Sharing is unavailable; the note link was copied instead' });
      this.onCopyInternalLink(note);
    });
  }

  // MARK: - Keyboard (SPSidebarContainerViewController + SPNoteListViewController keyCommands)
  // The page root sits on the focus chain, so every key reaches it; Cmd maps to Ctrl (README, Known limits).

  private handleKey(e: KeyEvent): void {
    // presentedViewController == nil: no shortcuts while a sheet is up.
    if (e.type !== KeyType.Down || this.showFeedbackWebPage) {
      return;
    }
    const ctrl: boolean = e.getModifierKeyState?.(['Ctrl']) ?? false;
    const shift: boolean = e.getModifierKeyState?.(['Shift']) ?? false;
    if (ctrl) {
      if (this.handleCommand(e.keyCode, shift)) {
        e.stopPropagation();
      }
      return;
    }
    if (shift || (e.getModifierKeyState?.(['Alt']) ?? false) || e.metaKey === 1) {
      return;
    }
    // Arrows and return belong to the text while the search field has the keyboard.
    if (this.searchFieldEditing) {
      return;
    }
    if (e.keyCode === KeyCode.KEYCODE_DPAD_LEFT) {
      // keyboardGoBack: hide the sidebar, else show it.
      this.showSidebar = !this.showSidebar;
      e.stopPropagation();
      return;
    }
    if (this.showSidebar) {
      // TagListViewController is first responder while the sidebar shows.
      if (this.tagListKeys.handleKey(e.keyCode)) {
        e.stopPropagation();
      }
      return;
    }
    if (this.isEditing) {
      return;
    }
    if (e.keyCode === KeyCode.KEYCODE_DPAD_UP || e.keyCode === KeyCode.KEYCODE_DPAD_DOWN) {
      this.navigatingUsingKeyboard = true;
      this.moveKeyboardSelection(e.keyCode === KeyCode.KEYCODE_DPAD_DOWN);
      e.stopPropagation();
    } else if (e.keyCode === KeyCode.KEYCODE_ENTER || e.keyCode === KeyCode.KEYCODE_NUMPAD_ENTER ||
      e.keyCode === KeyCode.KEYCODE_DPAD_RIGHT) {
      this.navigatingUsingKeyboard = true;
      this.executeKeyboardSelection();
      e.stopPropagation();
    }
  }

  /// Cmd+N (keyboardCreateNewNote) and Cmd+Shift+F (keyboardStartSearching, or keyboardStopSearching when
  /// the search field has the keyboard); neither while the list is editing.
  private handleCommand(keyCode: number, shift: boolean): boolean {
    if (this.isEditing) {
      return false;
    }
    if (keyCode === KeyCode.KEYCODE_N && !shift) {
      const params: NoteRouteParams = new NoteRouteParams();
      params.newNote = true;
      params.useSelectedTag = true;
      popToList();
      pushEditor(params);
      return true;
    }
    if (keyCode === KeyCode.KEYCODE_F && shift) {
      if (this.searchActive && this.searchFieldEditing) {
        this.endSearching();
      } else {
        popToList();
        this.startSearching();
      }
      return true;
    }
    return false;
  }

  private static rowIdentity(row: ListRow): string {
    return row.key.substring(row.key.indexOf(':') + 1);
  }

  private isKeyboardSelected(row: ListRow): boolean {
    return this.keyboardSelection.length > 0 && SPNoteListViewControllerPage.rowIdentity(row) === this.keyboardSelection;
  }

  /// selectNextRow / selectPrevRow: from no selection both pick the first row; at either end nothing moves.
  private moveKeyboardSelection(down: boolean): void {
    const count: number = this.dataSource.totalCount();
    let current: number = -1;
    for (let i: number = 0; i < count && this.keyboardSelection.length > 0; i++) {
      if (SPNoteListViewControllerPage.rowIdentity(this.dataSource.getData(i)) === this.keyboardSelection) {
        current = i;
        break;
      }
    }
    let target: number = -1;
    if (current < 0) {
      target = 0;
    } else {
      target = current + (down ? 1 : -1);
    }
    while (target >= 0 && target < count && this.dataSource.getData(target).kind === RowKind.HEADER) {
      target += current < 0 || down ? 1 : -1;
    }
    if (target < 0 || target >= count) {
      return;
    }
    this.keyboardSelection = SPNoteListViewControllerPage.rowIdentity(this.dataSource.getData(target));
    // scrollRectToVisible: the ratings prompt is the List's first item when it shows.
    this.scroller.scrollToIndex(target + (this.showRatingsPrompt ? 1 : 0), false, ScrollAlign.AUTO);
  }

  /// executeSelection
  private executeKeyboardSelection(): void {
    for (let i: number = 0; i < this.dataSource.totalCount(); i++) {
      const row: ListRow = this.dataSource.getData(i);
      if (this.isKeyboardSelected(row)) {
        this.didSelectRow(row);
        return;
      }
    }
  }

  // MARK: - Multi-select (setEditing)

  private setEditing(editing: boolean): void {
    this.isEditing = editing;
    this.selectedKeys = [];
  }

  private noteKeys(): string[] {
    const controller: NotesListController | null = this.notesListController;
    if (controller === null) {
      return [];
    }
    return controller.notes.map((n: Note): string => n.simperiumKey);
  }

  private isRowSelected(row: ListRow): boolean {
    return row.note !== null && this.selectedKeys.indexOf((row.note as Note).simperiumKey) >= 0;
  }

  private toggleSelection(key: string): void {
    const index: number = this.selectedKeys.indexOf(key);
    const next: string[] = this.selectedKeys.slice();
    if (index >= 0) {
      next.splice(index, 1);
    } else {
      next.push(key);
    }
    this.selectedKeys = next;
  }

  /// contextMenu 'Select': enter editing with that row selected.
  private selectRow(note: Note): void {
    this.setEditing(true);
    this.selectedKeys = [note.simperiumKey];
  }

  /// selectAllWasTapped
  private selectAllWasTapped(): void {
    const keys: string[] = this.noteKeys();
    this.selectedKeys = this.selectedKeys.length === keys.length ? [] : keys;
  }

  /// trashSelectedNotes -> delete(notes:) + '%i Notes Trashed' notice with Undo
  private trashSelectedNotes(): void {
    const controller: NotesListController | null = this.notesListController;
    if (controller === null) {
      return;
    }
    const keys: string[] = this.selectedKeys;
    const notes: Note[] = controller.notes.filter((n: Note): boolean => keys.indexOf(n.simperiumKey) >= 0);
    for (const note of notes) {
      this.trashNote(note);
    }
    NoticeController.shared.present(NoticeFactory.notesTrashed(notes.length, (): void => {
      for (const note of notes) {
        this.restoreNote(note);
      }
    }));
    this.setEditing(false);
  }

  // MARK: - Ratings (SPRatingsPromptDelegate)

  private showRatingViewIfNeeded(): void {
    if (!RatingsService.shared().shouldPromptForAppReview()) {
      return;
    }
    if (!this.showRatingsPrompt) {
      SPTracker.trackRatingsPromptSeen();
    }
    this.showRatingsPrompt = true;
  }

  private hideRatingViewIfNeeded(): void {
    if (!this.showRatingsPrompt || RatingsService.shared().shouldPromptForAppReview()) {
      return;
    }
    this.showRatingsPrompt = false;
  }

  private simplenoteWasLiked(): void {
    SPTracker.trackRatingsAppLiked();
    RatingsService.shared().ratings.likedCurrentVersion();
  }

  private simplenoteWasDisliked(): void {
    SPTracker.trackRatingsAppDisliked();
    RatingsService.shared().ratings.dislikedCurrentVersion();
  }

  /// displayReviewUI: SKStoreReviewController.requestReview -> the app's AppGallery detail page
  /// (productViewManager.loadProduct), where the review is left. A toast when the store cannot open.
  private displayReviewUI(): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    const want: Want = { parameters: { 'bundleName': context.abilityInfo.bundleName } };
    try {
      productViewManager.loadProduct(context, want, {
        onError: (e: BusinessError): void => {
          hilog.error(DOMAIN, LOG_TAG, 'review UI failed: %{public}s', e.message);
          this.getUIContext().getPromptAction().showToast({ message: 'App reviews are not available on this device' });
        }
      });
    } catch (e) {
      hilog.error(DOMAIN, LOG_TAG, 'review UI unavailable: %{public}s', (e as Error).message);
      this.getUIContext().getPromptAction().showToast({ message: 'App reviews are not available on this device' });
    }
    SPTracker.trackRatingsAppRated();
    RatingsService.shared().ratings.ratedCurrentVersion();
    this.hideRatingViewIfNeeded();
  }

  /// displayFeedbackUI: SPFeedbackManager's mail composer -> a mailto Want.
  private displayFeedbackUI(): void {
    // iOS: mailViewController.setSubject("Simplenote iOS Feedback").
    const mailto: string = 'mailto:' + SIMPLENOTE_FEEDBACK_MAIL + '?subject=' +
      encodeURIComponent('Simplenote iOS Feedback');
    const want: Want = { action: 'ohos.want.action.sendToData', uri: mailto };
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    // MFMailComposeViewController.canSendMail() == false -> SFSafariViewController(simplenoteFeedbackURL).
    context.startAbility(want)
      .catch((e: Error) => {
        hilog.warn(DOMAIN, LOG_TAG, 'feedback sendToData failed, opening web page: %{public}s', e.message);
        this.showFeedbackWebPage = true;
      });
    SPTracker.trackRatingsFeedbackScreenOpened();
    RatingsService.shared().ratings.gaveFeedbackForCurrentVersion();
    this.hideRatingViewIfNeeded();
  }

  private dismissRatingsUI(): void {
    SPTracker.trackRatingsDeclinedToRate();
    RatingsService.shared().ratings.declinedToRateCurrentVersion();
    this.hideRatingViewIfNeeded();
  }

  // MARK: - Builders

  @Builder
  feedbackWebPageSheet() {
    InAppBrowserSheet({
      src: SIMPLENOTE_FEEDBACK_URL,
      onDismiss: (): void => {
        this.showFeedbackWebPage = false;
      }
    })
  }

  /// One swipe action: a 40vp round symbol button on a fill. The title only reaches accessibility.
  /// Shared by every note swipe action.
  @Builder
  swipeIcon(symbol: Resource, fill: ResourceColor, tint: ResourceColor, label: string, action: () => void) {
    Button({ type: ButtonType.Circle, stateEffect: true }) {
      SymbolGlyph(symbol)
        .fontSize(20)
        .fontColor([tint])
    }
    .width(SWIPE_BUTTON_SIZE)
    .height(SWIPE_BUTTON_SIZE)
    .backgroundColor(fill)
    .accessibilityText(label)
    .onClick(() => {
      action();
      // Every iOS swipe handler ends with completion(true), which animates the row closed.
      this.scroller.closeAllSwipeActions();
    })
  }

  /// regularContextActions(for:): iOS returns [trash, pin, copy, share] and puts index 0 at the trailing
  /// edge, so the Row lays them out reversed: Share | Copy Link | Pin | Trash.
  @Builder
  regularActions(note: Note) {
    Row({ space: SWIPE_BUTTON_GAP }) {
      this.swipeIcon($r('sys.symbol.share'), $r('sys.color.comp_background_secondary'),
        $r('sys.color.icon_primary'), 'Share...', () => {
          this.share(note);
        })
      this.swipeIcon($r('sys.symbol.link'), $r('sys.color.comp_background_secondary'),
        $r('sys.color.icon_primary'), 'Copy Internal Link', () => {
          this.onCopyInternalLink(note);
        })
      this.swipeIcon(note.pinned ? $r('sys.symbol.pin_slash') : $r('sys.symbol.pin'), $r('sys.color.brand'),
        $r('sys.color.icon_on_primary'), note.pinned ? 'Unpin' : 'Pin to Top', () => {
          this.togglePinnedState(note);
        })
      this.swipeIcon($r('sys.symbol.trash'), $r('sys.color.warning'), $r('sys.color.icon_on_primary'),
        'Move to Trash', () => {
          this.trashNoteWithUndo(note);
        })
    }
    .height('100%')
    .padding({ start: LengthMetrics.vp(SWIPE_BUTTON_GAP), end: LengthMetrics.vp(LIST_SIDE_MARGIN) })
  }

  /// deletedContextActions(for:): iOS returns [restore, delete] and puts index 0 at the trailing
  /// edge, so the Row lays them out reversed: Delete | Restore.
  @Builder
  deletedActions(note: Note) {
    Row({ space: SWIPE_BUTTON_GAP }) {
      this.swipeIcon($r('sys.symbol.trash'), $r('sys.color.warning'), $r('sys.color.icon_on_primary'),
        'Delete Note', () => {
          this.permanentlyDeleteNote(note);
        })
      this.swipeIcon($r('sys.symbol.arrow_counterclockwise'), $r('sys.color.brand'), $r('sys.color.icon_on_primary'),
        'Restore Note', () => {
          this.restoreNote(note);
        })
    }
    .height('100%')
    .padding({ start: LengthMetrics.vp(SWIPE_BUTTON_GAP), end: LengthMetrics.vp(LIST_SIDE_MARGIN) })
  }

  private menuSymbol(symbol: Resource, destructive: boolean = false): SymbolGlyphModifier {
    return new SymbolGlyphModifier(symbol)
      .fontColor([destructive ? $r('sys.color.warning') : $r('sys.color.icon_primary')]);
  }

  /// contextMenu(for:at:): [select, share, copy, pin, delete] as a native Menu with leading symbols;
  /// delete is destructive (warning colour).
  @Builder
  rowMenu(note: Note) {
    Menu() {
      MenuItem({ content: 'Select', symbolStartIcon: this.menuSymbol($r('sys.symbol.checkmark_circle')) })
        .enabled(!this.searchActive)
        .onClick(() => {
          this.selectRow(note);
        })
      MenuItem({ content: 'Share...', symbolStartIcon: this.menuSymbol($r('sys.symbol.share')) })
        .onClick(() => {
          this.share(note);
        })
      MenuItem({ content: 'Copy Internal Link', symbolStartIcon: this.menuSymbol($r('sys.symbol.link')) })
        .onClick(() => {
          this.onCopyInternalLink(note);
        })
      MenuItem({
        content: note.pinned ? 'Unpin' : 'Pin to Top',
        symbolStartIcon: this.menuSymbol(note.pinned ? $r('sys.symbol.pin_slash') : $r('sys.symbol.pin'))
      })
        .onClick(() => {
          this.togglePinnedState(note);
        })
      MenuItem({ content: 'Delete Note', symbolStartIcon: this.menuSymbol($r('sys.symbol.trash'), true) })
        .contentFontColor($r('sys.color.warning'))
        .onClick(() => {
          this.trashNoteWithUndo(note);
        })
    }
  }

  /// The headline (first line) or the body (everything after it) of note.content, as the editor lays it out.
  private previewPart(note: Note, body: boolean): string {
    const structure = noteStructure(note.content);
    const range = body ? structure.body : structure.title;
    return range === null ? '' : note.content.substring(range.lower, range.upper);
  }

  /// previewingViewController(for:): the editor with isPreviewing = true, read-only, on
  /// simplenoteBackgroundPreviewColor: headline title, body, then the tag pills and the 'Tag…' field.
  @Builder
  notePreview(note: Note) {
    Column() {
      Text() {
        ForEach(previewRuns(this.previewPart(note, false)), (run: PreviewRun) => {
          Span(run.text)
            .fontColor(run.link ? $r('app.color.simplenote_tint') : $r('app.color.simplenote_text'))
        })
      }
        .width('100%')
        // iOS 28pt title shrunk ~0.92 in the preview (~25.7pt); ArkUI grows the builder 1.1x, so 23.5fp lands there.
        .fontSize(23.5)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.simplenote_text'))
      Text() {
        ForEach(previewRuns(this.previewPart(note, true)), (run: PreviewRun) => {
          Span(run.text)
            .fontColor(run.link ? $r('app.color.simplenote_tint') : $r('app.color.simplenote_text'))
        })
      }
        .width('100%')
        .layoutWeight(1)
        .align(Alignment.TopStart)
        .clip(true)
        // ponytail: line cap keeps layout cheap for huge notes; the card clips anyway.
        .maxLines(40)
        // iOS lays the 17pt body out at screen width and shrinks the preview ~0.92 (15.6pt, 22.3pt pitch);
        // ArkUI grows the preview builder 1.1x (previewAnimationOptions default), so 14fp / 20 lands there.
        .fontSize($r('sys.float.Body_M'))
        .fontColor($r('app.color.simplenote_text'))
        .lineHeight(20)
      // TagView: pills (spacing 8), then the entry field (spacing 16) showing its 'Tag…' placeholder.
      Row({ space: 16 }) {
        if (note.tagsArray.length > 0) {
          Row({ space: 8 }) {
            ForEach(note.tagsArray, (tagName: string) => {
              Text(tagName)
                .fontSize($r('sys.float.Body_M'))
                .fontWeight(FontWeight.Medium)
                .fontColor($r('app.color.simplenote_tag_pill_text'))
                .maxLines(1)
                .textAlign(TextAlign.Center)
                .padding({ top: LengthMetrics.vp(5), bottom: LengthMetrics.vp(5), start: LengthMetrics.vp(12),
                  end: LengthMetrics.vp(12) })
                .constraintSize({ minHeight: 30, minWidth: 39 })
                .borderRadius(15)
                .backgroundColor($r('app.color.simplenote_tag_pill_background'))
            }, (tagName: string): string => tagName)
          }
        }
        Text($r('app.string.tag_3'))
          .fontSize($r('sys.float.Body_M'))
          .fontColor($r('app.color.simplenote_tag_view_placeholder'))
      }
      .width('100%')
      .padding({ top: LengthMetrics.vp(12) })
      .clip(true)
    }
    // iOS sizes the preview controller to the screen minus the menu margins (~92% of the width). A percentage
    // here resolves against ArkUI's narrower preview area (90% landed at ~78%), so size it from the screen in vp,
    // divided by the 1.1x lift ArkUI applies to the builder. ArkUI caps the lifted width at the screen minus 24vp a side
    // (~87% folded) and shrinks the whole card when card + menu overflow the height: at 60% the menu (taller than
    // iOS's) pushed it down to ~78%. 52% (~57% lifted, iOS ~61%) keeps the card at that cap.
    .width(this.getUIContext().px2vp(display.getDefaultDisplaySync().width) * 0.92 / 1.1)
    .height('52%')
    .padding(20)
    .backgroundColor($r('app.color.simplenote_background_preview'))
    // willPerformPreviewActionForMenuWith: tapping the preview commits it into the editor.
    .onClick(() => {
      // The menu does not close by itself: without this the editor is pushed underneath it.
      ContextMenu.close();
      this.openNote(note, false);
    })
  }

  @Builder
  noteRowContent(row: ListRow) {
    SPNoteTableViewCell({
      titleText: row.title,
      bodyText: row.body,
      prefixText: row.prefix,
      pinned: row.pinned,
      published: row.published,
      condensed: this.condensed,
      keywords: row.keywords
    })
  }

  /// Title-bar menus (HarmonyOS Navigation, Free title mode): symbol buttons that keep the test ids.
  /// Normal: Tags sidebar, New note. Selecting: Select All, Cancel. Trash: Tags sidebar, Empty.
  @Builder
  titleMenus() {
    Row({ space: 8 }) {
      if (this.isIndexing && this.selectedTag !== SIMPLENOTE_TRASH_KEY &&
        (this.numberOfObjects === 0 || this.firstLaunch)) {
        LoadingProgress()
          .width(24)
          .height(24)
          .color($r('sys.color.icon_secondary'))
      }
      if (this.isEditing) {
        HmIconButton({
          buttonId: 'note_list_select_all',
          symbol: $r('sys.symbol.checkmark_square_on_square'),
          label: this.selectAllLabel(),
          action: (): void => this.selectAllWasTapped()
        })
        HmIconButton({
          buttonId: 'note_list_cancel_editing',
          symbol: $r('sys.symbol.xmark'),
          label: 'Cancel',
          action: (): void => this.setEditing(false)
        })
      } else {
        if (this.selectedTag === SIMPLENOTE_TRASH_KEY) {
          HmIconButton({
            buttonId: 'note_list_empty_trash',
            symbol: $r('sys.symbol.trash'),
            label: 'Empty',
            isEnabled: this.numberOfObjects > 0,
            tint: $r('sys.color.warning'),
            action: (): void => this.emptyAction()
          })
        } else {
          HmIconButton({
            buttonId: 'note_list_new_note',
            symbol: $r('sys.symbol.square_and_pencil'),
            label: 'New note',
            action: (): void => this.createNewNote()
          })
        }
      }
    }
    .height(56)
    .alignItems(VerticalAlign.Center)
    .padding({ end: LengthMetrics.vp(16) })
  }

  /// Drawer title bar content: the sidebar button (not while selecting) and the list title.
  @Builder
  drawerTitle() {
    Row({ space: 8 }) {
      if (!this.isEditing) {
        HmIconButton({
          buttonId: 'menu',
          symbol: $r('sys.symbol.open_sidebar'),
          label: 'Sidebar',
          action: (): void => this.sidebarButtonAction()
        })
      }
      Text(this.listTitle())
        .fontSize($r('sys.float.Title_S'))
        .fontWeight(FontWeight.Bold)
        .fontColor($r('sys.color.font_primary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
    }
    .height('100%')
    .padding({ start: LengthMetrics.vp(16) })
    .alignItems(VerticalAlign.Center)
  }

  /// Multi-select toolbar (HarmonyOS bottom toolbar: icon over label).
  @Builder
  selectionToolbar() {
    Row() {
      Column({ space: 2 }) {
        SymbolGlyph($r('sys.symbol.trash'))
          .fontSize(24)
          .fontColor([this.selectedKeys.length > 0 ? $r('sys.color.icon_primary') : $r('sys.color.icon_fourth')])
        Text('Trash Notes')
          .fontSize($r('sys.float.Caption_M'))
          .fontColor(this.selectedKeys.length > 0 ? $r('sys.color.font_primary') : $r('sys.color.font_fourth'))
      }
      .id('note_list_trash_selected')
      .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16), top: LengthMetrics.vp(6), bottom: LengthMetrics.vp(6) })
      .accessibilityText('Trash Notes')
      .enabled(this.selectedKeys.length > 0)
      .onClick(() => {
        this.trashSelectedNotes();
      })
    }
    .width('100%')
    .height(56)
    .justifyContent(FlexAlign.Center)
    .backgroundColor($r('sys.color.background_primary'))
  }

  @Builder
  notesList() {
    List({ scroller: this.scroller }) {
      // tableHeaderView: SPRatingsPromptView
      if (this.showRatingsPrompt) {
        ListItem() {
          SPRatingsPromptView({
            onLiked: (): void => {
              this.simplenoteWasLiked();
            },
            onDisliked: (): void => {
              this.simplenoteWasDisliked();
            },
            onDisplayReview: (): void => {
              this.displayReviewUI();
            },
            onDisplayFeedback: (): void => {
              this.displayFeedbackUI();
            },
            onDismiss: (): void => {
              this.dismissRatingsUI();
            }
          })
        }
      }
      LazyForEach(this.dataSource, (row: ListRow, index: number) => {
        if (row.kind === RowKind.HEADER) {
          ListItem() {
            SPSectionHeaderView({ title: row.title })
          }
        } else if (row.kind === RowKind.TAG) {
          ListItem() {
            SPTagTableViewCell({ titleText: row.title })
          }
          .id('note_list_tag_itemroot')
          .backgroundColor(this.isKeyboardSelected(row) ? $r('app.color.simplenote_light_blue') : Color.Transparent)
          .onClick(() => {
            this.didSelectRow(row);
          })
        } else if (this.isEditing) {
          ListItem() {
            Row() {
              // Display only: the row tap (didSelectRow) stays the single toggle path.
              Checkbox()
                .select(this.isRowSelected(row))
                .shape(CheckBoxShape.CIRCLE)
                .margin({ start: LengthMetrics.vp(LIST_SIDE_MARGIN) })
                .hitTestBehavior(HitTestMode.None)
                .accessibilityLevel('no')
              Column() {
                this.noteRowContent(row)
                // The cell's own separator, so a selected row's blue runs under the 72vp inset like iOS
                // (List.divider leaves the inset area in the List background: a white gap between rows).
                // ponytail: index is captured when the item builds; a row appended mid-selection can leave
                // the previous last row without a line until editing ends.
                if (index < this.dataSource.totalCount() - 1) {
                  Divider()
                    .strokeWidth(0.5)
                    .color($r('app.color.simplenote_divider'))
                    .margin({ start: LengthMetrics.vp(LIST_SIDE_MARGIN), end: LengthMetrics.vp(LIST_SIDE_MARGIN) })
                }
              }
              .layoutWeight(1)
            }
            .width('100%')
          }
          .id('note_list_itemroot')
          // Not .selected(): ListItem's selected state draws a system tint over the backgroundColor
          // (device: #CED9F2 rendered as (186,204,242)); expose the state to accessibility only.
          .accessibilitySelected(this.isRowSelected(row))
          // HarmonyOS multi-select: the checkbox carries the state, the row keeps the page background.
          .backgroundColor($r('app.color.simplenote_background'))
          .onClick(() => {
            this.didSelectRow(row);
          })
        } else if (this.selectedTag === SIMPLENOTE_TRASH_KEY) {
          ListItem() {
            this.noteRowContent(row)
          }
          .id('note_list_itemroot')
          .swipeAction({
            end: {
              builder: () => {
                this.deletedActions(row.note as Note);
              }
            }
          })
          .backgroundColor(this.isKeyboardSelected(row) ? $r('app.color.simplenote_light_blue') : Color.Transparent)
          .onClick(() => {
            this.didSelectRow(row);
          })
        } else {
          ListItem() {
            this.noteRowContent(row)
          }
          .id('note_list_itemroot')
          .swipeAction({
            end: {
              builder: () => {
                this.regularActions(row.note as Note);
              }
            }
          })
          // SPNoteTableViewCell.Style.selectionColor on the keyboard-selected row.
          .backgroundColor(this.isKeyboardSelected(row) ? $r('app.color.simplenote_light_blue') : Color.Transparent)
          .bindContextMenu(this.rowMenu(row.note as Note), ResponseType.LongPress, {
            preview: () => {
              this.notePreview(row.note as Note);
            },
            previewBorderRadius: 12,
            placement: Placement.BottomLeft
          })
          .onClick(() => {
            this.didSelectRow(row);
          })
        }
      }, (row: ListRow): string => row.key)
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.simplenote_background'))
    .edgeEffect(EdgeEffect.Spring)
    .scrollBar(BarState.Auto)
    .contentStartOffset(this.selectedTag === SIMPLENOTE_TRASH_KEY ? TRASH_TOP_INSET : 0)
    // separatorInsets: the hairline starts at the labels' leading edge and
    // runs to the trailing edge.
    // While editing each row draws its own separator (see the editing ListItem).
    .divider(this.isEditing ? null : {
      strokeWidth: '1px',
      color: $r('sys.color.comp_divider'),
      startMargin: NOTE_LABEL_INSET,
      endMargin: LIST_SIDE_MARGIN
    })
    // Fires once on layout and whenever the visible range changes (data reloads, the toolbar resizing the list).
    .onScrollIndex(() => {
      this.listAtEnd = this.scroller.isAtEnd();
    })
    .onDidScroll(() => {
      this.listAtEnd = this.scroller.isAtEnd();
    })
  }

  @Builder
  sidebarSlot() {
    // sideBar slot: screen_tag_list (TagListViewController). The page marker only while the sidebar shows.
    Column() {
      TagListViewController({ keys: this.tagListKeys })
    }
    .id(this.showSidebar ? 'screen_tag_list' : 'tag_list_sidebar')
    .width('100%')
    .height('100%')
  }

  @Builder
  mainContent() {
    Stack({ alignContent: Alignment.Bottom }) {
      Navigation() {
        Column() {
          // refreshSearchBar: hidden while the Trash filter is on screen.
          if (this.selectedTag !== SIMPLENOTE_TRASH_KEY) {
            SearchDisplayController({
              text: $searchText,
              active: this.searchActive,
              searchEnabled: !this.isEditing,
              onBeginSearch: (): void => {
                this.searchWillBegin();
              },
              onUpdateSearchResults: (keyword: string): void => {
                this.updateSearchResults(keyword);
              },
              onCancel: (): void => {
                this.endSearching();
              },
              onEditingChange: (editing: boolean): void => {
                this.searchFieldEditing = editing;
              }
            })
          }
          Stack() {
            this.notesList()
            // SPPlaceholderView: only while the list has no objects.
            if (this.numberOfObjects === 0) {
              SPPlaceholderView({
                mode: this.placeholderMode,
                imageName: this.placeholderImage,
                text: this.placeholderText,
                actionText: this.placeholderActionText,
                onAction: (): void => {
                  this.openNewNoteFromSearch();
                }
              })
            }
          }
          .layoutWeight(1)
          .width('100%')
          if (this.isEditing) {
            this.selectionToolbar()
          }
        }
        .width('100%')
        .height('100%')
      }
      // HarmonyOS drawer title bar: sidebar button + title on one 56vp row (Mini), close to the original
      // 44vp bar's spacing; a large Free/Full title would push the list ~140px lower than the original app.
      .title(this.drawerTitle())
      .titleMode(NavigationTitleMode.Mini)
      .menus(this.titleMenus())
      .hideBackButton(true)
      .mode(NavigationMode.Stack)
      // The title bar hides while search is active (SearchDisplayController.updateNavigationBar).
      .hideTitleBar(this.searchActive, true)
      .backgroundColor($r('sys.color.background_primary'))
      .width('100%')
      .height('100%')
      NoticeToast({ active: this.pageVisible })
    }
    .width('100%')
    .height('100%')
  }

  build() {
    Column() {
      SPSidebarContainerViewController({
        showSidebar: $showSidebar,
        shouldDisplaySidebar: (): boolean => !(this.isEditing || this.searchActive),
        sidebar: (): void => {
          this.sidebarSlot();
        },
        content: (): void => {
          this.mainContent();
        }
      })
    }
    .id('screen_note_list')
    .onKeyEvent((e: KeyEvent): void => {
      this.handleKey(e);
    })
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.simplenote_background'))
    .bindSheet($$this.showFeedbackWebPage, this.feedbackWebPageSheet(), {
      showClose: false,
      // SFSafariViewController presented modally: full-height card on a phone
      height: SheetSize.LARGE,
      dragBar: false,
      backgroundColor: $r('sys.color.background_primary')
    })
  }
}
