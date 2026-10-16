// Port of SPAboutViewController.swift (presented from Settings; onDoneTap dismiss). Structure: the
// close cross (xmark HmIconButton), a scrolling stack with the header (logo — long-press spins
// it —, app name, version), the link table (HuggableTableView) and the footer (policy links +
// copyright).
import { router, LengthMetrics } from '@kit.ArkUI';
import { common, bundleManager, Want } from '@kit.AbilityKit';
import { productViewManager } from '@kit.StoreKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { HuggableTableView } from '../components/HuggableTable';
import { HmIconButton } from '../components/HmIconButton';

const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'About';

/// Constants.privacyURLString / termsURLString / californiaURLString
const PRIVACY_URL: string = 'https://automattic.com/privacy/';
const TERMS_URL: string = 'https://simplenote.com/terms/';
const CALIFORNIA_URL: string = 'https://automattic.com/privacy/#us-privacy-laws';
/// Constants.logoMinPressDuration (ms)
const LOGO_MIN_PRESS_DURATION_MS: number = 500;
/// ViewSpinner Constants (radians / s, radians / s^2)
const SPINNER_ACCELERATION: number = 40;
const SPINNER_MAX_VELOCITY: number = 50;
const SPINNER_FRAME_MS: number = 16;

/// One row of the link table: Constants.titles / descriptions / urls
class AboutLink {
  title: ResourceStr;
  detail: ResourceStr;
  url: string;
  /// The 'Rate us' row: the App Store page maps to this app's AppGallery detail page.
  isStorePage: boolean;

  constructor(title: ResourceStr, detail: ResourceStr, url: string, isStorePage: boolean = false) {
    this.title = title;
    this.detail = detail;
    this.url = url;
    this.isStorePage = isStorePage;
  }
}

const ABOUT_LINKS: AboutLink[] = [
  new AboutLink($r('app.string.blog'), 'simplenote.com/blog', 'https://simplenote.com/blog/'),
  new AboutLink('Twitter', '@simplenoteapp', 'https://twitter.com/simplenoteapp'),
  new AboutLink($r('app.string.get_help'), $r('app.string.faq_or_contact_us'), 'https://simplenote.com/help/'),
  new AboutLink($r('app.string.rate_us'), 'AppGallery', 'https://apps.apple.com/app/id289429962', true),
  new AboutLink($r('app.string.contribute'), 'github.com', 'https://github.com/automattic/simplenote-ios'),
  new AboutLink($r('app.string.careers'), $r('app.string.are_you_a_developer_we_re_hiring'),
    'https://automattic.com/work-with-us/')
];

/// Constants.spinnerMessages (decoded)
const SPINNER_MESSAGES: string[] = [
  'It feels like I only go backwards, baby',
  'Turn around, bright eyes\nEvery now and then I fall apart',
  'To everything (turn, turn, turn)\nThere is a season (turn, turn, turn)',
  'You spin me right round, baby\nRight round like a record, baby\nRight round, round, round',
  'All the great things are simple.\n- Winston Churchill',
  'Simplicity is the glory of expression.\n- Walt Whitman',
  'Make everything as simple as possible, but not simpler.\n- Albert Einstein',
  'Life is really simple, but we insist on making it complicated.\n- Confucius',
  'Our life is frittered away by detail… simplify, simplify.\n- Henry David Thoreau',
  'The freedom and simple beauty of it is too good to pass up.\n- Christopher McCandless',
  'Nothing is more simple than greatness; indeed, to be simple is to be great.\n- Ralph Waldo Emerson',
  'Simple can be harder than complex.  You have to work hard to get your thinking clean to make it simple.  ' +
    'But it\'s worth it in the end because once you get there, you can move mountains.\n- Steve Jobs',
  'Do you want to work with us and make things like this? Email us at support@simplenote.com and mention this message.'
];

@Entry
@Component
struct SPAboutViewControllerPage {
  /// bundleManager.getBundleInfoForSelf versionName (Bundle.main.shortVersionString)
  @State appVersion: string = '';
  @State logoAngle: number = 0;
  private spinnerTimer: number = -1;
  private spinnerVelocity: number = 0;
  private spinnerAngle: number = 0;

  aboutToAppear(): void {
    try {
      this.appVersion = bundleManager.getBundleInfoForSelfSync(
        bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT).versionName;
    } catch (e) {
      hilog.error(DOMAIN, LOG_TAG, 'bundle version unavailable');
    }
  }

