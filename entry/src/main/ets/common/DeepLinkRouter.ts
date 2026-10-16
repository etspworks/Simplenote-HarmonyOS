// Port of Simplenote/Classes/ShortcutsHandler.swift (+ ActivityType.swift, ApplicationShortcutItemType.swift,
// NSUserActivity+Shortcuts.swift) and the URL-scheme half of SPAppDelegate (application:openURL:options:,
// handleOpenNote(url:), handleOpenTagList(url:), NSURL+Links, NSURLComponents+Simplenote).
//
// Platform mapping:
//   UIApplicationShortcutItem (home-screen quick actions) -> module.json5 static `shortcuts`; each shortcut's
//     Want carries parameters.shortcutType = 'search' | 'newNote' | 'recent'. HarmonyOS cannot add shortcuts or
//     change their label/want at runtime, so 'Recent' is a static shortcut declared hidden and toggled with
//     shortcutManager.setShortcutVisibleForSelf; the recent note's key lives in UserDefaults instead of the
//     shortcut's userInfo. Known ceiling: no subtitle (the iOS note preview) on HarmonyOS shortcuts.
//   NSUserActivity / Siri / Spotlight -> no HarmonyOS equivalent; an activity arrives as a Want whose
//     parameters.activityType carries the source's raw ActivityType string (plus the userInfo keys).
//   openURL -> Want.uri with the `simplenote` scheme (module.json5 skills uris).
//
// Navigation itself is UI work (.ts cannot import .ets): the UI attaches a DeepLinkPresenter once the window
// is loaded. Routes that arrive earlier (onCreate) are queued and delivered on attach.
import { Want, shortcutManager } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Note, SIMPLENOTE_SCHEME, SIMPLENOTE_INTERLINK_HOST } from '../model/Note';
import { SessionStore } from './SessionStore';
import { NoteStore } from './NoteStore';
import { UserDefaults } from './Database';

const DOMAIN: number = 0x0001;
const LOG_TAG: string = 'DeepLinkRouter';

export const SIMPLENOTE_INTERNAL_TAG_HOST: string = 'list';
export const NEW_NOTE_HOST: string = 'new';
export const WIDGET_NEW_NOTE_HOST: string = 'widgetNew';
/// CSSearchableItemActivityIdentifier
export const SEARCHABLE_ITEM_ACTIVITY_IDENTIFIER: string = 'kCSSearchableItemActivityIdentifier';
/// IntentsConstants.noteIdentifierKey
export const INTENTS_NOTE_IDENTIFIER_KEY: string = 'OpenNoteIntentHandlerIdentifierKey';
/// Want parameter keys used by module.json5 static shortcuts / activities / replay.
export const WANT_SHORTCUT_TYPE_KEY: string = 'shortcutType';
export const WANT_ACTIVITY_TYPE_KEY: string = 'activityType';
export const WANT_TARGET_PAGE_KEY: string = 'targetPage';
/// shortcuts_config.json id of the hidden 'Recent' shortcut, and the UserDefaults key holding its note.
export const RECENT_SHORTCUT_ID: string = 'recent';
const SEARCH_SHORTCUT_ID: string = 'search';
const NEW_NOTE_SHORTCUT_ID: string = 'newNote';
export const RECENT_NOTE_KEY: string = 'homeScreenRecentNoteKey';

/// ActivityType.swift raw values.
export class ActivityType {
  static readonly LAUNCH: string = 'com.codality.NotationalFlow.launch';
  static readonly NEW_NOTE: string = 'com.codality.NotationalFlow.newNote';
  static readonly NEW_NOTE_SHORTCUT: string = 'OpenNewNoteIntent';
  static readonly OPEN_NOTE: string = 'com.codality.NotationalFlow.openNote';
  static readonly OPEN_NOTE_SHORTCUT: string = 'OpenNoteIntent';
  static readonly OPEN_SPOTLIGHT_ITEM: string = 'com.apple.corespotlightitem';
  static readonly ALL: string[] = [
    ActivityType.LAUNCH, ActivityType.NEW_NOTE, ActivityType.NEW_NOTE_SHORTCUT,
    ActivityType.OPEN_NOTE, ActivityType.OPEN_NOTE_SHORTCUT, ActivityType.OPEN_SPOTLIGHT_ITEM
  ];
}

