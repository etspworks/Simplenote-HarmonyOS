// Port of SPSettingsViewController (+Extensions). The source presents it as a formSheet navigation
// stack over the note list (SPAppDelegate.presentSettingsViewController, from the tag drawer's
// Settings row); here it is a routed page and its Done pops back.
// S3: the grouped-table structure (sections NOTES / TAGS / APPEARANCE / SECURITY / ACCOUNT /
// Delete / About / Help), every control of the source table, the timeout picker and the two
// activity overlays. The Debug section is INTERNAL_DISTRIBUTION only and is not built.
import { router, LengthMetrics, EditableTitleBar, EditableLeftIconType } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { SessionStore } from '../common/SessionStore';
import { SPPinLockManager, Biometry, PIN_TIMEOUT_PREFERENCES_KEY } from '../common/PinLockManager';
import { Options, DefaultsKey, sortModeDescription, themeDescription } from '../common/OptionsStore';
import { StatusChecker } from '../common/StatusChecker';
import { SPTracker } from '../common/Tracker';
import { AccountDeletionController } from '../common/AccountService';
import { RemoteResult } from '../common/endpoints/Remote';
import { Simperium } from '../common/simperium/Simperium';
import { SPBucket, SPDiffableObject } from '../common/simperium/Bucket';
import { Preferences } from '../model/Preferences';
import { SPUser } from '../model/SPUser';
import { SortMode } from '../model/SortMode';
import { Theme } from '../model/Theme';
import { PinLockRouteParams } from './SPNoteListViewControllerPage';
import { SpinnerViewController } from '../components/SpinnerOverlay';
import { SPModalActivityIndicator } from '../components/ModalActivityIndicator';
import { HmIconButton } from '../components/HmIconButton';

const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'Settings';

const HELP_URL: string = 'https://simplenote.com/help';
const WEB_APP_URL: string = 'https://app.simplenote.com';
/// Simperium+Simplenote.m preferencesObject: the one Preferences object's key.
const PREFERENCES_OBJECT_KEY: string = 'preferences-key';
/// StoreConstants.activeSubscriptionLevel
const ACTIVE_SUBSCRIPTION_LEVEL: string = 'sustainer';

/// SPAppDelegate.accountDeletionController
const ACCOUNT_DELETION_CONTROLLER: AccountDeletionController = new AccountDeletionController();

/// timeoutPickerOptions (viewDidLoad), indexed by kPinTimeoutPreferencesKey.
const TIMEOUT_PICKER_OPTIONS: string[] = [
  'Off', '15 Seconds', '30 Seconds', '1 Minute', '2 Minutes', '3 Minutes', '4 Minutes', '5 Minutes'
];

/// One table row's bound values. A @Builder called with a bare object literal (no `as` cast)
/// receives it by reference, so the row re-renders when the page's state behind it changes.
interface SettingsRow {
  slug: string;
  title: string;
  value?: string;
  /// cell.textLabel.textColor: simplenoteTextColor, Log Out tint, Delete Account red button.
  titleColor?: ResourceColor;
  isOn?: boolean;
  /// cell.accessoryType = DisclosureIndicator; false for Lock Timeout (iOS sets no accessory there).
  showsDisclosure?: boolean;
  action?: () => void;
  onToggle?: (isOn: boolean) => void;
}

@Entry
@Component
struct SPSettingsViewControllerPage {
  @State username: string = '';
  @StorageLink('listSortMode') sortMode: SortMode = SortMode.MODIFIED_NEWEST;
  @StorageLink('theme') theme: Theme = Theme.SYSTEM;
  @StorageLink('condensedNotesList') condensed: boolean = false;
  @State indexInSpotlight: boolean = false;
  @StorageLink('SPAlphabeticalTagSortPref') alphabeticalTags: boolean = false;
  @State isSustainer: boolean = false;
  @State useSustainerIcon: boolean = false;
  @State pinEnabled: boolean = false;
  @State biometryAvailable: boolean = false;
  @State biometryTitle: string = 'Face ID';
  @State useBiometry: boolean = false;
  @State pinTimeout: number = 0;
  @State showTimeoutPicker: boolean = false;
  @State showSpinner: boolean = false;
  @State signingOut: boolean = false;
  /// simperium.preferencesObject (drives the Sustainer row).
  preferences: Preferences | null = null;

  aboutToAppear(): void {
    this.reload();
  }

