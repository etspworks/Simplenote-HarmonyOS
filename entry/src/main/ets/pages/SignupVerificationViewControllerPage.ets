// Port of SignupVerificationViewController.swift (+ .xib) — pushed from SPAuthViewController after a signup
// request. Structure: nav bar with back, mail icon, message naming the email (highlighted), and a footer whose
// support email is a mailto: link.
import { common, Want } from '@kit.AbilityKit';
import { router, LengthMetrics, EditableTitleBar, EditableLeftIconType } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { SignupVerificationRouteParams } from './SPAuthViewControllerPage';

const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'SignupVerification';
/// SPCredentials.simplenoteFeedbackMail (SPCredentials-demo.swift; no data-layer constant carries it)
const SIMPLENOTE_FEEDBACK_MAIL: string = 'not.required@not.required.com';
const MESSAGE_PREFIX: string = 'We’ve sent an email to ';
const MESSAGE_SUFFIX: string = '. Please check your inbox and follow the instructions.';
const FOOTER_PREFIX: string =
  'Didn\'t get an email? There may already be an account associated with this email address. Contact ';
const FOOTER_SUFFIX: string = ' for help.';

@Entry
@Component
struct SignupVerificationViewControllerPage {
  /// AuthenticationState.username (router param)
  @State email: string = '';

  aboutToAppear(): void {
    const params: SignupVerificationRouteParams | undefined =
      router.getParams() as SignupVerificationRouteParams | undefined;
    if (params !== undefined && params !== null && params.email !== undefined) {
      this.email = params.email;
    }
  }

  /// Back -> pop to the auth screen.
  private back(): void {
    router.back();
  }

  /// footerTextView link: mailto:SPCredentials.simplenoteFeedbackMail. Mail apps register mailto under
  /// ohos.want.action.sendToData (the documented mailto contract), so start that implicit Want first; openLink only
  /// matches viewData + browsable skills and stays as the fallback for mail apps registered that way.
  private openSupportMail(): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    const mailto: string = `mailto:${SIMPLENOTE_FEEDBACK_MAIL}`;
    const want: Want = { action: 'ohos.want.action.sendToData', uri: mailto };
    context.startAbility(want)
      .catch((e: Error) => {
        hilog.warn(DOMAIN, LOG_TAG, 'mailto sendToData failed, trying openLink: %{public}s', e.message);
        return context.openLink(mailto);
      })
      .catch((e: Error) => {
        hilog.error(DOMAIN, LOG_TAG, 'mailto failed: %{public}s', e.message);
        this.getUIContext().getPromptAction().showToast({ message: `No mail app available. Contact ${SIMPLENOTE_FEEDBACK_MAIL}` });
      });
  }

  build() {
    Column() {
      // HarmonyOS level-2 title bar: back + the signup mode title ("Sign Up"; only signup pushes this page).
      // The wrapper carries signup_verification_back for QA: EditableTitleBar does not expose its back button.
      Column() {
        EditableTitleBar({
          leftIconStyle: EditableLeftIconType.Back,
          title: 'Sign Up',
          isSaveIconRequired: false,
          onCancel: (): void => {
            this.back();
          }
        })
      }
      .id('signup_verification_back')
      .width('100%')

      // scrollView centred vertically; vertical stack, spacing 20
      Scroll() {
        Column({ space: 20 }) {
          // iconView (icon_mail): height 72, tint simplenoteTitleColor
          Image($r('app.media.ic_mail'))
            .height(72)
            .aspectRatio(1)
            .objectFit(ImageFit.Contain)
            .fillColor($r('app.color.simplenote_title'))
            .accessibilityLevel('no')

          // textLabel: body, simplenoteTextColor; the email in headline
          Text() {
            Span(MESSAGE_PREFIX)
            Span(this.email)
              .fontSize($r('sys.float.Body_L'))
              .fontWeight(FontWeight.Medium)
            Span(MESSAGE_SUFFIX)
          }
          .width('100%')
          .fontSize($r('sys.float.Body_L'))
          .fontColor($r('app.color.simplenote_text'))
          .textAlign(TextAlign.Center)

          // footerTextView: subheadline, simplenoteSecondaryTextColor; the support email underlined
          Text() {
            Span(FOOTER_PREFIX)
            Span(SIMPLENOTE_FEEDBACK_MAIL)
              .fontColor($r('sys.color.font_emphasize'))
              .onClick((): void => {
                this.openSupportMail();
              })
            Span(FOOTER_SUFFIX)
          }
          .width('100%')
          .fontSize($r('sys.float.Body_M'))
          .fontColor($r('app.color.simplenote_secondary_text'))
          .textAlign(TextAlign.Center)
        }
        .width('100%')
        .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16), top: LengthMetrics.vp(20),
          bottom: LengthMetrics.vp(20) })
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.Center)
      .scrollBar(BarState.Off)
    }
    .id('screen_signup_verification')
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.simplenote_background'))
  }
}