/// ApplicationShortcutItemType.swift raw values.
export enum ApplicationShortcutItemType {
  SEARCH = 'search',
  NEW_NOTE = 'newNote',
  NOTE = 'note',
  /// HarmonyOS stand-in for NOTE: the static 'recent' shortcut; the key is in UserDefaults[RECENT_NOTE_KEY].
  RECENT = 'recent'
}

/// NSUserActivity equivalent: type, title and userInfo.
export class UserActivity {
  activityType: string;
  title: string;
  userInfo: Map<string, string> = new Map<string, string>();

  constructor(activityType: string, title: string) {
    this.activityType = activityType;
    this.title = title;
  }

  static launchActivity(): UserActivity {
    return new UserActivity(ActivityType.LAUNCH, 'Open Simplenote');
  }

  static newNoteActivity(): UserActivity {
    return new UserActivity(ActivityType.NEW_NOTE, 'Create a New Note');
  }

  static openNoteActivity(note: Note): UserActivity | null {
    const preview: string | null = note.titlePreview;
    if (note.simperiumKey.length === 0 || preview === null) {
      hilog.warn(DOMAIN, LOG_TAG, 'Note with missing SimperiumKey!!');
      return null;
    }
    const activity: UserActivity = new UserActivity(ActivityType.OPEN_NOTE, `Open "${preview}"`);
    activity.userInfo.set(SEARCHABLE_ITEM_ACTIVITY_IDENTIFIER, note.simperiumKey);
    return activity;
  }
}

/// UIApplicationShortcutItem equivalent.
export class ShortcutItem {
  type: string;
  localizedTitle: string;
  localizedSubtitle: string | null;
  iconName: string;
  userInfo: Map<string, string> | null;

  constructor(type: string, localizedTitle: string, localizedSubtitle: string | null, iconName: string,
    userInfo: Map<string, string> | null) {
    this.type = type;
    this.localizedTitle = localizedTitle;
    this.localizedSubtitle = localizedSubtitle;
    this.iconName = iconName;
    this.userInfo = userInfo;
  }
}

/// What the UI layer does for each route (SPAppDelegate's presentation methods).
export interface DeepLinkPresenter {
  presentNewNoteEditor(useSelectedTag: boolean): void;
  presentSearch(): void;
  presentNoteWithSimperiumKey(simperiumKey: string): void;
  presentNote(note: Note): void;
  popToNoteList(): void;
  openTargetPage(page: string): void;
}

export enum RouteKind {
  NEW_NOTE_EDITOR = 'NEW_NOTE_EDITOR',
  SEARCH = 'SEARCH',
  NOTE_WITH_KEY = 'NOTE_WITH_KEY',
  NOTE = 'NOTE',
  NOTE_LIST = 'NOTE_LIST',
  TARGET_PAGE = 'TARGET_PAGE'
}

export class PendingRoute {
  kind: RouteKind;
  value: string = '';
  note: Note | null = null;

  constructor(kind: RouteKind) {
    this.kind = kind;
  }
}

/// Parsed simplenote:// (or any) URL — the NSURL / NSURLComponents parts the source reads.
export class ParsedUrl {
  scheme: string = '';
  host: string = '';
  path: string = '';
  query: Array<[string, string]> = [];

  static parse(url: string): ParsedUrl {
    const parsed: ParsedUrl = new ParsedUrl();
    const schemeEnd: number = url.indexOf('://');
    if (schemeEnd < 0) {
      return parsed;
    }
    parsed.scheme = url.substring(0, schemeEnd).toLowerCase();
    let rest: string = url.substring(schemeEnd + 3);
    const hashAt: number = rest.indexOf('#');
    if (hashAt >= 0) {
      rest = rest.substring(0, hashAt);
    }
    let queryString: string = '';
    const queryAt: number = rest.indexOf('?');
    if (queryAt >= 0) {
      queryString = rest.substring(queryAt + 1);
      rest = rest.substring(0, queryAt);
    }
    const slashAt: number = rest.indexOf('/');
    parsed.host = slashAt >= 0 ? rest.substring(0, slashAt) : rest;
    parsed.path = slashAt >= 0 ? rest.substring(slashAt) : '';
    if (queryString.length > 0) {
      for (const pair of queryString.split('&')) {
        if (pair.length === 0) {
          continue;
        }
        const eq: number = pair.indexOf('=');
        const name: string = ParsedUrl.decode(eq >= 0 ? pair.substring(0, eq) : pair);
        const value: string = eq >= 0 ? ParsedUrl.decode(pair.substring(eq + 1)) : '';
        parsed.query.push([name, value]);
      }
    }
    return parsed;
  }

