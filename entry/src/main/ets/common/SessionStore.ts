// Port of Simplenote/SPAppDelegate.m — the app-session half (lifecycle, selected tag, signed-in user,
// logout). The UIKit window/navigation half lives in EntryAbility + pages; EntryAbility forwards its
// lifecycle callbacks to the methods below.
//
// Collaborators the source calls directly (Simperium, PIN lock, tracker, shortcuts, editor, ...) are
// attached through SessionHooks at launch, so this module stays free of UI imports.
import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { emitter } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Options, OptionsEvent } from './OptionsStore';
import { NoteStore } from './NoteStore';
import {
  SPCredentials, SPSimperiumErrors, Simperium, SimperiumDelegate, SimperiumError, SimperiumNoteStoreBackend,
  buildSimplenoteSimperium
} from './simperium/Simperium';
import { SPBucket, SPBucketChangeType, SPBucketDelegate } from './simperium/Bucket';
import { SPDict } from './simperium/JsonDiff';
import { VersionsController } from './VersionsService';
import { MagicLinkAuthenticator, WPAuthHandler } from './AuthService';
import { SPTracker, SP_OPTIONS_TRACKER } from './Tracker';
import { KeychainManager } from './PinLockManager';
import { SPRatingsHelper } from './ratings/WPRatingsHelper';
import { AccountVerificationController, AccountVerificationState } from './AccountService';
import { SPUser } from '../model/SPUser';

const DOMAIN: number = 0x0001;
const LOG_TAG: string = 'SessionStore';
const SIGN_OUT_DELAY_MS: number = 750;
const SIMPERIUM_PROVIDER: string = 'simplenote.com';

/// AppStorage keys other layers read.
export class SessionKeys {
  static readonly SELECTED_TAG: string = 'selectedTag';
  static readonly USER_EMAIL: string = 'userEmail';
  static readonly AUTHENTICATED: string = 'authenticated';
  static readonly FIRST_LAUNCH: string = 'firstLaunch';
  static readonly SIGNING_USER_OUT: string = 'bSigningUserOut';
  static readonly SIGN_OUT_ACTIVITY_INDICATOR: string = 'signOutActivityIndicator';
  static readonly WINDOW_READY: string = 'windowReady';
  /// SPNoteListViewController.waitingForIndex (notes bucket indexing)
  static readonly WAITING_FOR_INDEX: string = 'notesWaitingForIndex';
}

/// Session events (NotificationCenter / SPBucket delegate equivalents).
export class SessionEvent {
  static readonly SELECTED_TAG_CHANGED: string = 'SPSelectedTagChanged';
  static readonly THEME_APPLIED: string = 'SPThemeApplied';
  static readonly DID_SIGN_OUT: string = 'SPDidSignOut';
  /// Simperium wants the login UI (authenticationViewControllerClass = SPOnboardingViewController)
  static readonly AUTHENTICATION_REQUIRED: string = 'SPAuthenticationRequired';
  /// Simperium dismissed the login UI (authentication succeeded)
  static readonly AUTHENTICATION_DISMISSED: string = 'SPAuthenticationDismissed';
}

