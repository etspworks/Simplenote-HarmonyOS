// Port of SPOnboardingViewController (Simperium's authenticationViewControllerClass) + its xib.
// Component tree: logo, brand, header, Sign Up / Log In, debug message banner.
// Hosts the MagicLinkInvalidView sheet (screen_magic_link_invalid).
import { router, promptAction } from '@kit.ArkUI';
import { emitter } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { NoteRouteParams } from './SPNoteListViewControllerPage';
import { MagicLinkInvalidView } from './MagicLinkInvalidViewPage';
import { MagicLinkEvent, SIGN_IN_ERROR_NOTIFICATION_NAME } from '../common/AuthService';
import { SessionEvent } from '../common/SessionStore';

const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'Onboarding';

/// Debug banner timings (UIKitConstants.animationDelayLong + animationLongDuration, rounded).
const DEBUG_MESSAGE_VISIBLE_MS: number = 2000;

/// AuthenticationMode + AuthenticationState carried across the auth flow's pushes.
/// mode: 'requestLoginCode' | 'loginWithCode' | 'loginWithPassword' | 'signup'.
export class AuthRouteParams {
  mode: string = 'requestLoginCode';
  overlay: string = '';
  /// loginWithPassword(header:includeUsername:)
  header: string = '';
  includeUsername: boolean = false;
  /// AuthenticationState
  username: string = '';
  password: string = '';
  code: string = '';
  debugEnabled: boolean = false;
}

class OnboardingStrings {
  static readonly DEBUG_DISABLED: string = 'Debug Disabled';
  static readonly DEBUG_ENABLED: string = '🐞 Debug Enabled 🐞';
  static readonly BRAND_TEXT: string = 'Simplenote';
  static readonly SIGNUP_TEXT: string = 'Sign Up';
  static readonly LOGIN_TEXT: string = 'Log In';
  static readonly HEADER_TEXT: string = 'The simplest way to keep notes.';
}

class SignInError {
  static readonly TITLE: string = 'Couldn\'t Sign In';
  static readonly GENERIC_ERROR_TEXT: string = 'An error was encountered while signing in.';
  static readonly ACCEPT_BUTTON_TEXT: string = 'OK';
}

@Entry
@Component
struct SPOnboardingViewControllerPage {
  @State showMagicLinkInvalid: boolean = false;
  /// Indicates if Extended Debugging has been enabled
  @State debugEnabled: boolean = false;
  /// messageView (hidden until the logo toggles debug mode)
  @State messageVisible: boolean = false;
  @State messageText: string = '';
  private messageTimer: number = -1;
  private signInErrorListener: ((data: emitter.EventData) => void) | null = null;
  private magicLinkFailListener: ((data: emitter.EventData) => void) | null = null;
  private authDismissedListener: ((data: emitter.EventData) => void) | null = null;
  /// Only the on-screen page resets the stack when Simperium closes the auth UI.
  private isVisible: boolean = false;

  aboutToAppear(): void {
    const params: NoteRouteParams | undefined = router.getParams() as NoteRouteParams | undefined;
    if (params !== undefined && params !== null && params.overlay === 'magicLinkInvalid') {
      this.presentMagicLinkInvalidView();
    }
    this.startListeningToNotifications();
  }

  aboutToDisappear(): void {
    if (this.signInErrorListener !== null) {
      emitter.off(SIGN_IN_ERROR_NOTIFICATION_NAME, this.signInErrorListener);
    }
    if (this.magicLinkFailListener !== null) {
      emitter.off(MagicLinkEvent.MAGIC_LINK_AUTH_DID_FAIL, this.magicLinkFailListener);
    }
    if (this.authDismissedListener !== null) {
      emitter.off(SessionEvent.AUTHENTICATION_DISMISSED, this.authDismissedListener);
    }
    if (this.messageTimer !== -1) {
      clearTimeout(this.messageTimer);
    }
  }

  onPageShow(): void {
    this.isVisible = true;
  }

