// SFSafariViewController's role (WPAuthHandler.m presentWordPressSSOFromViewController): an ArkWeb page with a
// close (xmark) header, hosted in a .bindSheet. A simplenote:// navigation is not loaded: the sheet closes first (as
// SPOnboardingViewController handleSignInError dismisses the Safari VC) and the URL goes to the same handler
// EntryAbility.routeWant uses for that deep link (SPAppDelegate performDotcomAuthenticationWithURL:).
import { LengthMetrics } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { SessionStore } from '../common/SessionStore';
import { HmIconButton } from './HmIconButton';

const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'InAppBrowser';
const APP_SCHEME_PREFIX: string = 'simplenote:';

@Component
export struct InAppBrowserSheet {
  @Prop src: string = '';
  /// Close (or an intercepted simplenote:// link) -> the host hides the sheet.
  onDismiss: () => void = (): void => {
    hilog.info(DOMAIN, LOG_TAG, 'dismiss requested with no host handler');
  };
  private webController: webview.WebviewController = new webview.WebviewController();
  /// SFSafariViewController shows the page's host in its bar.
  @State host: string = '';

  aboutToAppear(): void {
    this.host = hostOf(this.src);
  }

  /// Returns true to cancel the load.
  private interceptAppLink(url: string): boolean {
    if (!url.toLowerCase().startsWith(APP_SCHEME_PREFIX)) {
      return false;
    }
    this.onDismiss();
    SessionStore.shared().performMagicLinkAuthentication(url);
    return true;
  }

  build() {
    Column() {
      // HarmonyOS sheet header: close (xmark) on the left, the page host as the title.
      Row({ space: 8 }) {
        HmIconButton({
          buttonId: 'in_app_browser_done',
          symbol: $r('sys.symbol.xmark'),
          label: 'Done',
          action: (): void => this.onDismiss()
        })
        Text(this.host)
          .fontSize($r('sys.float.Body_L'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.font_primary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
          .id('in_app_browser_host')
      }
      .width('100%')
      .height(56)
      .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16) })

      Web({ src: this.src, controller: this.webController })
        .width('100%')
        .layoutWeight(1)
        .domStorageAccess(true)
        .onPageBegin((event: OnPageBeginEvent): void => {
          this.host = hostOf(event.url);
        })
        .onLoadIntercept((event: OnLoadInterceptEvent): boolean => this.interceptAppLink(event.data.getRequestUrl()))
    }
    .id('screen_in_app_browser')
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.background_primary'))
  }
}

function hostOf(url: string): string {
  const match: RegExpMatchArray | null = url.match(new RegExp('^[a-zA-Z][a-zA-Z0-9+.-]*://(?:www\\.)?([^/:?#]+)'));
  return match === null ? '' : match[1];
}