/// Direct calls SPAppDelegate makes into other services. Each is attached at launch by the owner.
export class SessionHooks {
  authenticateSimperium: (() => void) | null = null;
  authenticateIfNecessary: (() => void) | null = null;
  simperiumSave: (() => Promise<void>) | null = null;
  signOutAndRemoveLocalData: (() => Promise<void>) | null = null;
  removePin: (() => void) | null = null;
  storeLastUsedTime: (() => void) | null = null;
  showPasscodeLockIfNecessary: (() => void) | null = null;
  dismissPasscodeLockIfPossible: (() => void) | null = null;
  trackApplicationOpened: (() => void) | null = null;
  trackApplicationClosed: (() => void) | null = null;
  performMagicLinkAuthentication: ((url: string) => boolean) | null = null;
  handleUserActivity: ((url: string) => boolean) | null = null;
  handleApplicationShortcut: ((shortcutType: string) => void) | null = null;
  unregisterActivities: (() => void) | null = null;
  clearAccountDeletionToken: (() => void) | null = null;
  authenticateIfAccountDeletionRequested: (() => void) | null = null;
  cleanupScrollPositionCache: (() => void) | null = null;
  ensureMigrationsHandled: (() => void) | null = null;
  setupAppRatings: (() => void) | null = null;
  /// ShortcutsHandler.shared.updateHomeScreenQuickActionsIfNeeded / clearHomeScreenQuickActions
  updateHomeScreenQuickActions: (() => void) | null = null;
  clearHomeScreenQuickActions: (() => void) | null = null;
  /// PublishController didReceiveUpdateNotificationForKey / didReceiveDeleteNotificationsForKey
  noteDidReceiveUpdate: ((key: string, memberNames: string[]) => void) | null = null;
  noteDidReceiveDelete: ((key: string) => void) | null = null;
  /// SPAppDelegate.noteEditorViewController didDeleteCurrentNote: the open editor registers itself here.
  noteEditorDidDeleteNote: ((key: string) => void) | null = null;
  /// SPAppDelegate.noteEditorViewController willReceiveNewContent / didReceiveNewContent (remote update of the open note).
  noteEditorWillReceiveNewContent: ((key: string) => void) | null = null;
  noteEditorDidReceiveNewContent: ((key: string) => void) | null = null;
  /// SPAppDelegate.logOutIfAccountDeletionRequested (invalid-token failure)
  logOutIfAccountDeletionRequested: (() => void) | null = null;
  /// SPAppDelegate show/dismissVerificationViewController: the note list pushes the configuration from
  /// takePendingVerificationConfiguration() / pops the AccountVerification page.
  showVerificationViewController: (() => void) | null = null;
  dismissVerificationViewController: (() => void) | null = null;
}

export class SessionStore {
  private static instance: SessionStore | null = null;

  readonly hooks: SessionHooks = new SessionHooks();
  private appContext: common.ApplicationContext | null = null;
  private selectedTagValue: string | null = null;
  private userEmailValue: string = '';
  private themeListener: ((data: emitter.EventData) => void) | null = null;
  private simperiumValue: Simperium | null = null;
  /// SPAppDelegate.verificationController: created on login, destroyed on logout.
  private verificationController: AccountVerificationController | null = null;
  /// SPAppDelegate.verificationViewController != nil: set when the screen is requested, cleared on dismiss.
  private verificationPresented: boolean = false;
  /// Requested configuration ('review' | 'verify') the note list has not pushed yet. Login swaps the note
  /// list in with router.clear() + replaceUrl, so the request can arrive before the list is on top.
  private pendingVerificationConfiguration: string | null = null;
  bSigningUserOut: boolean = false;
  /// SPModalActivityIndicator shown during sign out (mirrored to AppStorage for the UI).
  signOutActivityIndicator: boolean = false;

  static shared(): SessionStore {
    if (SessionStore.instance === null) {
      SessionStore.instance = new SessionStore();
    }
    return SessionStore.instance as SessionStore;
  }

  // MARK: - Frameworks setup

  authenticateSimperium(): void {
    if (this.hooks.authenticateSimperium !== null) {
      this.hooks.authenticateSimperium();
      return;
    }
    const simperium: Simperium | null = this.simperiumValue;
    if (simperium === null) {
      hilog.error(DOMAIN, LOG_TAG, 'authenticateSimperium: setupSimperium() has not run');
      return;
    }
    simperium.authenticateWithAppID(SPCredentials.SIMPERIUM_APP_ID, SPCredentials.SIMPERIUM_API_KEY);
  }

  get simperium(): Simperium | null {
    return this.simperiumValue;
  }