  onPageHide(): void {
    this.isVisible = false;
  }

  startListeningToNotifications(): void {
    const onSignInError: (data: emitter.EventData) => void = (data: emitter.EventData): void => {
      this.handleSignInError(data);
    };
    const onMagicLinkFail: (data: emitter.EventData) => void = (data: emitter.EventData): void => {
      this.presentMagicLinkInvalidView();
    };
    const onAuthDismissed: (data: emitter.EventData) => void = (data: emitter.EventData): void => {
      this.dismissAuthentication();
    };
    this.authDismissedListener = onAuthDismissed;
    emitter.on(SessionEvent.AUTHENTICATION_DISMISSED, onAuthDismissed);
    this.signInErrorListener = onSignInError;
    this.magicLinkFailListener = onMagicLinkFail;
    emitter.on(SIGN_IN_ERROR_NOTIFICATION_NAME, onSignInError);
    emitter.on(MagicLinkEvent.MAGIC_LINK_AUTH_DID_FAIL, onMagicLinkFail);
  }

  handleSignInError(data: emitter.EventData): void {
    let message: string = SignInError.GENERIC_ERROR_TEXT;
    if (data.data !== undefined) {
      const payload: Record<string, Object> = data.data as Record<string, Object>;
      const value: Object | undefined = payload['message'];
      if (value !== undefined && value !== null) {
        message = value as string;
      }
    }
    // SFSafariViewController _might_ be onscreen: dismiss what we present first.
    this.showMagicLinkInvalid = false;
    promptAction.showDialog({
      title: SignInError.TITLE,
      message: message,
      buttons: [{ text: SignInError.ACCEPT_BUTTON_TEXT, color: $r('app.color.simplenote_tint') }]
    }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'sign-in error alert failed: %{public}s', e.message);
    });
  }

  // MARK: - Actions

  signupWasPressed(): void {
    this.presentAuthenticationInterface('signup');
  }

  loginWasPressed(): void {
    this.presentAuthenticationInterface('requestLoginCode');
  }

  unlockDebugMode(): void {
    this.debugEnabled = !this.debugEnabled;
    this.displayDebugMessage(this.debugEnabled);
  }

  displayDebugMessage(enabled: boolean): void {
    this.messageText = enabled ? OnboardingStrings.DEBUG_ENABLED : OnboardingStrings.DEBUG_DISABLED;
    this.messageVisible = true;
    if (this.messageTimer !== -1) {
      clearTimeout(this.messageTimer);
    }
    this.messageTimer = setTimeout((): void => {
      this.messageVisible = false;
      this.messageTimer = -1;
    }, DEBUG_MESSAGE_VISIBLE_MS);
  }

  /// presentAuthenticationInterface(mode:) -> pushViewController(SPAuthViewController)
  presentAuthenticationInterface(mode: string): void {
    const params: AuthRouteParams = new AuthRouteParams();
    params.mode = mode;
    params.debugEnabled = this.debugEnabled;
    router.pushUrl({ url: 'pages/SPAuthViewControllerPage', params: params }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'auth failed: %{public}s', e.message);
    });
  }

  /// Simperium closeAuthViewController (magic link / WordPress.com SSO succeeded while onboarding is
  /// on screen): the auth navigation stack goes away and the note list shows.
  dismissAuthentication(): void {
    if (!this.isVisible) {
      return;
    }
    this.isVisible = false;
    this.showMagicLinkInvalid = false;
    router.clear();
    router.replaceUrl({ url: 'pages/SPNoteListViewControllerPage' }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'note list failed: %{public}s', e.message);
    });
  }

  /// presentMagicLinkInvalidView (formSheet)
  presentMagicLinkInvalidView(): void {
    this.showMagicLinkInvalid = true;
  }

  @Builder
  magicLinkInvalidSheet() {
    Column() {
      MagicLinkInvalidView({
        onDismiss: (): void => {
          this.showMagicLinkInvalid = false;
        },
        onPressRequestNewLink: (): void => {
          this.presentAuthenticationInterface('requestLoginCode');
        }
      })
    }
    .width('100%')
  }

  build() {
    Stack({ alignContent: Alignment.Top }) {
      // ContainerView: content at most 360 wide, 24 from each side
      Stack({ alignContent: Alignment.Bottom }) {
        Column() {
          // simplenoteImageView — a triple tap toggles extended debugging (xib gesture -> unlockDebugMode)
          Image($r('app.media.simplenote_logo'))
            .width(96)
            .height(96)
            .objectFit(ImageFit.Contain)
            .fillColor($r('sys.color.brand'))
            .gesture(TapGesture({ count: 3 }).onAction((): void => {
              this.unlockDebugMode();
            }))
          // simplenoteLabel: largeTitle semibold, gray100
          Text(OnboardingStrings.BRAND_TEXT)
            .width('100%')
            .margin({ top: 28 })
            .fontSize($r('sys.float.Title_L'))
            .fontWeight(FontWeight.Bold)
            .fontColor($r('sys.color.font_primary'))
            .textAlign(TextAlign.Center)
            .maxLines(1)
            .minFontSize($r('sys.float.Body_S'))
            .maxFontSize($r('sys.float.Title_L'))
          // headerLabel: title3, gray50
          Text(OnboardingStrings.HEADER_TEXT)
            .width('100%')
            .margin({ top: 8 })
            .fontSize($r('sys.float.Body_L'))
            .fontColor($r('sys.color.font_secondary'))
            .textAlign(TextAlign.Center)
            .maxLines(1)
            .minFontSize($r('sys.float.Body_S'))
            .maxFontSize($r('sys.float.Body_L'))
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        // logo centre sits 120pt above the container centre (xib MlF-iP-aHg)
        .translate({ y: -70 })

        Column({ space: 8 }) {
          // HarmonyOS primary capsule (brand) + text button
          Button(OnboardingStrings.SIGNUP_TEXT, { type: ButtonType.Capsule, stateEffect: true })
            .id('onboarding_sign_up')
            .width('100%')
            .height(40)
            .backgroundColor($r('sys.color.brand'))
            .fontColor($r('sys.color.font_on_primary'))
            .fontSize($r('sys.float.Body_L'))
            .fontWeight(FontWeight.Medium)
            .onClick((): void => {
              this.signupWasPressed();
            })
          Button(OnboardingStrings.LOGIN_TEXT, { type: ButtonType.Capsule, stateEffect: true })
            .id('onboarding_log_in')
            .width('100%')
            .height(40)
            .backgroundColor(Color.Transparent)
            .fontColor($r('sys.color.font_emphasize'))
            .fontSize($r('sys.float.Body_L'))
            .fontWeight(FontWeight.Medium)
            .onClick((): void => {
              this.loginWasPressed();
            })
        }
        .width('100%')
        .constraintSize({ maxWidth: 448 })
        .margin({ bottom: 20 })
      }
      .width('100%')
      .height('100%')
      .constraintSize({ maxWidth: 480 })
      .padding({ left: 16, right: 16 })

      // messageView: debug banner (hidden by default), 60pt below the container top
      if (this.messageVisible) {
        Text(this.messageText)
          .margin({ top: 60 })
          .padding({ top: 10, bottom: 10, left: 20, right: 20 })
          .fontSize($r('sys.float.Body_L'))
          .fontWeight(FontWeight.Bold)
          .fontColor($r('sys.color.font_on_primary'))
          .backgroundColor(this.debugEnabled ? $r('app.color.simplenote_red50') : $r('app.color.simplenote_gray50'))
          .borderRadius(4)
      }
    }
    .id('screen_onboarding')
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.simplenote_background'))
    .bindSheet($$this.showMagicLinkInvalid, this.magicLinkInvalidSheet(), {
      detents: [SheetSize.MEDIUM],
      showClose: false,
      dragBar: false
    })
  }
}