  private static decode(text: string): string {
    try {
      return decodeURIComponent(text.replace(/\+/g, ' '));
    } catch (e) {
      return text;
    }
  }

  /// NSURL.isSimplenoteURL
  get isSimplenoteURL(): boolean {
    return this.scheme === SIMPLENOTE_SCHEME;
  }

  /// NSURL.isInterlinkURL
  get isInterlinkURL(): boolean {
    return this.isSimplenoteURL && this.host.toLowerCase() === SIMPLENOTE_INTERLINK_HOST;
  }

  /// NSURL.interlinkSimperiumKey
  get interlinkSimperiumKey(): string | null {
    if (!this.isInterlinkURL) {
      return null;
    }
    return this.path.replace(/\//g, '');
  }

  /// NSURL.isInternalTagURL
  get isInternalTagURL(): boolean {
    return this.isSimplenoteURL && this.host.toLowerCase() === SIMPLENOTE_INTERNAL_TAG_HOST;
  }

  /// NSURL.internalTagKey
  get internalTagKey(): string | null {
    if (!this.isInternalTagURL) {
      return null;
    }
    for (const item of this.query) {
      if (item[0] === 'tag') {
        return item[1];
      }
    }
    return null;
  }

  /// NSURLComponents.contentFromQuery
  contentFromQuery(): string | null {
    for (const item of this.query) {
      if (item[0] === 'content') {
        return item[1];
      }
    }
    return null;
  }

  /// NSURLComponents.tagsFromQuery
  tagsFromQuery(): string[] | null {
    if (this.query.length === 0) {
      return null;
    }
    const tags: string[] = [];
    for (const item of this.query) {
      if (item[0] !== 'tag') {
        continue;
      }
      for (const word of item[1].split(/\s+/)) {
        if (word.length > 0) {
          tags.push(word);
        }
      }
    }
    return tags;
  }
}

export class ShortcutsHandler {
  /// This is, gentlemen, a singleton.
  static shared: ShortcutsHandler = new ShortcutsHandler();

  /// Supported Activities
  private readonly activities: UserActivity[] = [
    UserActivity.newNoteActivity(),
    UserActivity.launchActivity()
  ];

  /// UIApplication.shared.shortcutItems — computed; the launcher shows the static ones (see header).
  shortcutItems: ShortcutItem[] | null = null;

  private presenter: DeepLinkPresenter | null = null;
  private pendingRoutes: PendingRoute[] = [];

  /// Is User authenticated?
  private get isAuthenticated(): boolean {
    return SessionStore.shared().isAuthenticated;
  }

  private get shortcutUserInfoNoteIdentifierKey(): string {
    return 'simperium_key';
  }

  /// Activities this app supports (the source registers them with the OS).
  supportedActivities(): UserActivity[] {
    return this.activities;
  }

  // MARK: - Presenter

  /// Called by the UI layer once the window content is loaded; flushes routes queued before that.
  attachPresenter(presenter: DeepLinkPresenter): void {
    this.presenter = presenter;
    const queued: PendingRoute[] = this.pendingRoutes;
    this.pendingRoutes = [];
    for (const route of queued) {
      this.deliver(route);
    }
  }

  detachPresenter(): void {
    this.presenter = null;
  }

  private route(route: PendingRoute): void {
    if (this.presenter === null) {
      this.pendingRoutes.push(route);
      return;
    }
    this.deliver(route);
  }

  private deliver(route: PendingRoute): void {
    const presenter: DeepLinkPresenter | null = this.presenter;
    if (presenter === null) {
      this.pendingRoutes.push(route);
      return;
    }
    switch (route.kind) {
      case RouteKind.NEW_NOTE_EDITOR:
        presenter.presentNewNoteEditor(route.value === 'true');
        break;
      case RouteKind.SEARCH:
        presenter.presentSearch();
        break;
      case RouteKind.NOTE_WITH_KEY:
        presenter.presentNoteWithSimperiumKey(route.value);
        break;
      case RouteKind.NOTE:
        if (route.note !== null) {
          presenter.presentNote(route.note);
        }
        break;
      case RouteKind.NOTE_LIST:
        presenter.popToNoteList();
        break;
      case RouteKind.TARGET_PAGE:
        presenter.openTargetPage(route.value);
        break;
    }
  }