  /// SPAppDelegate setupSimperium + setupAuthenticator + configureVersionsController: builds the sync
  /// stack, installs the Simperium / bucket delegates and attaches the NoteStore backend.
  async setupSimperium(context: common.Context): Promise<Simperium> {
    if (this.simperiumValue !== null) {
      return this.simperiumValue as Simperium;
    }
    const simperium: Simperium = await buildSimplenoteSimperium(context);
    simperium.verboseLoggingEnabled = false;
    simperium.authenticationShouldBeEmbeddedInNavigationController = true;
    simperium.authenticationPresenter = (s: Simperium): void => {
      AppStorage.setOrCreate<boolean>(SessionKeys.AUTHENTICATED, false);
      emitter.emit(SessionEvent.AUTHENTICATION_REQUIRED);
    };
    simperium.authenticationDismisser = (s: Simperium): void => {
      AppStorage.setOrCreate<boolean>(SessionKeys.AUTHENTICATED, true);
      emitter.emit(SessionEvent.AUTHENTICATION_DISMISSED);
    };
    simperium.delegate = this.makeSimperiumDelegate();
    const bucketDelegate: SPBucketDelegate = this.makeBucketDelegate(simperium);
    const contentListener: (bucket: SPBucket) => void = (bucket: SPBucket): void => {
      NoteStore.sharedManager().notifyChanged();
    };
    for (const bucket of simperium.allBuckets) {
      bucket.notifyWhileIndexing = true;
      bucket.delegate = bucketDelegate;
    }
    simperium.notesBucket.addContentListener(contentListener);
    simperium.tagsBucket.addContentListener(contentListener);

    // setupAuthenticator
    simperium.authenticator.providerString = SIMPERIUM_PROVIDER;

    this.simperiumValue = simperium;
    // configureVersionsController (built lazily over Simperium.shared.notesBucket)
    VersionsController.shared();
    NoteStore.sharedManager().attachBackend(new SimperiumNoteStoreBackend(simperium));
    return simperium;
  }

  /// SPAppDelegate performMagicLinkAuthentication(with:) + performDotcomAuthenticationWithURL:
  performMagicLinkAuthentication(url: string): boolean {
    if (this.hooks.performMagicLinkAuthentication !== null) {
      return this.hooks.performMagicLinkAuthentication(url);
    }
    const simperium: Simperium | null = this.simperiumValue;
    if (simperium === null) {
      return false;
    }
    if (WPAuthHandler.isWPAuthenticationUrl(url)) {
      const user: SPUser | null = WPAuthHandler.authorizeSimplenoteUserFromUrl(url, SPCredentials.SIMPERIUM_APP_ID);
      if (user !== null) {
        simperium.user = user;
        simperium.authenticationDidSucceedForUsername(user.email ?? '', user.authToken ?? '');
        SPTracker.trackWPCCLoginSucceeded();
      }
      return true;
    }
    return new MagicLinkAuthenticator(simperium.authenticator).handle(url);
  }

  // MARK: - SimperiumDelegate

  private makeSimperiumDelegate(): SimperiumDelegate {
    const delegate: SimperiumDelegate = {
      simperiumDidLogin: (simperium: Simperium): void => {
        const user: SPUser | null = simperium.user;
        if (user === null) {
          return;
        }
        // Store the Token: Required by the Share Extension!
        KeychainManager.extensionToken = user.authToken;
        this.userEmailValue = user.email ?? '';
        AppStorage.setOrCreate<string>(SessionKeys.USER_EMAIL, this.userEmailValue);
        AppStorage.setOrCreate<boolean>(SessionKeys.AUTHENTICATED, true);
        const store: preferences.Preferences | null = Options.shared.store;
        if (store !== null) {
          store.putSync(SessionKeys.USER_EMAIL, this.userEmailValue);
          store.flushSync();
        }
        SPTracker.refreshMetadataWithEmail(this.userEmailValue);
        if (this.hooks.updateHomeScreenQuickActions !== null) {
          this.hooks.updateHomeScreenQuickActions();
        }
        this.setupVerificationController(this.userEmailValue);
      },
      simperiumDidLogout: (simperium: Simperium): void => {
        // Nuke Extension Token
        KeychainManager.extensionToken = null;
        SPTracker.refreshMetadataForAnonymousUser();
        if (this.hooks.clearHomeScreenQuickActions !== null) {
          this.hooks.clearHomeScreenQuickActions();
        }
        this.destroyVerificationController();
      },
      simperiumDidFailWithError: (simperium: Simperium, error: SimperiumError): void => {
        SPTracker.refreshMetadataForAnonymousUser();
        if (error.code === SPSimperiumErrors.INVALID_TOKEN && this.hooks.logOutIfAccountDeletionRequested !== null) {
          this.hooks.logOutIfAccountDeletionRequested();
        }
      }
    };
    return delegate;
  }

  // MARK: - SPBucketDelegate

