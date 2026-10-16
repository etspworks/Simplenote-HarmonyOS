// Port of MagicLinkInvalidView (SwiftUI) — presentation: sheet (medium detent), hosted by
// SPOnboardingViewControllerPage (.bindSheet). Structure: toolbar dismiss cross, cross-circle icon,
// 'Link no longer valid', 'Request a new Link'.
import { router, LengthMetrics } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { HmIconButton } from '../components/HmIconButton';

const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'MagicLinkInvalid';

/// Same shape as SPOnboardingViewControllerPage.AuthRouteParams (declared here: that page imports this one).
class RequestNewLinkParams {
  mode: string = 'requestLoginCode';
  overlay: string = '';
}

@Component
export struct MagicLinkInvalidView {
  /// presentationMode.dismiss (the toolbar cross).
  onDismiss: () => void = (): void => {
    hilog.info(DOMAIN, LOG_TAG, 'dismiss requested with no host handler');
  };
  /// onPressRequestNewLink: the host's presentAuthenticationInterfaceIfNeeded(mode: .requestLoginCode).
  onPressRequestNewLink: (() => void) | null = null;

  /// pressedRequestNewLink: dismiss, then onPressRequestNewLink.
  pressedRequestNewLink(): void {
    this.onDismiss();
    if (this.onPressRequestNewLink !== null) {
      this.onPressRequestNewLink();
      return;
    }
    const params: RequestNewLinkParams = new RequestNewLinkParams();
    router.pushUrl({ url: 'pages/SPAuthViewControllerPage', params: params }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'auth failed: %{public}s', e.message);
    });
  }

  build() {
    Column() {
      // .toolbar: trailing dismiss, a HarmonyOS xmark icon button
      Row() {
        Blank()
        HmIconButton({
          symbol: $r('sys.symbol.xmark'),
          label: 'Close',
          buttonId: 'magic_link_invalid_dismiss',
          action: (): void => {
            this.onDismiss();
          }
        })
      }
      .width('100%')
      .height(56)
      .padding({ end: LengthMetrics.vp(16) })

      // VStack(spacing: 10): icon, title (+30 bottom), action; centred in the remaining space
      Column({ space: 10 }) {
        Image($r('app.media.ic_cross_circle'))
          .width(100)
          .height(100)
          .objectFit(ImageFit.Contain)
          .fillColor($r('app.color.simplenote_light_blue'))
          .accessibilityLevel('no')
        Text('Link no longer valid')
          .fontSize($r('sys.float.Title_L'))
          .fontWeight(FontWeight.Bold)
          .fontColor($r('sys.color.font_primary'))
          .textAlign(TextAlign.Center)
          .margin({ bottom: LengthMetrics.vp(30) })
        Button('Request a new Link', { type: ButtonType.Capsule, stateEffect: true })
          .id('request_a_new_link')
          .height(40)
          .constraintSize({ minWidth: 200, maxWidth: 448 })
          .fontSize($r('sys.float.Body_L'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.font_on_primary'))
          .backgroundColor($r('sys.color.brand'))
          .padding({ start: LengthMetrics.vp(24), end: LengthMetrics.vp(24) })
          .onClick((): void => {
            this.pressedRequestNewLink();
          })
      }
      .width('100%')
      .layoutWeight(1)
      .padding(16)
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
    }
    .id('screen_magic_link_invalid')
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.background_primary'))
  }
}