  /// viewWillDisappear: viewSpinner.stop()
  onPageHide(): void {
    this.stopSpinner();
  }

  /// onDoneTap -> dismiss
  dismiss(): void {
    router.back();
  }

  private open(url: string): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    context.openLink(url).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'openLink %{public}s failed: %{public}s', url, e.message);
    });
  }

  /// tableView(_:didSelectRowAt:) -> UIApplication.open(urls[row])
  private openLink(link: AboutLink): void {
    if (link.isStorePage) {
      this.openStorePage();
      return;
    }
    this.open(link.url);
  }

  /// 'Rate us' (App Store URL) -> the app's AppGallery detail page; a toast when the store cannot open.
  private openStorePage(): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    const want: Want = { parameters: { 'bundleName': context.abilityInfo.bundleName } };
    try {
      productViewManager.loadProduct(context, want, {
        onError: (e: BusinessError): void => {
          hilog.error(DOMAIN, LOG_TAG, 'store page failed: %{public}s', e.message);
          this.getUIContext().getPromptAction().showToast({ message: 'The app store is not available on this device' });
        }
      });
    } catch (e) {
      hilog.error(DOMAIN, LOG_TAG, 'store page unavailable: %{public}s', (e as Error).message);
      this.getUIContext().getPromptAction().showToast({ message: 'The app store is not available on this device' });
    }
  }

  /// footerCopyrightString
  private copyrightString(): string {
    return '© Automattic ' + new Date().getFullYear().toString();
  }

  // MARK: - Header Spinner (ViewSpinner)

  private startSpinner(): void {
    if (this.spinnerTimer >= 0) {
      return;
    }
    this.spinnerVelocity = 0;
    this.spinnerAngle = 0;
    this.spinnerTimer = setInterval((): void => {
      this.updateSpinner(SPINNER_FRAME_MS / 1000);
    }, SPINNER_FRAME_MS);
  }

  private updateSpinner(timeDelta: number): void {
    const previousVelocity: number = this.spinnerVelocity;
    this.spinnerVelocity = Math.min(this.spinnerVelocity + SPINNER_ACCELERATION * timeDelta, SPINNER_MAX_VELOCITY);
    this.spinnerAngle = this.spinnerAngle + this.spinnerVelocity * timeDelta;
    this.logoAngle = -this.spinnerAngle * 180 / Math.PI;
    if (previousVelocity < SPINNER_MAX_VELOCITY && this.spinnerVelocity === SPINNER_MAX_VELOCITY) {
      this.stopSpinner();
      this.showSpinnerMessage();
    }
  }

  private stopSpinner(): void {
    if (this.spinnerTimer < 0) {
      return;
    }
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = -1;
    animateTo({ duration: 1500, curve: Curve.EaseOut }, (): void => {
      this.logoAngle = 0;
    });
  }

  private showSpinnerMessage(): void {
    const message: string = SPINNER_MESSAGES[Math.floor(Math.random() * SPINNER_MESSAGES.length)];
    AlertDialog.show({
      message: message,
      confirm: {
        value: $r('app.string.ok'),
        action: (): void => {
          hilog.info(DOMAIN, LOG_TAG, 'spinner message dismissed');
        }
      }
    });
  }

  build() {
    Stack({ alignContent: Alignment.TopEnd }) {
      Scroll() {
        Column({ space: 36 }) {
          // Header: logo, app name, version
          Column({ space: 6 }) {
            Image($r('app.media.simplenote_logo'))
              .width(60)
              .height(60)
              .objectFit(ImageFit.Contain)
              .fillColor(Color.White)
              .rotate({ angle: this.logoAngle })
              .gesture(
                LongPressGesture({ duration: LOGO_MIN_PRESS_DURATION_MS })
                  .onAction((event: GestureEvent): void => {
                    this.startSpinner();
                  })
                  .onActionEnd((event: GestureEvent): void => {
                    this.stopSpinner();
                  })
                  .onActionCancel((): void => {
                    this.stopSpinner();
                  })
              )
            Text($r('app.string.about_app_name'))
              .fontSize($r('sys.float.Title_L'))
              .fontWeight(FontWeight.Bold)
              .fontColor($r('sys.color.font_on_primary'))
            Text($r('app.string.version', this.appVersion))
              .fontSize($r('sys.float.Body_L'))
              .fontColor(Color.White)
          }
          // headerView: stack spacing 6
          .alignItems(HorizontalAlign.Center)
          .width('100%')

          // Link table
          HuggableTableView({
            separatorColor: $r('app.color.simplenote_blue30'),
            separatorInset: 20
          }) {
            ForEach(ABOUT_LINKS, (link: AboutLink) => {
              ListItem() {
                Row() {
                  Column({ space: 2 }) {
                    Text(link.title)
                      .fontSize($r('sys.float.Body_L'))
                      .fontColor(Color.White)
                    Text(link.detail)
                      .fontSize($r('sys.float.Body_L'))
                      .fontColor($r('app.color.simplenote_blue10'))
                  }
                  .alignItems(HorizontalAlign.Start)
                  .layoutWeight(1)
                  SymbolGlyph($r('sys.symbol.arrow_up_right'))
                    .fontSize(24)
                    .fontColor([$r('sys.color.icon_on_primary')])
                    .accessibilityLevel('no')
                }
                .width('100%')
                .constraintSize({ minHeight: 60 })
                .padding({ start: LengthMetrics.vp(20), end: LengthMetrics.vp(20), top: LengthMetrics.vp(10),
                  bottom: LengthMetrics.vp(10) })
              }
              .id('about_itemroot')
              .onClick((): void => {
                this.openLink(link);
              })
            }, (link: AboutLink): string => link.url)
          }

          // Footer: policy links + copyright
          Column({ space: 20 }) {
            // footerTextView: three separate link runs, so each is its own tappable control named
            // by its own label (Privacy Policy / Terms of Service / Privacy Notice for California Users).
            Column({ space: 15 }) {
              Row() {
                Text($r('app.string.privacy_policy'))
                  .fontSize($r('sys.float.Body_S'))
                  .fontColor($r('app.color.simplenote_blue10'))
                  .decoration({ type: TextDecorationType.Underline })
                  .onClick((): void => {
                    this.open(PRIVACY_URL);
                  })
                Text(', ')
                  .fontSize($r('sys.float.Body_S'))
                  .fontColor($r('app.color.simplenote_blue10'))
                Text($r('app.string.terms_of_service'))
                  .fontSize($r('sys.float.Body_S'))
                  .fontColor($r('app.color.simplenote_blue10'))
                  .decoration({ type: TextDecorationType.Underline })
                  .onClick((): void => {
                    this.open(TERMS_URL);
                  })
                Text(',')
                  .fontSize($r('sys.float.Body_S'))
                  .fontColor($r('app.color.simplenote_blue10'))
              }
              Text($r('app.string.privacy_notice_for_california_users'))
                .fontSize($r('sys.float.Body_S'))
                .fontColor($r('app.color.simplenote_blue10'))
                .decoration({ type: TextDecorationType.Underline })
                .onClick((): void => {
                  this.open(CALIFORNIA_URL);
                })
            }
            .alignItems(HorizontalAlign.Center)
            Text(this.copyrightString())
              .fontSize($r('sys.float.Body_M'))
              .fontColor(Color.White)
          }
          // footerView: stack spacing 20
          .alignItems(HorizontalAlign.Center)
          .width('100%')
          .padding({ start: LengthMetrics.vp(20), end: LengthMetrics.vp(20), top: LengthMetrics.vp(36) })
        }
        // containerView: spacing 36, insets top 72 / bottom 14
        .width('100%')
        .padding({ top: LengthMetrics.vp(72), bottom: LengthMetrics.vp(14) })
      }
      .width('100%')
      .height('100%')
      .align(Alignment.Top)
      .scrollBar(BarState.Off)

      // doneButton: HarmonyOS title-bar close symbol, tinted for contrast on the brand blue
      HmIconButton({
        symbol: $r('sys.symbol.xmark'),
        label: 'Close',
        buttonId: 'about_done',
        tint: $r('sys.color.icon_on_primary'),
        action: (): void => {
          this.dismiss();
        }
      })
        .margin({ top: LengthMetrics.vp(8), end: LengthMetrics.vp(16) })
    }
    .id('screen_about')
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.simplenote_blue50'))
    // The brand background runs under the gesture bar (no white strip at the bottom).
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
  }
}
