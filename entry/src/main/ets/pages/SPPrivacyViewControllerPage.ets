// Port of SPPrivacyViewController.swift (pushed from Settings; an SPTableViewController). Structure:
// navigation bar 'Privacy Settings' with back, one grouped section [Share Analytics switch, legend,
// Learn more]. iOS's debug-only [Send a Test Crash] section is omitted (release parity).
import { router, LengthMetrics, EditableTitleBar, EditableLeftIconType } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Simperium } from '../common/simperium/Simperium';
import { SPBucket, SPDiffableObject } from '../common/simperium/Bucket';
import { Preferences } from '../model/Preferences';

const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'Privacy';
/// kAutomatticAnalyticLearnMoreURL
const ANALYTICS_LEARN_MORE_URL: string = 'https://automattic.com/cookies';
/// Simperium+Simplenote.m preferencesObject: the one Preferences object's key.
const PREFERENCES_OBJECT_KEY: string = 'preferences-key';

@Entry
@Component
struct SPPrivacyViewControllerPage {
  /// Preferences.analytics_enabled (preferences bucket, synced); nil reads as enabled
  @State analyticsEnabled: boolean = true;

  /// Polls for Simperium on a cold deep-link launch (the page can appear before setupSimperium resolves).
  private readyTimer: number = -1;

  aboutToAppear(): void {
    if (Simperium.shared !== null) {
      this.loadAnalyticsEnabled();
      return;
    }
    // ponytail: 100 ms poll, capped at 10 s; replace with a SessionStore ready event if one lands.
    let ticks: number = 0;
    this.readyTimer = setInterval((): void => {
      ticks++;
      if (Simperium.shared !== null || ticks >= 100) {
        clearInterval(this.readyTimer);
        this.readyTimer = -1;
        this.loadAnalyticsEnabled();
      }
    }, 100);
  }

  aboutToDisappear(): void {
    if (this.readyTimer !== -1) {
      clearInterval(this.readyTimer);
      this.readyTimer = -1;
    }
  }

  /// viewWillAppear -> reloads the switch from Preferences.analytics_enabled (nil reads as enabled).
  private loadAnalyticsEnabled(): void {
    const preferences: Preferences | null = this.preferencesObject();
    const enabled: number | null = preferences === null ? null : preferences.analytics_enabled;
    this.analyticsEnabled = enabled === null ? true : enabled !== 0;
  }

  /// Back -> pop to Settings.
  dismiss(): void {
    router.back();
  }

  /// simperium.preferencesObject() (created when missing)
  private preferencesObject(): Preferences | null {
    const simperium: Simperium | null = Simperium.shared;
    if (simperium === null) {
      return null;
    }
    const bucket: SPBucket = simperium.preferencesBucket;
    let object: SPDiffableObject | undefined = bucket.objectForKey(PREFERENCES_OBJECT_KEY);
    if (object === undefined) {
      object = bucket.insertNewObjectForKey(PREFERENCES_OBJECT_KEY);
    }
    return object instanceof Preferences ? object as Preferences : null;
  }

  /// switchDidChange(sender:)
  private switchDidChange(isOn: boolean): void {
    this.analyticsEnabled = isOn;
    const preferences: Preferences | null = this.preferencesObject();
    const simperium: Simperium | null = Simperium.shared;
    if (preferences === null || simperium === null) {
      hilog.error(DOMAIN, LOG_TAG, 'preferences object unavailable');
      return;
    }
    preferences.analytics_enabled = isOn ? 1 : 0;
    simperium.save();
  }

  /// displayPrivacyLink
  private displayPrivacyLink(): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    context.openLink(ANALYTICS_LEARN_MORE_URL).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'openLink failed: %{public}s', e.message);
    });
  }

  build() {
    Column() {
      // HarmonyOS level-2 title bar: system back arrow + left-aligned title.
      EditableTitleBar({
        leftIconStyle: EditableLeftIconType.Back,
        title: $r('app.string.privacy_settings'),
        isSaveIconRequired: false,
        onCancel: (): void => {
          this.dismiss();
        }
      })

      // One HarmonyOS card group.
      List() {
        ListItemGroup({ style: ListItemGroupStyle.CARD }) {
          // .share: stats icon, 'Share Analytics', switch accessory
          ListItem({ style: ListItemStyle.CARD }) {
            Row({ space: 16 }) {
              Image($r('app.media.ic_stats'))
                .width(24)
                .height(24)
                .objectFit(ImageFit.Contain)
                .fillColor($r('sys.color.icon_emphasize'))
                .accessibilityLevel('no')
              Text($r('app.string.share_analytics'))
                .fontSize($r('sys.float.Body_L'))
                .fontColor($r('sys.color.font_primary'))
                .layoutWeight(1)
              Toggle({ type: ToggleType.Switch, isOn: this.analyticsEnabled })
                .id('privacy_analytics')
                .onChange((isOn: boolean): void => {
                  this.switchDidChange(isOn);
                })
            }
            .width('100%')
            .constraintSize({ minHeight: 48 })
          }
          // .legend
          ListItem({ style: ListItemStyle.CARD }) {
            Row({ space: 16 }) {
              Image($r('app.media.ic_info_filled'))
                .width(24)
                .height(24)
                .objectFit(ImageFit.Contain)
                .fillColor($r('sys.color.icon_emphasize'))
                .accessibilityLevel('no')
              Text($r('app.string.help_us_improve_simplenote_by_sharing_usage_data_with_our_an'))
                .fontSize($r('sys.float.Body_M'))
                .fontColor($r('sys.color.font_secondary'))
                .layoutWeight(1)
            }
            .width('100%')
            .constraintSize({ minHeight: 48 })
            .padding({ top: LengthMetrics.vp(12), bottom: LengthMetrics.vp(12) })
          }
          // .learn
          ListItem({ style: ListItemStyle.CARD }) {
            Row({ space: 16 }) {
              Blank()
                .width(24)
              Text($r('app.string.learn_more'))
                .fontSize($r('sys.float.Body_L'))
                .fontColor($r('sys.color.font_emphasize'))
                .layoutWeight(1)
            }
            .width('100%')
            .constraintSize({ minHeight: 48 })
            .onClick((): void => {
              this.displayPrivacyLink();
            })
          }
        }
        .divider({ strokeWidth: '1px', color: $r('sys.color.comp_divider'), startMargin: 48, endMargin: 8 })
      }
      .width('100%')
      .layoutWeight(1)
      .padding({ top: LengthMetrics.vp(8) })
      .scrollBar(BarState.Off)
    }
    .id('screen_privacy')
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.background_secondary'))
    // The grouped background runs under the gesture bar (no white strip at the bottom).
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
  }
}