  private presentNewNoteEditor(useSelectedTag: boolean): void {
    const route: PendingRoute = new PendingRoute(RouteKind.NEW_NOTE_EDITOR);
    route.value = useSelectedTag ? 'true' : 'false';
    this.route(route);
  }

  private presentNoteWithSimperiumKey(simperiumKey: string): void {
    const route: PendingRoute = new PendingRoute(RouteKind.NOTE_WITH_KEY);
    route.value = simperiumKey;
    this.route(route);
  }

  // MARK: - User Activities

  /// Removes all of the shared UserActivities, whenever the API allows.
  /// HarmonyOS keeps no donated-activity store to purge; drop any route still queued for the signed-out user.
  unregisterSimplenoteActivities(): void {
    this.pendingRoutes = [];
    hilog.info(DOMAIN, LOG_TAG, 'unregisterSimplenoteActivities: no OS activity store on HarmonyOS; pending routes cleared');
  }

  /// Handles a UserActivity instance. Returns true on success.
  handleUserActivity(userActivity: UserActivity): boolean {
    const type: string = userActivity.activityType;
    if (ActivityType.ALL.indexOf(type) < 0) {
      return false;
    }

    if (!this.isAuthenticated) {
      return type === ActivityType.LAUNCH;
    }

    if (type === ActivityType.NEW_NOTE || type === ActivityType.NEW_NOTE_SHORTCUT) {
      this.presentNewNoteEditor(false);
    } else if (type === ActivityType.OPEN_NOTE || type === ActivityType.OPEN_SPOTLIGHT_ITEM) {
      this.presentNote(userActivity);
    } else if (type === ActivityType.OPEN_NOTE_SHORTCUT) {
      this.presentNoteForInteraction(userActivity.userInfo);
    }
    // ActivityType.LAUNCH: nothing to present.
    return true;
  }

  /// SessionHooks.handleUserActivity entry point: a URL handed to continueUserActivity. An interlink URL is the
  /// HarmonyOS form of an openNote activity (the source's userInfo identifier is the note's simperiumKey).
  handleUserActivityUrl(url: string): boolean {
    const parsed: ParsedUrl = ParsedUrl.parse(url);
    const key: string | null = parsed.interlinkSimperiumKey;
    if (key === null || key.length === 0) {
      return false;
    }
    const activity: UserActivity = new UserActivity(ActivityType.OPEN_NOTE, '');
    activity.userInfo.set(SEARCHABLE_ITEM_ACTIVITY_IDENTIFIER, key);
    return this.handleUserActivity(activity);
  }

  /// Displays a Note, whenever the UniqueIdentifier is contained within a given UserActivity instance.
  presentNote(userActivity: UserActivity): void {
    const uniqueIdentifier: string | undefined = userActivity.userInfo.get(SEARCHABLE_ITEM_ACTIVITY_IDENTIFIER);
    if (uniqueIdentifier === undefined) {
      return;
    }
    this.presentNoteWithSimperiumKey(uniqueIdentifier);
  }

  /// presentNote(for interaction: INInteraction?) — the intent response's userInfo.
  presentNoteForInteraction(interactionUserInfo: Map<string, string> | null): void {
    if (interactionUserInfo === null) {
      return;
    }
    const uniqueIdentifier: string | undefined = interactionUserInfo.get(INTENTS_NOTE_IDENTIFIER_KEY);
    if (uniqueIdentifier === undefined) {
      return;
    }
    this.presentNoteWithSimperiumKey(uniqueIdentifier);
  }

  // MARK: - Home Screen Quick Actions

  /// Clears home screen quick actions
  clearHomeScreenQuickActions(): void {
    this.shortcutItems = null;
    UserDefaults.standard.removeObject(RECENT_NOTE_KEY);
    // shortcutItems = nil: every quick action leaves the launcher, not only Recent.
    ShortcutsHandler.setShortcutVisible(SEARCH_SHORTCUT_ID, false);
    ShortcutsHandler.setShortcutVisible(NEW_NOTE_SHORTCUT_ID, false);
    ShortcutsHandler.setShortcutVisible(RECENT_SHORTCUT_ID, false);
  }

  /// Updates home screen quick actions in case they are empty
  updateHomeScreenQuickActionsIfNeeded(): void {
    if (this.shortcutItems !== null && this.shortcutItems.length > 0) {
      return;
    }
    this.updateHomeScreenQuickActions(null);
  }