  onPageShow(): void {
    // viewWillAppear: -> [tableView reloadData]
    this.reload();
  }

  reload(): void {
    this.username = SessionStore.shared().userEmail;
    this.sortMode = Options.shared.listSortMode;
    this.theme = Options.shared.theme;
    this.condensed = Options.shared.condensedNotesList;
    this.indexInSpotlight = Options.shared.indexNotesInSpotlight;
    this.alphabeticalTags = Options.shared.alphabeticalTagSortPref;
    this.pinEnabled = SPPinLockManager.shared.isEnabled;
    const biometry: Biometry | null = SPPinLockManager.shared.availableBiometry;
    this.biometryAvailable = biometry !== null;
    this.biometryTitle = biometry === Biometry.TOUCH_ID ? 'Touch ID' : 'Face ID';
    this.useBiometry = SPPinLockManager.shared.shouldUseBiometry;
    this.pinTimeout = this.readInteger(PIN_TIMEOUT_PREFERENCES_KEY);
    this.useSustainerIcon = this.readBool(DefaultsKey.USE_SUSTAINER_ICON);
    this.preferences = this.preferencesObject();
    // showSustainerSwitch: preferences.isActiveSubscriber || preferences.wasSustainer
    this.isSustainer = this.preferences !== null &&
      (this.preferences.subscription_level === ACTIVE_SUBSCRIPTION_LEVEL || (this.preferences.was_sustainer ?? 0) !== 0);
  }

  private preferencesObject(): Preferences | null {
    const simperium: Simperium | null = Simperium.shared;
    if (simperium === null) {
      return null;
    }
    const bucket: SPBucket = simperium.preferencesBucket;
    const object: SPDiffableObject | undefined = bucket.objectForKey(PREFERENCES_OBJECT_KEY);
    return object instanceof Preferences ? object as Preferences : null;
  }

  private readInteger(key: string): number {
    const store: preferences.Preferences | null = Options.shared.store;
    if (store === null) {
      return 0;
    }
    const value: preferences.ValueType = store.getSync(key, 0);
    const row: number = typeof value === 'number' ? Math.trunc(value as number) : 0;
    return row >= 0 && row < TIMEOUT_PICKER_OPTIONS.length ? row : 0;
  }

  private readBool(key: string): boolean {
    const store: preferences.Preferences | null = Options.shared.store;
    if (store === null) {
      return false;
    }
    const value: preferences.ValueType = store.getSync(key, false);
    return typeof value === 'boolean' ? value as boolean : false;
  }

  private writeDefault(key: string, value: preferences.ValueType): void {
    const store: preferences.Preferences | null = Options.shared.store;
    if (store === null) {
      hilog.error(DOMAIN, LOG_TAG, 'defaults not loaded: %{public}s', key);
      return;
    }
    store.putSync(key, value);
    store.flushSync();
  }