  private makeBucketDelegate(simperium: Simperium): SPBucketDelegate {
    const delegate: SPBucketDelegate = {
      bucketDidChangeObjectForKey: (bucket: SPBucket, key: string, change: SPBucketChangeType,
        memberNames: string[] | null): void => {
        if (bucket === simperium.notesBucket) {
          if (change === SPBucketChangeType.UPDATE && this.hooks.noteDidReceiveUpdate !== null) {
            this.hooks.noteDidReceiveUpdate(key, memberNames ?? []);
          } else if (change === SPBucketChangeType.DELETE && this.hooks.noteDidReceiveDelete !== null) {
            this.hooks.noteDidReceiveDelete(key);
          }
          // SPAppDelegate.m: any remote update of the open note -> didReceiveNewContent (before the trash check).
          if (change === SPBucketChangeType.UPDATE && this.hooks.noteEditorDidReceiveNewContent !== null) {
            this.hooks.noteEditorDidReceiveNewContent(key);
          }
          // SPAppDelegate.m: a remote delete or trash (memberNames.firstObject == "deleted") of the open note.
          if ((change === SPBucketChangeType.DELETE ||
            (change === SPBucketChangeType.UPDATE && (memberNames ?? [])[0] === 'deleted')) &&
            this.hooks.noteEditorDidDeleteNote !== null) {
            this.hooks.noteEditorDidDeleteNote(key);
          }
        } else if (bucket === simperium.tagsBucket) {
          if (change === SPBucketChangeType.DELETE) {
            this.tagBucketDidDeleteObject(key);
          }
        } else if (bucket === simperium.settingsBucket) {
          SPRatingsHelper.sharedInstance().reloadSettings();
        } else if (bucket === simperium.accountBucket && key === SPCredentials.SIMPERIUM_EMAIL_VERIFICATION_OBJECT_KEY) {
          this.updateVerificationController(bucket);
        }
        NoteStore.sharedManager().notifyChanged();
      },
      // SPAppDelegate.m bucket:willChangeObjectsForKeys: runs before the remote changes are applied.
      bucketWillChangeObjectsForKeys: (bucket: SPBucket, keys: Set<string>): void => {
        const hook: ((key: string) => void) | null = this.hooks.noteEditorWillReceiveNewContent;
        if (bucket === simperium.notesBucket && hook !== null) {
          keys.forEach((key: string): void => hook(key));
        }
      },
      bucketDidReceiveObjectForKey: (bucket: SPBucket, key: string, version: string, data: SPDict): void => {
        if (bucket !== simperium.notesBucket) {
          return;
        }
        const versions: VersionsController | null = VersionsController.shared();
        if (versions !== null) {
          versions.didReceiveObject(key, parseInt(version), data);
        }
      },
      bucketWillStartIndexing: (bucket: SPBucket): void => {
        if (bucket === simperium.notesBucket) {
          AppStorage.setOrCreate<boolean>(SessionKeys.WAITING_FOR_INDEX, true);
        }
      },
      bucketDidFinishIndexing: (bucket: SPBucket): void => {
        if (bucket === simperium.notesBucket) {
          AppStorage.setOrCreate<boolean>(SessionKeys.WAITING_FOR_INDEX, false);
          NoteStore.sharedManager().notifyChanged();
        } else if (bucket === simperium.accountBucket) {
          this.updateVerificationController(bucket);
        }
      }
    };
    return delegate;
  }

  // MARK: - Account Verification (SPAppDelegate+Extensions.swift)

  private setupVerificationController(email: string): void {
    if (email.length === 0) {
      return;
    }
    const controller: AccountVerificationController = new AccountVerificationController(email);
    controller.onStateChange = (oldState: AccountVerificationState, state: AccountVerificationState): void => {
      if (oldState === AccountVerificationState.UNKNOWN && state === AccountVerificationState.UNVERIFIED) {
        this.showVerificationViewController('review');
      } else if (oldState === AccountVerificationState.UNKNOWN &&
        state === AccountVerificationState.VERIFICATION_IN_PROGRESS) {
        this.showVerificationViewController('verify');
      } else if ((oldState === AccountVerificationState.UNVERIFIED ||
        oldState === AccountVerificationState.VERIFICATION_IN_PROGRESS) && state === AccountVerificationState.VERIFIED) {
        this.dismissVerificationViewController();
      }
    };
    this.verificationController = controller;
  }

  /// Also forgets a request from the previous account, so the next login can show the screen again.
  private destroyVerificationController(): void {
    this.verificationController = null;
    this.verificationPresented = false;
    this.pendingVerificationConfiguration = null;
  }

