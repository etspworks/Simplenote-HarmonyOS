// Port of Verification/AccountVerificationViewController.swift (+ .xib): full-screen page presented
// over the note list. Two configurations: `review` (warning icon, Confirm + Change Email) and
// `verify` (mail icon, only Resend Email). S3: structure (xib tree: dismiss cross, scroll view with
// icon / title / message, button stack).
import { router, LengthMetrics } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AccountVerificationController } from '../common/AccountService';
import { RemoteResult } from '../common/endpoints/Remote';
import { SessionStore } from '../common/SessionStore';
import { SPTracker } from '../common/Tracker';
import { ActivityIndicatorButton } from '../components/ActivityIndicatorButton';
import { HmIconButton } from '../components/HmIconButton';

const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'AccountVerification';
/// SimplenoteConstants.settingsURL
const SETTINGS_URL: string = 'https://app.simplenote.com/settings';

/// AccountVerificationViewController.Configuration (review | verify)
export enum VerificationConfiguration {
  REVIEW = 'review',
  VERIFY = 'verify'
}

/// Router params: SPAppDelegate picks .review for an unverified account, .verify otherwise.
export class AccountVerificationRouteParams {
  configuration: VerificationConfiguration = VerificationConfiguration.REVIEW;
}

@Entry
@Component
struct AccountVerificationViewControllerPage {
  /// configuration (review | verify) — AccountVerificationController.state drives the initial value.
  @State state: VerificationConfiguration = VerificationConfiguration.REVIEW;
  /// controller.email (svc_session user email)
  @State email: string = '';
  /// primaryButton.inProgress / secondaryButton.inProgress
  @State primaryInProgress: boolean = false;
  @State secondaryInProgress: boolean = false;
  /// verify-email request running: updateButtons(isEnabled: !inProgress)
  @State inProgress: boolean = false;
  private controller: AccountVerificationController | null = null;

  aboutToAppear(): void {
    const params: AccountVerificationRouteParams | undefined =
      router.getParams() as AccountVerificationRouteParams | undefined;
    if (params !== undefined && params !== null && params.configuration !== undefined) {
      this.state = params.configuration;
    }
    this.email = SessionStore.shared().userEmail;
    this.controller = new AccountVerificationController(this.email);
  }

  onPageShow(): void {
    this.trackScreen();
  }

  /// isModalInPresentation = true: system back is swallowed, so the buttons are the only way out
  /// (and every dismissal is tracked). Programmatic router.back() is unaffected.
  onBackPress(): boolean {
    return true;
  }

  /// trackScreen(): viewWillAppear + every configuration change
  private trackScreen(): void {
    if (this.state === VerificationConfiguration.REVIEW) {
      SPTracker.trackAutomatticEventWithName('verification_review_screen_viewed', null);
    } else {
      SPTracker.trackAutomatticEventWithName('verification_verify_screen_viewed', null);
    }
  }

  // MARK: - Buttons

  handleTapOnDismissButton(): void {
    this.dismiss();
    SPTracker.trackAutomatticEventWithName('verification_dismissed', null);
  }

  handleTapOnPrimaryButton(): void {
    if (this.state !== VerificationConfiguration.REVIEW) {
      return;
    }
    this.verifyEmail(true, (): void => {
      this.state = VerificationConfiguration.VERIFY;
      this.trackScreen();
    });
    SPTracker.trackAutomatticEventWithName('verification_confirm_button_tapped', null);
  }

  handleTapOnSecondaryButton(): void {
    if (this.state === VerificationConfiguration.REVIEW) {
      const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
      context.openLink(SETTINGS_URL).catch((e: Error) => {
        hilog.error(DOMAIN, LOG_TAG, 'openLink failed: %{public}s', e.message);
      });
      this.dismiss();
      SPTracker.trackAutomatticEventWithName('verification_change_email_button_tapped', null);
    } else {
      this.verifyEmail(false, (): void => {
        hilog.info(DOMAIN, LOG_TAG, 'verification email resent');
      });
      SPTracker.trackAutomatticEventWithName('verification_resend_email_button_tapped', null);
    }
  }

  // MARK: - Private

  private verifyEmail(usePrimary: boolean, onSuccess: () => void): void {
    const controller: AccountVerificationController | null = this.controller;
    if (controller === null) {
      return;
    }
    if (usePrimary) {
      this.primaryInProgress = true;
    } else {
      this.secondaryInProgress = true;
    }
    this.inProgress = true;
    controller.verify((result: RemoteResult): void => {
      if (result.isSuccess) {
        onSuccess();
      } else {
        this.showErrorMessage();
      }
      this.primaryInProgress = false;
      this.secondaryInProgress = false;
      this.inProgress = false;
    });
  }

  private showErrorMessage(): void {
    AlertDialog.show({
      title: this.state === VerificationConfiguration.REVIEW ? $r('app.string.cannot_confirm_account') :
        $r('app.string.cannot_send_verification_email'),
      message: $r('app.string.please_check_your_network_settings_and_try_again'),
      confirm: {
        value: $r('app.string.ok'),
        action: (): void => {
          hilog.info(DOMAIN, LOG_TAG, 'error alert dismissed');
        }
      }
    });
  }

  private dismiss(): void {
    router.back();
  }

