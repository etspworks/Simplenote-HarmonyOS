import { AbilityConstant, bundleManager, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { SessionStore } from '../common/SessionStore';
import { ShortcutsHandler, WANT_TARGET_PAGE_KEY } from '../common/DeepLinkRouter';
import { PublishController } from '../common/PublishService';
import { SPPinLockManager } from '../common/PinLockManager';
import { SPTracker } from '../common/Tracker';
import { SPRatingsHelper } from '../common/ratings/WPRatingsHelper';
import { NoticeController } from '../common/NoticeCenter';
import { cleanupScrollPositionCache } from '../common/NoteScrollPositionCache';
import { WidgetController } from '../common/WidgetController';
import { restoreOpenNote } from '../common/OpenNoteRestoration';

const DOMAIN = 0x0000;

export default class EntryAbility extends UIAbility {
  private launched: boolean = false;
  private pendingWant: Want | null = null;

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    try {
      this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
    } catch (err) {
      hilog.error(DOMAIN, 'testTag', 'Failed to set colorMode. Cause: %{public}s', JSON.stringify(err));
    }
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onCreate');

    const session: SessionStore = SessionStore.shared();
    this.installSessionHooks();
    session.applicationWillFinishLaunching(this.context);
    // Replay deep link: a targetPage is routed at once (ShortcutsHandler queues it until the root page
    // attaches its presenter after the window loads); every other Want waits for the sync stack.
    if (!this.routeTargetPage(want)) {
      this.pendingWant = want;
    }
    session.setupSimperium(this.context).then(() => {
      session.applicationDidFinishLaunching();
      ShortcutsHandler.shared.updateHomeScreenQuickActionsIfNeeded();
      this.launched = true;
      this.refreshWidgets();
      const initial: Want | null = this.pendingWant;
      this.pendingWant = null;
      // State restoration: reopen the last open note unless the launch Want routed somewhere itself.
      if (initial !== null && !this.routeWant(initial)) {
        restoreOpenNote();
      }
    }).catch((e: Error) => {
      hilog.error(DOMAIN, 'testTag', 'Simperium setup failed: %{public}s', e.message);
    });
  }

  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    if (this.routeTargetPage(want)) {
      return;
    }
    if (!this.launched) {
      this.pendingWant = want;
      return;
    }
    this.routeWant(want);
  }

  onDestroy(): void {
    SessionStore.shared().applicationWillTerminate();
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onWindowStageCreate');

    windowStage.loadContent('pages/SPNoteListViewControllerPage', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, 'testTag', 'Failed to load the content. Cause: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, 'testTag', 'Succeeded in loading the content.');
      this.setupNoticeController(windowStage);
      // ShortcutsHandler.shared.attachPresenter(...) is done by the root page (SPNoteListViewControllerPage)
      // in aboutToAppear, once it can navigate; routes that arrive before then stay queued in ShortcutsHandler.
    });
  }

  onWindowStageDestroy(): void {
    NoticeController.shared.presenter.attachContainer(null, null);
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onWindowStageDestroy');
  }

  onForeground(): void {
    const session: SessionStore = SessionStore.shared();
    session.applicationWillEnterForeground();
    session.applicationDidBecomeActive();
  }

  onBackground(): void {
    const session: SessionStore = SessionStore.shared();
    session.applicationWillResignActive();
    session.applicationDidEnterBackground();
    if (this.launched) {
      this.refreshWidgets();
    }
  }

  /// SPAppDelegate syncWidgetDefaults + resetWidgetTimelines
  private refreshWidgets(): void {
    WidgetController.syncWidgetDefaults(SessionStore.shared().isAuthenticated);
    WidgetController.reloadAll(this.context);
  }

  /// want.parameters.targetPage (replay deep link). Returns true when the Want carried one.
  private routeTargetPage(want: Want): boolean {
    const params: Record<string, Object> | undefined = want.parameters;
    if (params === undefined) {
      return false;
    }
    const targetPage: Object | undefined = params[WANT_TARGET_PAGE_KEY];
    if (typeof targetPage !== 'string' || (targetPage as string).length === 0) {
      return false;
    }
    ShortcutsHandler.shared.handleWant(want);
    return true;
  }

  /// Launch / new Want: magic-link or WordPress.com auth URL first, then shortcuts, activities, targetPage
  /// and the simplenote:// scheme (ShortcutsHandler.handleWant). Returns true when something was routed.
  private routeWant(want: Want): boolean {
    const uri: string | undefined = want.uri;
    if (uri !== undefined && uri.length > 0 && SessionStore.shared().performMagicLinkAuthentication(uri)) {
      return true;
    }
    return ShortcutsHandler.shared.handleWant(want);
  }

  /// SPAppDelegate setupNoticeController: the notice presenter tracks the main window's keyboard.
  private setupNoticeController(windowStage: window.WindowStage): void {
    try {
      const mainWindow: window.Window = windowStage.getMainWindowSync();
      NoticeController.shared.presenter.attachContainer(null, mainWindow);
      NoticeController.shared.setupNoticeController();
    } catch (e) {
      hilog.error(DOMAIN, 'testTag', 'Notice setup failed: %{public}s', JSON.stringify(e));
    }
  }

  /// The direct calls SPAppDelegate makes into services that SessionStore cannot import itself.
  private installSessionHooks(): void {
    const hooks = SessionStore.shared().hooks;
    hooks.removePin = (): void => {
      SPPinLockManager.shared.removePin();
    };
    hooks.storeLastUsedTime = (): void => {
      SPPinLockManager.shared.storeLastUsedTime();
    };
    hooks.trackApplicationOpened = (): void => {
      SPTracker.trackApplicationOpened();
    };
    hooks.trackApplicationClosed = (): void => {
      SPTracker.trackApplicationClosed();
    };
    hooks.setupAppRatings = (): void => {
      let version: string = '';
      try {
        version = bundleManager.getBundleInfoForSelfSync(
          bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT).versionName;
      } catch (e) {
        hilog.error(DOMAIN, 'testTag', 'bundle version unavailable: %{public}s', JSON.stringify(e));
      }
      SPRatingsHelper.sharedInstance().initializeForVersion(version);
      SPRatingsHelper.sharedInstance().reloadSettings();
    };
    hooks.handleUserActivity = (url: string): boolean => {
      return ShortcutsHandler.shared.handleUserActivityUrl(url);
    };
    hooks.handleApplicationShortcut = (shortcutType: string): void => {
      ShortcutsHandler.shared.handleApplicationShortcut(shortcutType);
    };
    hooks.unregisterActivities = (): void => {
      ShortcutsHandler.shared.unregisterSimplenoteActivities();
    };
    hooks.updateHomeScreenQuickActions = (): void => {
      ShortcutsHandler.shared.updateHomeScreenQuickActionsIfNeeded();
      // simperiumDidLogin: syncWidgetDefaults
      WidgetController.syncWidgetDefaults(true);
      WidgetController.reloadAll(this.context);
    };
    hooks.clearHomeScreenQuickActions = (): void => {
      ShortcutsHandler.shared.clearHomeScreenQuickActions();
      // simperiumDidLogout: syncWidgetDefaults
      WidgetController.syncWidgetDefaults(false);
      WidgetController.reloadAll(this.context);
    };
    hooks.cleanupScrollPositionCache = (): void => {
      cleanupScrollPositionCache();
    };
    hooks.noteDidReceiveUpdate = (key: string, memberNames: string[]): void => {
      PublishController.shared.didReceiveUpdateNotification(key, memberNames);
    };
    hooks.noteDidReceiveDelete = (key: string): void => {
      PublishController.shared.didReceiveDeleteNotification(key);
    };
  }
}