  /// SPAppDelegate.m bucket hooks: feed the Account bucket's email-verification object to the controller.
  private updateVerificationController(accountBucket: SPBucket): void {
    if (this.verificationController !== null) {
      this.verificationController.update(
        accountBucket.objectForKey(SPCredentials.SIMPERIUM_EMAIL_VERIFICATION_OBJECT_KEY)?.dictionary());
    }
  }

  private showVerificationViewController(configuration: string): void {
    // As iOS: with the demo key 'not-required' the email-verification object never exists, so every account is
    // UNVERIFIED and 'Review Your Account' shows after each login and launch (the iOS dev build does the same).
    if (this.verificationController === null || this.verificationPresented) {
      return;
    }
    this.verificationPresented = true;
    this.pendingVerificationConfiguration = configuration;
    if (this.hooks.showVerificationViewController !== null) {
      this.hooks.showVerificationViewController();
    }
  }

  private dismissVerificationViewController(): void {
    this.pendingVerificationConfiguration = null;
    if (this.verificationPresented && this.hooks.dismissVerificationViewController !== null) {
      this.hooks.dismissVerificationViewController();
    }
    this.verificationPresented = false;
  }

  /// The note list takes the requested configuration once, when it is the top page.
  takePendingVerificationConfiguration(): string | null {
    const configuration: string | null = this.pendingVerificationConfiguration;
    this.pendingVerificationConfiguration = null;
    return configuration;
  }

  /// UIWindow + sidebar/navigation are built by EntryAbility.onWindowStageCreate; here we publish
  /// the initial session state those pages bind to.
  setupDefaultWindow(): void {
    AppStorage.setOrCreate<string>(SessionKeys.SELECTED_TAG, this.selectedTagValue === null ? '' : this.selectedTagValue);
    AppStorage.setOrCreate<string>(SessionKeys.USER_EMAIL, this.userEmailValue);
    AppStorage.setOrCreate<boolean>(SessionKeys.SIGNING_USER_OUT, false);
    AppStorage.setOrCreate<boolean>(SessionKeys.SIGN_OUT_ACTIVITY_INDICATOR, false);
    AppStorage.setOrCreate<boolean>(SessionKeys.WINDOW_READY, true);
  }

  /// AppCenter Distribute is iOS-only; HarmonyOS updates ship through AppGallery.
  setupAppCenter(): void {
    hilog.info(DOMAIN, LOG_TAG, 'AppCenter distribution not available on HarmonyOS; skipped');
  }

  /// Sentry crash logging has no HarmonyOS SDK here; hilog + FaultLogger cover crash capture.
  setupCrashLogging(): void {
    hilog.info(DOMAIN, LOG_TAG, 'crash logging: using system FaultLogger');
  }

  setupThemeNotifications(): void {
    if (this.themeListener !== null) {
      return;
    }
    const listener: (data: emitter.EventData) => void = (data: emitter.EventData): void => {
      this.themeDidChange();
    };
    this.themeListener = listener;
    emitter.on(OptionsEvent.SIMPLENOTE_THEME_CHANGED, listener);
  }

  // MARK: - AppDelegate lifecycle (called from EntryAbility)

  applicationWillFinishLaunching(context: common.UIAbilityContext): boolean {
    this.appContext = context.getApplicationContext();
    Options.shared.load(context);
    Options.shared.tracker = SP_OPTIONS_TRACKER;
    this.userEmailValue = this.readStoredEmail();
    AppStorage.setOrCreate<boolean>(SessionKeys.AUTHENTICATED, this.userEmailValue.length > 0);
    this.setupThemeNotifications();
    this.setupAppCenter();
    this.setupCrashLogging();
    this.setupDefaultWindow();
    return true;
  }

  applicationDidFinishLaunching(): boolean {
    // Once the UI is wired, Auth Simperium
    this.authenticateSimperium();

    if (this.hooks.ensureMigrationsHandled !== null) {
      this.hooks.ensureMigrationsHandled();
    }
    if (this.hooks.setupAppRatings !== null) {
      this.hooks.setupAppRatings();
    }

    this.loadSelectedTheme();

    // Check to see if first time user
    if (this.isFirstLaunch()) {
      AppStorage.setOrCreate<boolean>(SessionKeys.FIRST_LAUNCH, true);
      if (this.hooks.removePin !== null) {
        this.hooks.removePin();
      }
      this.markFirstLaunch();
    } else {
      AppStorage.setOrCreate<boolean>(SessionKeys.FIRST_LAUNCH, false);
      if (this.hooks.showPasscodeLockIfNecessary !== null) {
        this.hooks.showPasscodeLockIfNecessary();
      }
    }
    return true;
  }