  /// NSLocalizedString for the button titles (ActivityIndicatorButton.title is a plain string).
  private localized(res: Resource): string {
    try {
      return getContext(this).resourceManager.getStringSync(res);
    } catch (e) {
      hilog.error(DOMAIN, LOG_TAG, 'title resource failed: %{public}s', (e as Error).message);
      return '';
    }
  }

  // MARK: - Message (attributedText(_:highlighting:): body text, the email set in .headline)

  private messageFull(): string {
    const res: Resource = this.state === VerificationConfiguration.REVIEW ?
      $r('app.string.you_are_registered_with_simplenote_using_the_email_1_improve') :
      $r('app.string.we_ve_sent_a_verification_email_to_1_please_check_your_inbox');
    try {
      return getContext(this).resourceManager.getStringSync(res, this.email);
    } catch (e) {
      hilog.error(DOMAIN, LOG_TAG, 'message resource failed: %{public}s', (e as Error).message);
      return this.email;
    }
  }

  private messagePart(before: boolean): string {
    const full: string = this.messageFull();
    const at: number = this.email.length > 0 ? full.indexOf(this.email) : -1;
    if (at < 0) {
      return before ? full : '';
    }
    return before ? full.substring(0, at) : full.substring(at + this.email.length);
  }

  @Builder
  messageText() {
    Text() {
      Span(this.messagePart(true))
      Span(this.email.length > 0 && this.messageFull().indexOf(this.email) >= 0 ? this.email : '')
        .fontWeight(FontWeight.Medium)
      Span(this.messagePart(false))
    }
    .fontSize($r('sys.float.Body_L'))
    .fontColor($r('app.color.simplenote_text'))
    .lineHeight(22)
    .textAlign(TextAlign.Start)
    .width('100%')
  }

  build() {
    Stack({ alignContent: Alignment.TopEnd }) {
      // outer stack (xib cW6): scroll view on top, button container pinned below it (spacing 10)
      Column({ space: 10 }) {
        Scroll() {
          // contentStackView: icon, title, message (spacing 26, 32vp side insets)
          Column({ space: 26 }) {
            if (this.state === VerificationConfiguration.REVIEW) {
              Image($r('app.media.ic_warning'))
                .width(60)
                .height(60)
                .objectFit(ImageFit.Contain)
                .fillColor($r('app.color.simplenote_title'))
                .accessibilityLevel('no')
              Text($r('app.string.review_your_account'))
                .fontSize($r('sys.float.Title_L'))
                .fontWeight(FontWeight.Bold)
                .fontColor($r('sys.color.font_primary'))
                .textAlign(TextAlign.Center)
                .width('100%')
              this.messageText()
            } else {
              Image($r('app.media.ic_mail'))
                .width(60)
                .height(60)
                .objectFit(ImageFit.Contain)
                .fillColor($r('app.color.simplenote_title'))
                .accessibilityLevel('no')
              Text($r('app.string.verify_your_email'))
                .fontSize($r('sys.float.Title_L'))
                .fontWeight(FontWeight.Bold)
                .fontColor($r('sys.color.font_primary'))
                .textAlign(TextAlign.Center)
                .width('100%')
              this.messageText()
            }
          }
          .width('100%')
          .padding({ start: LengthMetrics.vp(32), end: LengthMetrics.vp(32), top: LengthMetrics.vp(72),
            bottom: LengthMetrics.vp(20) })
          .alignItems(HorizontalAlign.Center)
        }
        .width('100%')
        .layoutWeight(1)
        .align(Alignment.Top)
        .scrollBar(BarState.Off)

        // Button stack (fillEqually, spacing 16, 24vp insets, max width 460):
        // primary hidden when configuration.primaryButton == nil (verify)
        Column({ space: 16 }) {
          if (this.state === VerificationConfiguration.REVIEW) {
            ActivityIndicatorButton({
              title: this.localized($r('app.string.confirm')),
              buttonId: 'account_verification_primary',
              inProgress: this.primaryInProgress,
              isEnabled: !this.inProgress,
              isPrimary: true,
              onTap: (): void => {
                this.handleTapOnPrimaryButton();
              }
            })
          }
          ActivityIndicatorButton({
            title: this.localized(this.state === VerificationConfiguration.REVIEW ? $r('app.string.change_email') :
              $r('app.string.resend_email')),
            buttonId: 'account_verification_secondary',
            inProgress: this.secondaryInProgress,
            isEnabled: !this.inProgress,
            isPrimary: false,
            onTap: (): void => {
              this.handleTapOnSecondaryButton();
            }
          })
        }
        .width('100%')
        .constraintSize({ maxWidth: 480 })
        .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16), bottom: LengthMetrics.vp(20) })
      }
      .width('100%')
      .height('100%')
      .alignItems(HorizontalAlign.Center)

      // dismissButton -> handleTapOnDismissButton: HarmonyOS xmark icon button
      Column() {
        HmIconButton({
          symbol: $r('sys.symbol.xmark'),
          label: this.localized($r('app.string.close')),
          buttonId: 'account_verification_dismiss',
          action: (): void => {
            this.handleTapOnDismissButton();
          }
        })
      }
      .margin({ top: LengthMetrics.vp(8), end: LengthMetrics.vp(16) })
    }
    .id('screen_account_verification')
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.simplenote_verification_screen_background'))
  }
}