  /// Updates home screen quick actions
  updateHomeScreenQuickActions(recentNote: Note | null): void {
    const items: ShortcutItem[] = [this.searchItem, this.newNoteItem];
    ShortcutsHandler.setShortcutVisible(SEARCH_SHORTCUT_ID, true);
    ShortcutsHandler.setShortcutVisible(NEW_NOTE_SHORTCUT_ID, true);
    const recent: ShortcutItem | null = this.noteItem(recentNote);
    if (recent !== null) {
      items.push(recent);
      // Publish: remember the note and reveal the static 'recent' shortcut. A null note (launch/login) keeps the
      // previously published Recent, as iOS shortcutItems persist across launches.
      UserDefaults.standard.set(RECENT_NOTE_KEY, (recentNote as Note).simperiumKey);
      ShortcutsHandler.setShortcutVisible(RECENT_SHORTCUT_ID, true);
    }
    this.shortcutItems = items;
  }

  private static setShortcutVisible(shortcutId: string, visible: boolean): void {
    try {
      shortcutManager.setShortcutVisibleForSelf(shortcutId, visible).catch((e: BusinessError) => {
        hilog.error(DOMAIN, LOG_TAG, 'setShortcutVisibleForSelf failed: %{public}d %{public}s', e.code, e.message);
      });
    } catch (e) {
      hilog.error(DOMAIN, LOG_TAG, 'setShortcutVisibleForSelf threw: %{public}s', JSON.stringify(e));
    }
  }

  /// Handles an application shortcut (a static module.json5 shortcut's Want, or a computed item's type/userInfo).
  handleApplicationShortcut(shortcutType: string, userInfo: Map<string, string> | null = null): void {
    if (!this.isAuthenticated) {
      return;
    }
    if (shortcutType === ApplicationShortcutItemType.SEARCH) {
      this.route(new PendingRoute(RouteKind.SEARCH));
    } else if (shortcutType === ApplicationShortcutItemType.NEW_NOTE) {
      this.presentNewNoteEditor(false);
    } else if (shortcutType === ApplicationShortcutItemType.NOTE) {
      const simperiumKey: string | undefined =
        userInfo === null ? undefined : userInfo.get(this.shortcutUserInfoNoteIdentifierKey);
      if (simperiumKey !== undefined) {
        this.presentNoteWithSimperiumKey(simperiumKey);
      }
    } else if (shortcutType === ApplicationShortcutItemType.RECENT) {
      const simperiumKey: string | null = UserDefaults.standard.string(RECENT_NOTE_KEY);
      if (simperiumKey !== null && simperiumKey.length > 0) {
        this.presentNoteWithSimperiumKey(simperiumKey);
      }
    }
  }

  private get searchItem(): ShortcutItem {
    return new ShortcutItem(ApplicationShortcutItemType.SEARCH, 'Search', null, 'icon_search', null);
  }

  private get newNoteItem(): ShortcutItem {
    return new ShortcutItem(ApplicationShortcutItemType.NEW_NOTE, 'New Note', null, 'icon_new_note', null);
  }

  private noteItem(note: Note | null): ShortcutItem | null {
    if (note === null || note.simperiumKey.length === 0) {
      return null;
    }
    const userInfo: Map<string, string> = new Map<string, string>();
    userInfo.set(this.shortcutUserInfoNoteIdentifierKey, note.simperiumKey);
    return new ShortcutItem(ApplicationShortcutItemType.NOTE, 'Recent', note.titlePreview, 'icon_all_notes', userInfo);
  }

  // MARK: - URL scheme (SPAppDelegate application:openURL:options:)

  /// Returns true when the URL was consumed. Authentication URLs (magic link / WordPress.com) are
  /// SessionHooks.performMagicLinkAuthentication's job and are tried by the caller first.
  handleOpenURL(url: string): boolean {
    if (!this.isAuthenticated) {
      return true;
    }
    const parsed: ParsedUrl = ParsedUrl.parse(url);

    // URL: Open a Note!
    if (this.handleOpenNote(parsed)) {
      return true;
    }
    if (this.handleOpenTagList(parsed)) {
      return true;
    }

    // Support opening Simplenote and optionally creating a new note
    if (parsed.host === NEW_NOTE_HOST) {
      const newNote: Note | null =
        NoteStore.sharedManager().newNoteWithContent(parsed.contentFromQuery(), parsed.tagsFromQuery());
      if (newNote !== null) {
        const route: PendingRoute = new PendingRoute(RouteKind.NOTE);
        route.note = newNote;
        this.route(route);
      }
    }
    if (parsed.host === WIDGET_NEW_NOTE_HOST) {
      // D9: the List widget header passes its tag (?tag=); the new note gets it through the selected tag.
      // iOS 4.55 ignores the query and never tags the note.
      const tags: string[] | null = parsed.tagsFromQuery();
      const tag: string | null = tags !== null && tags.length > 0 ? tags[0] : null;
      if (tag !== null && NoteStore.sharedManager().tagExists(tag)) {
        SessionStore.shared().selectedTag = tag;
        this.presentNewNoteEditor(true);
      } else {
        this.presentNewNoteEditor(false);
      }
    }
    return true;
  }