  /// UIApplication openURL: -> the system browser.
  private openURL(url: string): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    context.openLink(url).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'openLink %{public}s failed: %{public}s', url, e.message);
    });
  }

  private showToast(message: string): void {
    this.getUIContext().getPromptAction().showToast({ message: message });
  }

  /// doneAction: -> dismissViewController (back to the note list).
  doneAction(): void {
    router.back();
  }

  /// tableView:didSelectRowAtIndexPath: -> pushViewController (Sort Order / Theme / Privacy Settings).
  pushPage(url: string): void {
    router.pushUrl({ url: url }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'push %{public}s failed: %{public}s', url, e.message);
    });
  }

  showSortOrder(): void {
    this.pushPage('pages/SPSortOrderViewControllerPage');
  }

  showTheme(): void {
    this.pushPage('pages/SPThemeViewControllerPage');
  }

  showPrivacy(): void {
    this.pushPage('pages/SPPrivacyViewControllerPage');
  }

  /// About row -> presentViewController(SPAboutViewController).
  showAbout(): void {
    this.pushPage('pages/SPAboutViewControllerPage');
  }

  /// Help row -> openURL https://simplenote.com/help
  showHelp(): void {
    this.openURL(HELP_URL);
  }

  /// showPinLockViewController: PinLockRemoveController when a PIN is set, else PinLockSetupController.
  showPinLockViewController(): void {
    const params: PinLockRouteParams = new PinLockRouteParams();
    params.mode = SPPinLockManager.shared.isEnabled ? 'remove' : 'setup';
    router.pushUrl({ url: 'pages/PinLockViewControllerPage', params: params }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'pin lock failed: %{public}s', e.message);
    });
  }

  /// Lock Timeout row -> [pinTimeoutTextField becomeFirstResponder] (shows the picker).
  showLockTimeoutPicker(): void {
    this.showTimeoutPicker = true;
  }

  /// pinTimeoutDoneAction: -> resignFirstResponder.
  pinTimeoutDoneAction(): void {
    this.showTimeoutPicker = false;
  }

  /// pickerView:didSelectRow: -> kPinTimeoutPreferencesKey = row.
  pinTimeoutDidSelect(row: number): void {
    this.pinTimeout = row;
    this.writeDefault(PIN_TIMEOUT_PREFERENCES_KEY, row);
  }

  condensedSwitchDidChangeValue(isOn: boolean): void {
    this.condensed = isOn;
    Options.shared.condensedNotesList = isOn;
    SPTracker.trackSettingsListCondensedEnabled(isOn);
  }

  /// On: CSSearchableIndex indexSpotlightItemsIn (no third-party content index on HarmonyOS: the
  /// preference persists and the user is told). Off: deleteAllSearchableItems -> presentIndexRemovalAlert.
  indexNotesSwitchDidChangeValue(isOn: boolean): void {
    this.indexInSpotlight = isOn;
    Options.shared.indexNotesInSpotlight = isOn;
    if (isOn) {
      this.showToast('Search indexing of notes is not available on this platform');
    } else {
      this.presentIndexRemovalAlert();
    }
  }

  presentIndexRemovalAlert(): void {
    const alert: AlertDialogParamWithConfirm = {
      title: 'Index Removed',
      message: 'Spotlight history may still appear in search results, but notes have be unindexed',
      confirm: { value: 'Okay', action: () => {
        hilog.info(DOMAIN, LOG_TAG, 'index removal acknowledged');
      } }
    };
    this.getUIContext().showAlertDialog(alert);
  }

  /// SPAlphabeticalTagSortPref = isOn + SPAlphabeticalTagSortPreferenceChangedNotification.
  tagSortSwitchDidChangeValue(isOn: boolean): void {
    this.alphabeticalTags = isOn;
    Options.shared.alphabeticalTagSortPref = isOn;
  }

  /// UserDefaults useSustainerIcon = isOn; setAlternateIconName has no HarmonyOS equivalent.
  sustainerSwitchDidChangeValue(isOn: boolean): void {
    this.useSustainerIcon = isOn;
    this.writeDefault(DefaultsKey.USE_SUSTAINER_ICON, isOn);
    this.showToast('Alternate app icons are not available on this platform');
  }

  touchIdSwitchDidChangeValue(isOn: boolean): void {
    this.useBiometry = isOn;
    if (!SPPinLockManager.shared.isEnabled && isOn) {
      this.presentPinLockRequiredAlert();
      return;
    }
    SPPinLockManager.shared.shouldUseBiometry = isOn;
  }

  /// pinLockRequiredAlert
  presentPinLockRequiredAlert(): void {
    const alert: AlertDialogParamWithOptions = {
      title: this.biometryTitle,
      message: `To enable ${this.biometryTitle}, you must have a passcode setup first.`,
      buttons: [
        { value: 'Set up Passcode', action: () => this.showPinLockViewController() },
        { value: 'Cancel', action: () => {
          this.useBiometry = false;
        } }
      ],
      cancel: () => {
        this.useBiometry = false;
      }
    };
    this.getUIContext().showAlertDialog(alert);
  }

  /// signOutAction: -- safety first: check for unsynced notes before they are deleted.
  signOutAction(): void {
    const simperium: Simperium | null = Simperium.shared;
    if (simperium === null || !StatusChecker.hasUnsentChanges(simperium)) {
      SPTracker.trackUserSignedOut();
      this.logoutAndReset();
      return;
    }
    const alert: AlertDialogParamWithOptions = {
      title: 'Unsynced Notes Detected',
      message: 'Signing out will delete any unsynced notes. You can verify your synced notes by signing in to the Web App.',
      buttons: [
        { value: 'Delete Notes', fontColor: $r('sys.color.warning'), action: () => {
          SPTracker.trackUserSignedOut();
          this.logoutAndReset();
        } },
        { value: 'Visit Web App', action: () => this.openURL(WEB_APP_URL) },
        { value: 'Cancel', action: () => {
          hilog.info(DOMAIN, LOG_TAG, 'sign out cancelled');
        } }
      ]
    };
    this.getUIContext().showAlertDialog(alert);
  }

  /// SPAppDelegate logoutAndReset: (SPModalActivityIndicator while it runs) -> authenticateIfNecessary
  /// (the onboarding UI replaces the whole stack).
  logoutAndReset(): void {
    this.signingOut = true;
    SessionStore.shared().logoutAndReset().catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'logout failed: %{public}s', e.message);
    }).finally(() => {
      this.signingOut = false;
      router.replaceUrl({ url: 'pages/SPOnboardingViewControllerPage' }).then(() => {
        router.clear();
      }).catch((e: Error) => {
        hilog.error(DOMAIN, LOG_TAG, 'onboarding failed: %{public}s', e.message);
      });
    });
  }

  /// deleteAccountWasPressed: confirmation -> SpinnerViewController -> requestAccountDeletion.
  deleteAccountWasPressed(): void {
    const simperium: Simperium | null = Simperium.shared;
    if (simperium === null || simperium.user === null) {
      return;
    }
    const user: SPUser = simperium.user;
    SPTracker.trackDeleteAccountButttonTapped();
    const email: string = user.email ?? '';
    const alert: AlertDialogParamWithOptions = {
      title: 'Delete Account',
      message: `By deleting the account for ${email}, all notes created with this account will be permanently deleted. This action is not reversible`,
      buttons: [
        { value: 'Request Account Deletion', fontColor: $r('sys.color.warning'), action: () => this.requestAccountDeletion(user) },
        { value: 'Cancel', action: () => {
          hilog.info(DOMAIN, LOG_TAG, 'account deletion cancelled');
        } }
      ]
    };
    this.getUIContext().showAlertDialog(alert);
  }

  private requestAccountDeletion(user: SPUser): void {
    this.showSpinner = true;
    ACCOUNT_DELETION_CONTROLLER.requestAccountDeletion(user, (result: RemoteResult) => {
      this.showSpinner = false;
      if (result.isSuccess) {
        this.presentSuccessAlert(user);
      } else {
        this.presentRequestErrorAlert();
      }
    });
  }

  private presentSuccessAlert(user: SPUser): void {
    const alert: AlertDialogParamWithConfirm = {
      title: 'Check Your Email',
      message: `An email has been sent to ${user.email ?? ''}. Check your inbox and follow the instructions to confirm account deletion.\n\nYour account won't be deleted until we receive your confirmation.`,
      confirm: { value: 'Ok', action: () => {
        hilog.info(DOMAIN, LOG_TAG, 'deletion requested');
      } }
    };
    this.getUIContext().showAlertDialog(alert);
  }

  private presentRequestErrorAlert(): void {
    const alert: AlertDialogParamWithConfirm = {
      title: 'Error',
      message: 'An error occured. Please, try again. If the problem continues, contact us at support@simplenote.com for help.',
      confirm: { value: 'Ok', action: () => {
        hilog.info(DOMAIN, LOG_TAG, 'deletion error acknowledged');
      } }
    };
    this.getUIContext().showAlertDialog(alert);
  }

  /// HarmonyOS card-group sub-header: sentence case, Subtitle_S medium, secondary text.
  @Builder
  sectionHeader(title: string) {
    Text(title)
      .fontSize($r('sys.float.Subtitle_S'))
      .fontWeight(FontWeight.Medium)
      .fontColor($r('sys.color.font_secondary'))
      .width('100%')
      .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16), top: LengthMetrics.vp(12), bottom: LengthMetrics.vp(8) })
  }

  /// A rounded HarmonyOS list card on the grouped page background.
  @Styles
  card() {
    .width('100%')
    .backgroundColor($r('sys.color.comp_background_list_card'))
    .borderRadius($r('sys.float.corner_radius_level8'))
    .clip(true)
  }

  /// Row metrics shared by every settings row: 48vp minimum, 16vp sides, system pressed state.
  @Styles
  rowStyle() {
    .width('100%')
    .constraintSize({ minHeight: 48 })
    .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16) })
    .stateStyles({
      normal: {
        .backgroundColor(Color.Transparent)
      },
      pressed: {
        .backgroundColor($r('sys.color.interactive_pressed'))
      }
    })
  }

  @Builder
  disclosureRow(row: SettingsRow) {
    Row() {
      Text(row.title)
        .fontSize($r('sys.float.Body_L'))
        .fontColor(row.titleColor ?? $r('sys.color.font_primary'))
        .layoutWeight(1)
        .maxLines(1)
      Text(row.value ?? '')
        .fontSize($r('sys.float.Body_M'))
        .fontColor($r('sys.color.font_secondary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .margin({ start: LengthMetrics.vp(8) })
      if (row.showsDisclosure !== false) {
        SymbolGlyph($r('sys.symbol.chevron_right'))
          .fontSize(20)
          .fontColor([$r('sys.color.icon_tertiary')])
          .margin({ start: LengthMetrics.vp(4) })
          .accessibilityLevel('no')
      }
    }
    .rowStyle()
    .id(row.slug)
    .onClick(() => row.action?.())
  }

  @Builder
  switchRow(row: SettingsRow) {
    Row() {
      Text(row.title)
        .fontSize($r('sys.float.Body_L'))
        .fontColor(row.titleColor ?? $r('sys.color.font_primary'))
        .layoutWeight(1)
        .maxLines(1)
      Toggle({ type: ToggleType.Switch, isOn: row.isOn ?? false })
        .onChange((isOn: boolean) => {
          if (isOn !== (row.isOn ?? false)) {
            row.onToggle?.(isOn);
          }
        })
    }
    .rowStyle()
    .id(row.slug)
    // SwitchTableViewCell.contentWasPressed: a tap anywhere on the cell flips the switch.
    .onClick(() => row.onToggle?.(!(row.isOn ?? false)))
  }

  /// Inset divider between two rows of one card.
  @Builder
  rowDivider() {
    Divider()
      .strokeWidth('1px')
      .color($r('sys.color.comp_divider'))
      .margin({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16) })
  }

  @Builder
  actionRow(row: SettingsRow) {
    Row() {
      Text(row.title)
        .fontSize($r('sys.float.Body_L'))
        .fontColor(row.titleColor ?? $r('sys.color.font_primary'))
    }
    .rowStyle()
    .id(row.slug)
    .onClick(() => row.action?.())
  }

  build() {
    Stack() {
      Column() {
        // HarmonyOS title bar. Settings is a routed full page (router.pushUrl from the sidebar) whose
        // Done popped back, so it takes the system Back arrow. The wrapper keeps the settings_done id
        // for QA: EditableTitleBar does not expose its back button.
        Column() {
          EditableTitleBar({
            leftIconStyle: EditableLeftIconType.Back,
            title: 'Settings',
            isSaveIconRequired: false,
            onCancel: (): void => {
              this.doneAction();
            }
          })
        }
        .id('settings_done')
        .width('100%')

        Scroll() {
          Column({ space: 12 }) {
          // Notes
          Column() {
            this.sectionHeader('Notes')
            Column() {
              this.disclosureRow({ slug: 'settings_sort_order', title: 'Sort Order', value: sortModeDescription(this.sortMode), action: () => this.showSortOrder() })
              this.rowDivider()
              this.switchRow({ slug: 'settings_condensed_note_list', title: 'Condensed Note List', isOn: this.condensed, onToggle: (isOn: boolean) => this.condensedSwitchDidChangeValue(isOn) })
              this.rowDivider()
              this.switchRow({ slug: 'settings_index_notes', title: 'Index Notes in Spotlight', isOn: this.indexInSpotlight, onToggle: (isOn: boolean) => this.indexNotesSwitchDidChangeValue(isOn) })
            }
            .card()
          }

          // Tags
          Column() {
            this.sectionHeader('Tags')
            Column() {
              this.switchRow({ slug: 'settings_tag_sort_alphabetical', title: 'Sort Alphabetically', isOn: this.alphabeticalTags, onToggle: (isOn: boolean) => this.tagSortSwitchDidChangeValue(isOn) })
            }
            .card()
          }

          // Appearance
          Column() {
            this.sectionHeader('Appearance')
            Column() {
              this.disclosureRow({ slug: 'settings_theme', title: 'Theme', value: themeDescription(this.theme), action: () => this.showTheme() })
              if (this.isSustainer && this.preferences !== null) {
                this.rowDivider()
                this.switchRow({ slug: 'settings_sustainer_icon', title: 'Sustainer App Icon', isOn: this.useSustainerIcon, onToggle: (isOn: boolean) => this.sustainerSwitchDidChangeValue(isOn) })
              }
            }
            .card()
          }

          // Security
          Column() {
            this.sectionHeader('Security')
            Column() {
              this.disclosureRow({ slug: 'passcode-cell', title: 'Passcode', value: this.pinEnabled ? 'On' : 'Off', action: () => this.showPinLockViewController() })
              if (this.biometryAvailable) {
                this.rowDivider()
                this.switchRow({ slug: 'settings_biometry', title: this.biometryTitle, isOn: this.useBiometry, onToggle: (isOn: boolean) => this.touchIdSwitchDidChangeValue(isOn) })
              }
              if (this.pinEnabled && SPPinLockManager.shared.isEnabled) {
                this.rowDivider()
                this.disclosureRow({ slug: 'settings_lock_timeout', title: 'Lock Timeout', value: TIMEOUT_PICKER_OPTIONS[this.pinTimeout], showsDisclosure: false, action: () => this.showLockTimeoutPicker() })
              }
            }
            .card()
          }

          // Account
          Column() {
            this.sectionHeader('Account')
            Column() {
              Row() {
                Text('Username')
                  .fontSize($r('sys.float.Body_L'))
                  .fontColor($r('sys.color.font_primary'))
                  .flexShrink(0)
                Text(this.username)
                  .fontSize($r('sys.float.Body_M'))
                  .fontColor($r('sys.color.font_secondary'))
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .wordBreak(WordBreak.BREAK_ALL)
                  .textAlign(TextAlign.End)
                  .layoutWeight(1)
                  .margin({ start: LengthMetrics.vp(8) })
              }
              .width('100%')
              .constraintSize({ minHeight: 48 })
              .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16) })
              this.rowDivider()
              this.disclosureRow({ slug: 'settings_privacy', title: 'Privacy Settings', value: '', action: () => this.showPrivacy() })
              this.rowDivider()
              this.actionRow({ slug: 'settings_log_out', title: 'Log Out', titleColor: $r('sys.color.font_emphasize'), action: () => this.signOutAction() })
            }
            .card()
          }

          // Delete
          Column() {
            this.actionRow({ slug: 'settings_delete_account', title: 'Delete Account', titleColor: $r('sys.color.warning'), action: () => this.deleteAccountWasPressed() })
          }
          .card()

          // About
          Column() {
            this.actionRow({ slug: 'settings_about', title: 'About', action: () => this.showAbout() })
          }
          .card()

          // Help
          Column() {
            this.actionRow({ slug: 'settings_help', title: 'Help', action: () => this.showHelp() })
          }
          .card()
          }
          .width('100%')
          .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16), top: LengthMetrics.vp(4), bottom: LengthMetrics.vp(32) })
        }
        .layoutWeight(1)
        .width('100%')
        .align(Alignment.Top)
        .scrollBar(BarState.Off)

        // pinTimeoutTextField.inputView (UIPickerView) + inputAccessoryView, as a docked HarmonyOS
        // panel: confirm checkmark on the trailing edge, then the system TextPicker.
        if (this.showTimeoutPicker) {
          Column() {
            Row() {
              HmIconButton({
                symbol: $r('sys.symbol.checkmark'),
                label: 'Done',
                buttonId: 'settings_lock_timeout_done',
                action: (): void => {
                  this.pinTimeoutDoneAction();
                }
              })
            }
            .width('100%')
            .justifyContent(FlexAlign.End)
            .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16), top: LengthMetrics.vp(8) })
            TextPicker({ range: TIMEOUT_PICKER_OPTIONS, selected: this.pinTimeout })
              .id('settings_lock_timeout_field')
              .onChange((value: string | string[], index: number | number[]) => {
                this.pinTimeoutDidSelect(index as number);
              })
          }
          .width('100%')
          .padding({ bottom: LengthMetrics.vp(16) })
          .backgroundColor($r('sys.color.comp_background_primary'))
          .borderRadius({ topLeft: $r('sys.float.corner_radius_level16'), topRight: $r('sys.float.corner_radius_level16') })
        }
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('sys.color.background_secondary'))

      // SpinnerViewController while the account-deletion request is in flight.
      if (this.showSpinner) {
        SpinnerViewController()
      }
      // SPModalActivityIndicator while signing out.
      if (this.signingOut) {
        SPModalActivityIndicator()
      }
    }
    .id('screen_settings')
    .width('100%')
    .height('100%')
    // The grouped background runs under the gesture bar (no white strip at the bottom).
    .backgroundColor($r('sys.color.background_secondary'))
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
  }
}