  applicationDidBecomeActive(): void {
    if (this.hooks.trackApplicationOpened !== null) {
      this.hooks.trackApplicationOpened();
    }
  }

  // iOS sends willEnterForeground only after a background; HarmonyOS also calls onForeground on
  // a cold launch, which must not dismiss the launch lock.
  private wasInBackground: boolean = false;

  applicationDidEnterBackground(): void {
    this.wasInBackground = true;
    if (this.hooks.trackApplicationClosed !== null) {
      this.hooks.trackApplicationClosed();
    }
    // For the passcode lock, store the current clock time for comparison when returning to the app
    if (this.hooks.storeLastUsedTime !== null) {
      this.hooks.storeLastUsedTime();
    }
    if (this.hooks.showPasscodeLockIfNecessary !== null) {
      this.hooks.showPasscodeLockIfNecessary();
    }
    if (this.hooks.cleanupScrollPositionCache !== null) {
      this.hooks.cleanupScrollPositionCache();
    }
  }

  applicationWillEnterForeground(): void {
    if (this.wasInBackground && this.hooks.dismissPasscodeLockIfPossible !== null) {
      this.hooks.dismissPasscodeLockIfPossible();
    }
    if (this.hooks.authenticateIfAccountDeletionRequested !== null) {
      this.hooks.authenticateIfAccountDeletionRequested();
    }
  }

  /// continueUserActivity: magic-link login first, then Spotlight / Handoff note links.
  applicationContinueUserActivity(url: string): boolean {
    if (this.performMagicLinkAuthentication(url)) {
      return true;
    }
    if (this.hooks.handleUserActivity !== null) {
      return this.hooks.handleUserActivity(url);
    }
    return false;
  }

  applicationPerformActionForShortcutItem(shortcutType: string): void {
    if (this.hooks.handleApplicationShortcut !== null) {
      this.hooks.handleApplicationShortcut(shortcutType);
    }
  }

  applicationWillResignActive(): void {
    // Save any pending changes
    NoteStore.sharedManager().flushPendingContent();
  }

  applicationWillTerminate(): void {
    // Save any pending changes
    NoteStore.sharedManager().flushPendingContent();
  }

  applicationShouldSaveSecureApplicationState(): boolean {
    return true;
  }

  applicationShouldRestoreSecureApplicationState(): boolean {
    return true;
  }

  /// dealloc: stop observing notifications.
  dealloc(): void {
    if (this.themeListener !== null) {
      emitter.off(OptionsEvent.SIMPLENOTE_THEME_CHANGED, this.themeListener);
      this.themeListener = null;
    }
  }

  // MARK: - First launch

  isFirstLaunch(): boolean {
    return Options.shared.firstLaunch === false;
  }

  markFirstLaunch(): void {
    Options.shared.firstLaunch = true;
  }

  // MARK: - Theme

  /// SPUserInterface.refreshUserInterfaceStyle
  loadSelectedTheme(): void {
    if (this.appContext === null) {
      return;
    }
    Options.shared.applyTheme(this.appContext as common.ApplicationContext);
  }

  private themeDidChange(): void {
    this.loadSelectedTheme();
    const data: emitter.EventData = { data: { 'theme': Options.shared.themeDescription } };
    emitter.emit(SessionEvent.THEME_APPLIED, data);
  }

  // MARK: - Selected tag

  get selectedTag(): string | null {
    return this.selectedTagValue;
  }

  set selectedTag(selectedTag: string | null) {
    if (this.selectedTagValue === selectedTag) {
      return;
    }
    this.selectedTagValue = selectedTag;
    const value: string = selectedTag === null ? '' : selectedTag;
    AppStorage.setOrCreate<string>(SessionKeys.SELECTED_TAG, value);
    const data: emitter.EventData = { data: { 'selectedTag': value } };
    emitter.emit(SessionEvent.SELECTED_TAG_CHANGED, data);
  }