  /// handleOpenNote(url:)
  private handleOpenNote(parsed: ParsedUrl): boolean {
    const simperiumKey: string | null = parsed.interlinkSimperiumKey;
    if (simperiumKey === null) {
      return false;
    }
    let note: Note | null = null;
    for (const candidate of NoteStore.sharedManager().notes()) {
      if (candidate.simperiumKey === simperiumKey) {
        note = candidate;
        break;
      }
    }
    if (note === null) {
      return false;
    }
    const route: PendingRoute = new PendingRoute(RouteKind.NOTE);
    route.note = note;
    this.route(route);
    return true;
  }

  /// handleOpenTagList(url:)
  private handleOpenTagList(parsed: ParsedUrl): boolean {
    if (!parsed.isInternalTagURL) {
      return false;
    }
    const session: SessionStore = SessionStore.shared();
    const tag: string | null = parsed.internalTagKey;
    if (tag !== null) {
      session.selectedTag = NoteStore.sharedManager().tagExists(tag) ? tag : session.selectedTag;
    } else {
      session.selectedTag = null;
    }
    this.route(new PendingRoute(RouteKind.NOTE_LIST));
    return true;
  }

  // MARK: - Want entry point (UIAbility.onCreate / onNewWant)

  /// Routes a launch Want: replay targetPage, static shortcut, activity, then the URL scheme.
  /// Returns true when something was routed.
  handleWant(want: Want): boolean {
    const params: Record<string, Object> | undefined = want.parameters;
    if (params !== undefined) {
      const targetPage: Object | undefined = params[WANT_TARGET_PAGE_KEY];
      if (typeof targetPage === 'string' && (targetPage as string).length > 0) {
        const route: PendingRoute = new PendingRoute(RouteKind.TARGET_PAGE);
        route.value = targetPage as string;
        this.route(route);
        return true;
      }
      const shortcutType: Object | undefined = params[WANT_SHORTCUT_TYPE_KEY];
      if (typeof shortcutType === 'string') {
        this.handleApplicationShortcut(shortcutType as string, ShortcutsHandler.stringParams(params));
        return true;
      }
      const activityType: Object | undefined = params[WANT_ACTIVITY_TYPE_KEY];
      if (typeof activityType === 'string') {
        const activity: UserActivity = new UserActivity(activityType as string, '');
        activity.userInfo = ShortcutsHandler.stringParams(params);
        return this.handleUserActivity(activity);
      }
    }
    const uri: string | undefined = want.uri;
    if (uri !== undefined && uri.length > 0) {
      return this.handleOpenURL(uri);
    }
    // Widget FormLink 'router' event: the URL also travels in params (want.parameters.params, a JSON string).
    const widgetUrl: string | null = ShortcutsHandler.widgetUrl(params);
    if (widgetUrl !== null) {
      return this.handleOpenURL(widgetUrl);
    }
    return false;
  }

  private static widgetUrl(params: Record<string, Object> | undefined): string | null {
    const raw: Object | undefined = params === undefined ? undefined : params['params'];
    if (typeof raw !== 'string') {
      return null;
    }
    try {
      const parsed: Record<string, Object> = JSON.parse(raw as string) as Record<string, Object>;
      const url: Object | undefined = parsed['url'];
      return typeof url === 'string' && (url as string).length > 0 ? url as string : null;
    } catch (e) {
      return null;
    }
  }

  private static stringParams(params: Record<string, Object>): Map<string, string> {
    const out: Map<string, string> = new Map<string, string>();
    for (const key of Object.keys(params)) {
      const value: Object = params[key];
      if (typeof value === 'string') {
        out.set(key, value as string);
      }
    }
    return out;
  }
}

export { ShortcutsHandler as DeepLinkRouter };