  /// SPBucket delegate: a deleted tag that is selected swaps the list back to All Notes.
  tagBucketDidDeleteObject(key: string): void {
    if (this.selectedTagValue !== null && key === this.selectedTagValue) {
      this.selectedTag = null;
    }
  }

  // MARK: - Signed-in user

  get userEmail(): string {
    return this.userEmailValue;
  }

  get isAuthenticated(): boolean {
    return this.authToken().length > 0;
  }

  /// Called by the auth flow with a Simperium token; the Simperium authenticator stores the credentials
  /// (single source of truth: authenticator keychain + SPUsername), and simperiumDidLogin publishes the user.
  setUser(email: string, token: string): void {
    const simperium: Simperium | null = this.simperiumValue;
    if (simperium === null) {
      hilog.error(DOMAIN, LOG_TAG, 'setUser before setupSimperium()');
      return;
    }
    simperium.authenticator.authenticateWithUsernameAndToken(email, token);
  }

  /// The signed-in user's Simperium token (Simperium.user, restored from the authenticator's keychain).
  authToken(): string {
    const simperium: Simperium | null = this.simperiumValue;
    if (simperium === null || simperium.user === null) {
      return '';
    }
    return simperium.user.authToken ?? '';
  }

  // MARK: - Save / Logout

  async save(): Promise<void> {
    if (this.hooks.simperiumSave !== null) {
      await this.hooks.simperiumSave();
    } else if (this.simperiumValue !== null) {
      await this.simperiumValue.save();
    } else {
      await NoteStore.sharedManager().save();
    }
  }

  async logoutAndReset(): Promise<void> {
    this.bSigningUserOut = true;
    AppStorage.setOrCreate<boolean>(SessionKeys.SIGNING_USER_OUT, true);
    this.signOutActivityIndicator = true;
    AppStorage.setOrCreate<boolean>(SessionKeys.SIGN_OUT_ACTIVITY_INDICATOR, true);

    // Reset State
    if (this.hooks.unregisterActivities !== null) {
      this.hooks.unregisterActivities();
    }
    if (this.hooks.clearAccountDeletionToken !== null) {
      this.hooks.clearAccountDeletionToken();
    }

    // Actual Simperium Logout
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), SIGN_OUT_DELAY_MS);
    });
    try {
      if (this.hooks.signOutAndRemoveLocalData !== null) {
        await this.hooks.signOutAndRemoveLocalData();
      } else if (this.simperiumValue !== null) {
        const simperium: Simperium = this.simperiumValue as Simperium;
        await new Promise<void>((resolve: () => void) => {
          simperium.signOutAndRemoveLocalData(true, () => resolve());
        });
      }
    } finally {
      this.selectedTag = null;
      this.userEmailValue = '';
      AppStorage.setOrCreate<string>(SessionKeys.USER_EMAIL, '');
      AppStorage.setOrCreate<boolean>(SessionKeys.AUTHENTICATED, false);
      const store: preferences.Preferences | null = Options.shared.store;
      if (store !== null) {
        store.deleteSync(SessionKeys.USER_EMAIL);
        store.flushSync();
      }

      // Nuke all of the User Preferences
      Options.shared.reset();

      // remove the pin lock
      if (this.hooks.removePin !== null) {
        this.hooks.removePin();
      }

      this.signOutActivityIndicator = false;
      AppStorage.setOrCreate<boolean>(SessionKeys.SIGN_OUT_ACTIVITY_INDICATOR, false);
      emitter.emit(SessionEvent.DID_SIGN_OUT);

      if (this.hooks.authenticateIfNecessary !== null) {
        this.hooks.authenticateIfNecessary();
      } else if (this.simperiumValue !== null) {
        this.simperiumValue.authenticateIfNecessary();
      }
      this.bSigningUserOut = false;
      AppStorage.setOrCreate<boolean>(SessionKeys.SIGNING_USER_OUT, false);
    }
  }

  // MARK: - Private

  private readStoredEmail(): string {
    const store: preferences.Preferences | null = Options.shared.store;
    if (store === null) {
      return '';
    }
    const value: preferences.ValueType = store.getSync(SessionKeys.USER_EMAIL, '');
    return typeof value === 'string' ? value as string : '';
  }
}

// Source-symbol alias (SPAppDelegate.sharedDelegate()).
export { SessionStore as SPAppDelegate };
