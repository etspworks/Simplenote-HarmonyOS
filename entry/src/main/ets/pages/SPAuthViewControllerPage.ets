// Port of SPAuthViewController (+ its xib, AuthenticationMode, AuthenticationValidator,
// UIAlertController+Auth). One page renders every AuthenticationMode; a multi-staged flow pushes
// this page again with the next mode and the carried AuthenticationState (as the source pushes a
// new SPAuthViewController).
// Hosts the SPDiagnosticsViewController sheet (screen_diagnostics).
import { router, promptAction, EditableTitleBar, EditableLeftIconType } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { emitter } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { SessionEvent, SessionStore } from '../common/SessionStore';
import { SPAuthHandler, WPAuthHandler } from '../common/AuthService';
import { Simperium, SPCredentials } from '../common/simperium/Simperium';
import { AccountRemote } from '../common/endpoints/AccountRemote';
import { RemoteResult } from '../common/endpoints/Remote';
import { SPAuthError, SPAuthErrorKind } from '../model/SPAuthError';
import { AuthRouteParams } from './SPOnboardingViewControllerPage';
import { SPDiagnosticsViewController } from './SPDiagnosticsViewControllerPage';
import { SPTextInputView } from '../components/TextInput';
import { SpinnerViewController } from '../components/SpinnerOverlay';
import { InAppBrowserSheet } from '../components/InAppBrowserSheet';
import { SPTracker } from '../common/Tracker';

const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'Auth';

export class SignupVerificationRouteParams {
  email: string = '';
}

/// AuthenticationMode (AuthenticationMode.swift): the four default operation modes.
class AuthenticationMode {
  static readonly REQUEST_LOGIN_CODE: string = 'requestLoginCode';
  static readonly LOGIN_WITH_CODE: string = 'loginWithCode';
  static readonly LOGIN_WITH_PASSWORD: string = 'loginWithPassword';
  static readonly SIGNUP: string = 'signup';

  static title(mode: string): string {
    if (mode === AuthenticationMode.LOGIN_WITH_CODE) {
      return 'Enter Code';
    }
    if (mode === AuthenticationMode.LOGIN_WITH_PASSWORD) {
      return 'Log In with Password';
    }
    if (mode === AuthenticationMode.SIGNUP) {
      return 'Sign Up';
    }
    return 'Log In';
  }

  static primaryTitle(mode: string): string {
    if (mode === AuthenticationMode.REQUEST_LOGIN_CODE) {
      return 'Log in with email';
    }
    if (mode === AuthenticationMode.SIGNUP) {
      return 'Sign Up';
    }
    return 'Log In';
  }

  /// validationStyle: signup is .strong, every login mode is .legacy
  static isStrongValidation(mode: string): boolean {
    return mode === AuthenticationMode.SIGNUP;
  }
}

class AuthenticationStrings {
  static readonly SEPARATOR_TEXT: string = 'Or';
  static readonly EMAIL_PLACEHOLDER: string = 'Email';
  static readonly PASSWORD_PLACEHOLDER: string = 'Password';
  static readonly CODE_PLACEHOLDER: string = 'Code';
  static readonly ACCEPT_ACTION_TEXT: string = 'Accept';
  static readonly CANCEL_ACTION_TEXT: string = 'Cancel';
  static readonly LOGIN_ACTION_TEXT: string = 'Log In';
  static readonly LOGIN_WITH_CODE_HEADER: string =
    'We\'ve sent a code to {{EMAIL}}. The code will be valid for a few minutes.';
  static readonly LOGIN_WITH_EMAIL_EMAIL_HEADER: string = 'Enter the password for the account {{EMAIL}}';
  static readonly LOGIN_WITH_EMAIL_LIMIT_HEADER: string = 'Log in with email failed, please enter your password';
  static readonly COMPROMISED_ALERT_CANCEL: string = 'Cancel';
  static readonly COMPROMISED_ALERT_RESET: string = 'Change Password';
  static readonly UNVERIFIED_CANCEL_TEXT: string = 'Ok';
  static readonly UNVERIFIED_ACTION_TEXT: string = 'Resend Verification Email';
  static readonly UNVERIFIED_ERROR_TITLE: string = 'Request Error';
  static readonly UNVERIFIED_ERROR_MESSAGE: string =
    'There was an preparing your verification email, please try again later';
  static readonly VERIFICATION_SENT_TITLE: string = 'Check your Email';
  static readonly VERIFICATION_SENT_TEMPLATE: string =
    'We’ve sent a verification email to %1$@. Please check your inbox and follow the instructions.';
  static readonly USERNAME_AND_PASSWORD_PREFIX: string = 'We\'ll email you a code to log in, or you can';
  static readonly USERNAME_AND_PASSWORD_SUFFIX: string = 'log in manually.';
  static readonly TERMS_PREFIX: string = 'By creating an account you agree to our';
  static readonly TERMS_SUFFIX: string = 'Terms and Conditions';
  static readonly WPCOM_ACTION: string = 'Log in with WordPress.com';
  static readonly ENTER_PASSWORD_ACTION: string = 'Enter password';
  static readonly FORGOT_PASSWORD_ACTION: string = 'Forgot your password?';
  static readonly CODE_EXPIRED_TITLE: string = 'Sorry!';
  static readonly CODE_EXPIRED_MESSAGE: string =
    'The authentication code you\'ve requested has expired. Please request a new one';
  static readonly PASSWORD_INSECURE_TITLE: string = 'Reset Required';
  static readonly PASSWORD_INSECURE_MESSAGE: string =
    'Your password is insecure and must be reset. The password requirements are:\n\n\n' +
      '- Password cannot match email\n- Minimum of 8 characters\n- Neither tabs nor newlines are allowed';
  static readonly PASSWORD_INSECURE_RESET: string = 'Reset';
}

const TERMS_OF_SERVICE_URL: string = 'https://simplenote.com/terms/';
const RESET_PASSWORD_PATH: string = '/reset/?redirect=simplenote://launch&email=';

/// AuthenticationValidator.swift (screen-local: only this screen validates credentials).
class AuthenticationValidator {
  static readonly LEGACY_PASSWORD_LENGTH: number = 4;
  static readonly STRONG_PASSWORD_LENGTH: number = 8;
  static readonly LOGIN_CODE_LENGTH: number = 6;
  /// NSPredicate.predicateForEmailValidation (SELF MATCHES: whole-string match)
  static readonly EMAIL_REGEX: RegExp = new RegExp('^.+@([A-Za-z0-9-]+\\.)+[A-Za-z]{2}[A-Za-z]*$');

  /// Each returns the Result.description: '' is .success.
  static performUsernameValidation(username: string): string {
    return AuthenticationValidator.EMAIL_REGEX.test(username) ? '' : 'Your email address is not valid';
  }

  static performPasswordValidation(username: string, password: string, strong: boolean): string {
    const required: number = strong ? AuthenticationValidator.STRONG_PASSWORD_LENGTH :
      AuthenticationValidator.LEGACY_PASSWORD_LENGTH;
    if (password.length < required) {
      return 'Password must contain at least ' + required.toString() + ' characters';
    }
    if (!strong) {
      return '';
    }
    if (password === username) {
      return 'Password cannot match email';
    }
    if (password.includes('\n') || password.includes('\t')) {
      return 'Password must not contain tabs nor newlines';
    }
    return '';
  }

  static performCodeValidation(code: string): string {
    return code.length >= AuthenticationValidator.LOGIN_CODE_LENGTH ? '' : 'Login Code is too short';
  }
}

@Entry
@Component
struct SPAuthViewControllerPage {
  /// AuthenticationMode (router param; the source's designated-initializer default is .requestLoginCode)
  @State mode: string = AuthenticationMode.REQUEST_LOGIN_CODE;
  /// loginWithPassword(header:includeUsername:)
  @State passwordHeader: string = '';
  @State includeUsername: boolean = false;
  /// AuthenticationState
  @State username: string = '';
  @State password: string = '';
  @State code: string = '';
  /// Inline validation warnings ('' = hidden)
  @State emailError: string = '';
  @State passwordError: string = '';
  @State codeError: string = '';
  /// revealPasswordButton.isSelected
  @State passwordRevealed: boolean = false;
  /// primaryActionSpinner / lockdownInterface
  @State inProgress: boolean = false;
  /// SpinnerViewController while a verification email is re-sent
  @State showSpinner: boolean = false;
  @State showDiagnostics: boolean = false;
  @State diagnosticsDetails: string = '';
  /// SFSafariViewController (formSheet): WordPress.com OAuth, Forgot password and Terms pages in InAppBrowserSheet.
  @State showWordPressSSO: boolean = false;
  @State wordPressSSOURL: string = '';
  private debugEnabled: boolean = false;
  private mustResetPasswordField: boolean = false;
  private controllerValue: SPAuthHandler | null = null;
  private authDismissedListener: ((data: emitter.EventData) => void) | null = null;
  /// Every pushed auth step listens; only the one on screen resets the stack (else N replaces).
  private isVisible: boolean = false;

  aboutToAppear(): void {
    const params: AuthRouteParams | undefined = router.getParams() as AuthRouteParams | undefined;
    if (params !== undefined && params !== null) {
      if (params.mode !== undefined && params.mode.length > 0) {
        this.mode = params.mode;
      }
      this.passwordHeader = params.header !== undefined ? params.header : '';
      this.includeUsername = params.includeUsername === true;
      this.username = params.username !== undefined ? params.username : '';
      this.password = params.password !== undefined ? params.password : '';
      this.code = params.code !== undefined ? params.code : '';
      this.debugEnabled = params.debugEnabled === true;
      if (params.overlay === 'diagnostics') {
        this.presentDebugDetails();
      }
    }
    const dismissed: (data: emitter.EventData) => void = (data: emitter.EventData): void => {
      this.dismissAuthentication();
    };
    this.authDismissedListener = dismissed;
    emitter.on(SessionEvent.AUTHENTICATION_DISMISSED, dismissed);
  }

  aboutToDisappear(): void {
    if (this.authDismissedListener !== null) {
      emitter.off(SessionEvent.AUTHENTICATION_DISMISSED, this.authDismissedListener);
    }
  }

  /// applicationDidBecomeActive -> ensurePasswordFieldIsReset
  onPageShow(): void {
    this.isVisible = true;
    if (this.mustResetPasswordField) {
      this.password = '';
    }
    // viewDidAppear focuses visibleInputViews.first on iOS. Ported for Enter Code only (T-0251): on
    // the onboarding-pushed modes the raised keyboard consumes the first system Back, so Back no
    // longer pops to onboarding (Phase-4 S0018).
    if (this.mode === AuthenticationMode.LOGIN_WITH_CODE) {
      this.becomeFirstResponder(this.firstVisibleInputId());
    }
  }

  /// becomeFirstResponder, deferred with one retry as TagListRow.becomeFirstResponder: the field
  /// may not be laid out yet when onPageShow runs.
  private becomeFirstResponder(inputId: string): void {
    setTimeout((): void => {
      if (!focusControl.requestFocus(inputId)) {
        setTimeout((): void => {
          focusControl.requestFocus(inputId);
        }, 100);
      }
    }, 0);
  }

  /// visibleInputViews.first: email (when shown), else password, else code.
  firstVisibleInputId(): string {
    if (this.showsUsername()) {
      return 'auth_email';
    }
    return this.mode === AuthenticationMode.LOGIN_WITH_CODE ? 'auth_code' : 'auth_password';
  }

  onPageHide(): void {
    this.isVisible = false;
  }

  // MARK: - Mode helpers (mode.inputElements / mode.actions)

  showsUsername(): boolean {
    return this.mode === AuthenticationMode.REQUEST_LOGIN_CODE || this.mode === AuthenticationMode.SIGNUP ||
      (this.mode === AuthenticationMode.LOGIN_WITH_PASSWORD && this.includeUsername);
  }

  /// mode.buildHeaderText(email: state.username) — '' hides the header container.
  headerText(): string {
    let header: string = '';
    if (this.mode === AuthenticationMode.LOGIN_WITH_CODE) {
      header = AuthenticationStrings.LOGIN_WITH_CODE_HEADER;
    } else if (this.mode === AuthenticationMode.LOGIN_WITH_PASSWORD) {
      header = this.passwordHeader;
    }
    return header.replace('{{EMAIL}}', this.username);
  }

  /// Text around the first match of the email (iOS highlights only `range(of: email)` in bold).
  headerPart(before: boolean): string {
    const full: string = this.headerText();
    const at: number = this.username.length > 0 ? full.indexOf(this.username) : -1;
    if (at < 0) {
      return before ? full : '';
    }
    return before ? full.substring(0, at) : full.substring(at + this.username.length);
  }

  controller(): SPAuthHandler | null {
    if (this.controllerValue === null) {
      const simperium: Simperium | null = SessionStore.shared().simperium;
      if (simperium === null) {
        hilog.error(DOMAIN, LOG_TAG, 'Missing Simperium Authenticator Instance');
        return null;
      }
      this.controllerValue = new SPAuthHandler(simperium.authenticator);
    }
    return this.controllerValue;
  }

  context(): common.UIAbilityContext {
    return getContext(this) as common.UIAbilityContext;
  }

  // MARK: - Validation

  /// ensureWarningsAreOnScreenWhenNeeded: shows warnings, true when all validations pass.
  ensureWarningsAreOnScreenWhenNeeded(): boolean {
    let valid: boolean = true;
    if (this.showsUsername()) {
      this.emailError = AuthenticationValidator.performUsernameValidation(this.username);
      valid = valid && this.emailError === '';
    }
    if (this.mode === AuthenticationMode.LOGIN_WITH_PASSWORD) {
      this.passwordError = AuthenticationValidator.performPasswordValidation(this.username, this.password,
        AuthenticationMode.isStrongValidation(this.mode));
      valid = valid && this.passwordError === '';
    }
    if (this.mode === AuthenticationMode.LOGIN_WITH_CODE) {
      this.codeError = AuthenticationValidator.performCodeValidation(this.code);
      valid = valid && this.codeError === '';
    }
    return valid;
  }

  /// isInputValid: every visible input element validates (no warnings shown) — drives the primary colour.
  isInputValid(): boolean {
    let valid: boolean = true;
    if (this.showsUsername()) {
      valid = valid && AuthenticationValidator.performUsernameValidation(this.username) === '';
    }
    if (this.mode === AuthenticationMode.LOGIN_WITH_PASSWORD) {
      valid = valid && AuthenticationValidator.performPasswordValidation(this.username, this.password,
        AuthenticationMode.isStrongValidation(this.mode)) === '';
    }
    if (this.mode === AuthenticationMode.LOGIN_WITH_CODE) {
      valid = valid && AuthenticationValidator.performCodeValidation(this.code) === '';
    }
    return valid;
  }

  /// state didSet -> ensureWarningsAreDismissedWhenNeeded
  ensureWarningsAreDismissedWhenNeeded(): void {
    if (this.emailError !== '' && AuthenticationValidator.performUsernameValidation(this.username) === '') {
      this.emailError = '';
    }
    if (this.passwordError !== '' && AuthenticationValidator.performPasswordValidation(this.username,
      this.password, AuthenticationMode.isStrongValidation(this.mode)) === '') {
      this.passwordError = '';
    }
    if (this.codeError !== '' && AuthenticationValidator.performCodeValidation(this.code) === '') {
      this.codeError = '';
    }
  }

  // MARK: - Actions

  revealPasswordWasPressed(): void {
    this.passwordRevealed = !this.passwordRevealed;
  }

  /// textInputShouldReturn -> performPrimaryActionIfPossible
  performPrimaryActionIfPossible(): void {
    if (this.mode === AuthenticationMode.REQUEST_LOGIN_CODE) {
      this.requestLogInCode();
    } else if (this.mode === AuthenticationMode.LOGIN_WITH_CODE) {
      this.performLogInWithCode();
    } else if (this.mode === AuthenticationMode.LOGIN_WITH_PASSWORD) {
      this.performLogInWithPassword();
    } else {
      this.performSignUp();
    }
  }

  performLogInWithPassword(): void {
    if (!this.ensureWarningsAreOnScreenWhenNeeded()) {
      return;
    }
    const strongResult: string = AuthenticationValidator.performPasswordValidation(this.username, this.password, true);
    if (strongResult !== '') {
      this.performCredentialsValidation();
      return;
    }
    this.performSimperiumAuthentication();
  }

  requestLogInCode(): void {
    if (!this.ensureWarningsAreOnScreenWhenNeeded()) {
      return;
    }
    const controller: SPAuthHandler | null = this.controller();
    if (controller === null) {
      return;
    }
    this.inProgress = true;
    controller.requestLoginEmail(this.username).then((): void => {
      this.inProgress = false;
      this.presentCodeInterface();
      SPTracker.trackLoginLinkRequested();
    }).catch((e: Error): void => {
      this.inProgress = false;
      const error: SPAuthError = e instanceof SPAuthError ? e as SPAuthError : new SPAuthError(SPAuthErrorKind.GENERIC);
      if (error.kind === SPAuthErrorKind.TOO_MANY_ATTEMPTS) {
        this.presentPasswordInterfaceWithHeader(AuthenticationStrings.LOGIN_WITH_EMAIL_LIMIT_HEADER, false);
        return;
      }
      this.handleError(error);
    });
  }

  performLogInWithCode(): void {
    if (!this.ensureWarningsAreOnScreenWhenNeeded()) {
      return;
    }
    const controller: SPAuthHandler | null = this.controller();
    if (controller === null) {
      return;
    }
    this.inProgress = true;
    controller.loginWithCode(this.username, this.code).then((): void => {
      this.inProgress = false;
      SPTracker.trackLoginLinkConfirmationSuccess();
    }).catch((e: Error): void => {
      this.inProgress = false;
      SPTracker.trackLoginLinkConfirmationFailure();
      this.handleError(e instanceof SPAuthError ? e as SPAuthError : new SPAuthError(SPAuthErrorKind.GENERIC));
    });
  }

  /// SFSafariViewController: the in-app sheet; null (system browser) when ArkWeb is unavailable on the device.
  inAppBrowserPresenter(): ((url: string) => void) | null {
    return canIUse('SystemCapability.Web.Webview.Core') ?
      (url: string): void => {
        this.wordPressSSOURL = url;
        this.showWordPressSSO = true;
      } : null;
  }

  performLogInWithWPCOM(): void {
    WPAuthHandler.presentWordPressSSOFromViewController(this.context(), this.inAppBrowserPresenter())
      .catch((e: Error) => {
        hilog.error(DOMAIN, LOG_TAG, 'WordPress SSO failed: %{public}s', e.message);
      });
  }

  performSignUp(): void {
    if (!this.ensureWarningsAreOnScreenWhenNeeded()) {
      return;
    }
    const controller: SPAuthHandler | null = this.controller();
    if (controller === null) {
      return;
    }
    this.inProgress = true;
    controller.signupWithCredentials(this.username, (error: SPAuthError | null): void => {
      if (error !== null) {
        this.handleError(error);
      } else {
        this.presentSignupVerification(this.username);
      }
      this.inProgress = false;
    });
  }

  presentPasswordReset(): void {
    const controller: SPAuthHandler | null = this.controller();
    if (controller === null) {
      return;
    }
    controller.presentPasswordReset(this.context(), this.username, this.inAppBrowserPresenter())
      .catch((e: Error) => {
        hilog.error(DOMAIN, LOG_TAG, 'password reset failed: %{public}s', e.message);
      });
  }

  presentTermsOfService(): void {
    const presenter: ((url: string) => void) | null = this.inAppBrowserPresenter();
    if (presenter !== null) {
      presenter(TERMS_OF_SERVICE_URL);
      return;
    }
    this.context().openLink(TERMS_OF_SERVICE_URL).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'terms failed: %{public}s', e.message);
    });
  }

  presentPasswordInterface(): void {
    this.presentPasswordInterfaceWithHeader(AuthenticationStrings.LOGIN_WITH_EMAIL_EMAIL_HEADER, false);
  }

  presentUsernameAndPasswordInterface(): void {
    this.presentPasswordInterfaceWithHeader('', true);
  }

  presentPasswordInterfaceWithHeader(header: string, includeUsername: boolean): void {
    const params: AuthRouteParams = this.buildParams(AuthenticationMode.LOGIN_WITH_PASSWORD);
    params.header = header;
    params.includeUsername = includeUsername;
    this.pushAuth(params);
  }

  presentCodeInterface(): void {
    this.pushAuth(this.buildParams(AuthenticationMode.LOGIN_WITH_CODE));
  }

  buildParams(mode: string): AuthRouteParams {
    const params: AuthRouteParams = new AuthRouteParams();
    params.mode = mode;
    params.username = this.username;
    params.password = this.password;
    params.code = this.code;
    params.debugEnabled = this.debugEnabled;
    return params;
  }

  pushAuth(params: AuthRouteParams): void {
    router.pushUrl({ url: 'pages/SPAuthViewControllerPage', params: params }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'auth push failed: %{public}s', e.message);
    });
  }

  // MARK: - Simperium Services

  performCredentialsValidation(): void {
    const controller: SPAuthHandler | null = this.controller();
    if (controller === null) {
      return;
    }
    this.inProgress = true;
    controller.validateWithCredentials(this.username, this.password, (error: SPAuthError | null): void => {
      if (error !== null) {
        this.handleError(error);
      } else {
        this.presentPasswordResetRequiredAlert(this.username);
      }
      this.inProgress = false;
    });
  }

  performSimperiumAuthentication(): void {
    const controller: SPAuthHandler | null = this.controller();
    if (controller === null) {
      return;
    }
    this.inProgress = true;
    controller.loginWithCredentials(this.username, this.password, (error: SPAuthError | null): void => {
      if (error !== null) {
        this.handleError(error);
      } else {
        SPTracker.trackUserSignedIn();
      }
      this.inProgress = false;
    });
  }

  presentPasswordResetRequiredAlert(email: string): void {
    const resetURL: string = SPCredentials.DEFAULT_ENGINE_URL + RESET_PASSWORD_PATH + email;
    promptAction.showDialog({
      title: AuthenticationStrings.PASSWORD_INSECURE_TITLE,
      message: AuthenticationStrings.PASSWORD_INSECURE_MESSAGE,
      buttons: [
        { text: AuthenticationStrings.CANCEL_ACTION_TEXT, color: $r('app.color.simplenote_tint') },
        { text: AuthenticationStrings.PASSWORD_INSECURE_RESET, color: $r('app.color.simplenote_tint') }
      ]
    }).then((result: promptAction.ShowDialogSuccessResponse): void => {
      if (result.index === 1) {
        this.mustResetPasswordField = true;
        this.context().openLink(resetURL).catch((e: Error) => {
          hilog.error(DOMAIN, LOG_TAG, 'reset link failed: %{public}s', e.message);
        });
      }
    }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'reset alert failed: %{public}s', e.message);
    });
  }

  // MARK: - Error Handling

  handleError(error: SPAuthError): void {
    if (error.kind === SPAuthErrorKind.SIGNUP_USER_ALREADY_EXISTS) {
      this.presentAlert(error.title, error.message, [AuthenticationStrings.CANCEL_ACTION_TEXT,
        AuthenticationStrings.LOGIN_ACTION_TEXT], (index: number): void => {
        if (index === 1) {
          this.attemptLoginWithCurrentCredentials();
        }
      });
    } else if (error.kind === SPAuthErrorKind.COMPROMISED_PASSWORD) {
      this.presentAlert(error.title, error.message, [AuthenticationStrings.COMPROMISED_ALERT_CANCEL,
        AuthenticationStrings.COMPROMISED_ALERT_RESET], (index: number): void => {
        if (index === 1) {
          this.presentPasswordReset();
        }
      });
    } else if (error.kind === SPAuthErrorKind.UNVERIFIED_EMAIL) {
      this.presentUserUnverifiedError(error, this.username);
    } else if (error.kind === SPAuthErrorKind.REQUEST_NOT_FOUND) {
      this.presentAlert(AuthenticationStrings.CODE_EXPIRED_TITLE, AuthenticationStrings.CODE_EXPIRED_MESSAGE,
        [AuthenticationStrings.ACCEPT_ACTION_TEXT], (index: number): void => {
          router.back();
        });
    } else if (error.kind === SPAuthErrorKind.UNKNOWN && this.debugEnabled) {
      const details: string = 'Status Code: ' + error.statusCode.toString() + '\n\nResponse: ' +
        (error.response !== null ? error.response : '') + '\n\nError: ' +
        (error.error !== null ? error.error.message : '');
      this.presentDebugDetails(details);
    } else {
      this.presentAlert(error.title, error.message, [AuthenticationStrings.ACCEPT_ACTION_TEXT],
        (index: number): void => {
          hilog.info(DOMAIN, LOG_TAG, 'error alert accepted');
        });
    }
  }

  presentUserUnverifiedError(error: SPAuthError, email: string): void {
    this.presentAlert(error.title, error.message, [AuthenticationStrings.UNVERIFIED_CANCEL_TEXT,
      AuthenticationStrings.UNVERIFIED_ACTION_TEXT], (index: number): void => {
      if (index !== 1) {
        return;
      }
      this.showSpinner = true;
      new AccountRemote().verify(email, (result: RemoteResult): void => {
        this.showSpinner = false;
        if (result.error === null) {
          this.presentAlert(AuthenticationStrings.VERIFICATION_SENT_TITLE,
            AuthenticationStrings.VERIFICATION_SENT_TEMPLATE.replace('%1$@', email),
            [AuthenticationStrings.UNVERIFIED_CANCEL_TEXT], (i: number): void => {
              hilog.info(DOMAIN, LOG_TAG, 'verification sent alert dismissed');
            });
        } else {
          this.presentAlert(AuthenticationStrings.UNVERIFIED_ERROR_TITLE,
            AuthenticationStrings.UNVERIFIED_ERROR_MESSAGE, [AuthenticationStrings.UNVERIFIED_CANCEL_TEXT],
            (i: number): void => {
              hilog.info(DOMAIN, LOG_TAG, 'verification error alert dismissed');
            });
        }
      });
    });
  }

  presentAlert(title: string, message: string, buttonTitles: string[], onButton: (index: number) => void): void {
    const buttons: promptAction.Button[] = [];
    for (const buttonTitle of buttonTitles) {
      const button: promptAction.Button = { text: buttonTitle, color: $r('app.color.simplenote_tint') };
      buttons.push(button);
    }
    promptAction.showDialog({ title: title, message: message, buttons: buttons })
      .then((result: promptAction.ShowDialogSuccessResponse): void => {
        onButton(result.index);
      }).catch((e: Error) => {
        hilog.error(DOMAIN, LOG_TAG, 'alert failed: %{public}s', e.message);
      });
  }

  /// Swaps this auth step for loginWithPassword, prefilled with the current state.
  attemptLoginWithCurrentCredentials(): void {
    router.replaceUrl({
      url: 'pages/SPAuthViewControllerPage',
      params: this.buildParams(AuthenticationMode.LOGIN_WITH_PASSWORD)
    }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'login swap failed: %{public}s', e.message);
    });
  }

  /// Simperium auth success dismisses the whole auth navigation stack: reset to the note list.
  dismissAuthentication(): void {
    if (!this.isVisible) {
      return;
    }
    this.isVisible = false;
    router.clear();
    router.replaceUrl({ url: 'pages/SPNoteListViewControllerPage' }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'note list failed: %{public}s', e.message);
    });
  }

  /// presentSignupVerification
  presentSignupVerification(email: string): void {
    const params: SignupVerificationRouteParams = new SignupVerificationRouteParams();
    params.email = email;
    router.pushUrl({ url: 'pages/SignupVerificationViewControllerPage', params: params }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'signup verification failed: %{public}s', e.message);
    });
  }

  /// presentDebugDetails (formSheet)
  presentDebugDetails(details: string = ''): void {
    this.diagnosticsDetails = details;
    this.showDiagnostics = true;
  }

  @Builder
  diagnosticsSheet() {
    Column() {
      SPDiagnosticsViewController({
        attributedText: this.diagnosticsDetails,
        onDismiss: (): void => {
          this.showDiagnostics = false;
        }
      })
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  wordPressSSOSheet() {
    InAppBrowserSheet({
      src: this.wordPressSSOURL,
      onDismiss: (): void => {
        this.showWordPressSSO = false;
      }
    })
  }

  /// revealPasswordButton: the password field's rightView
  @Builder
  revealPasswordButton() {
    SymbolGlyph(this.passwordRevealed ? $r('sys.symbol.eye') : $r('sys.symbol.eye_slash'))
      .id('auth_reveal_password')
      .accessibilityText(this.passwordRevealed ? 'Hide password' : 'Reveal password')
      .fontSize(24)
      .fontColor([$r('sys.color.icon_secondary')])
      // accessoryViewInsets: 16 leading / 16 trailing
      .margin({ left: 16, right: 16 })
      .onClick((): void => {
        this.revealPasswordWasPressed();
      })
  }

  build() {
    Stack() {
      Column() {
        // HarmonyOS level-2 title bar: system back arrow + the mode title. The wrapper carries auth_back
        // for QA: EditableTitleBar does not expose its back button.
        Column() {
          EditableTitleBar({
            leftIconStyle: EditableLeftIconType.Back,
            title: AuthenticationMode.title(this.mode),
            isSaveIconRequired: false,
            onCancel: (): void => {
              router.back();
            }
          })
        }
        .id('auth_back')
        .width('100%')

        // StackView: top 40, 24 from each side, content at most 360 wide, 8pt spacing
        Column({ space: 8 }) {

          // Header View (hidden when mode has no header)
          if (this.headerText() !== '') {
            Text() {
              Span(this.headerPart(true))
              Span(this.username.length > 0 && this.headerText().indexOf(this.username) >= 0 ? this.username : '')
                .fontWeight(FontWeight.Bold)
              Span(this.headerPart(false))
            }
              .width('100%')
              .margin({ bottom: 20 })
              .fontSize($r('sys.float.Body_L'))
              .fontColor($r('app.color.simplenote_text'))
              .textAlign(TextAlign.Center)
          }

          // Email Input View + warning
          if (this.mode === AuthenticationMode.REQUEST_LOGIN_CODE || this.mode === AuthenticationMode.SIGNUP ||
            (this.mode === AuthenticationMode.LOGIN_WITH_PASSWORD && this.includeUsername)) {
            SPTextInputView({
              inputId: 'auth_email',
              placeholder: AuthenticationStrings.EMAIL_PLACEHOLDER,
              text: this.username,
              keyboardType: InputType.Email,
              returnKeyType: EnterKeyType.Next,
              inErrorState: this.emailError !== '',
              onTextChange: (text: string): void => {
                this.username = text;
                this.ensureWarningsAreDismissedWhenNeeded();
              },
              onShouldReturn: (): void => {
                this.performPrimaryActionIfPossible();
              }
            })
            if (this.emailError !== '') {
              Text(this.emailError)
                .width('100%')
                .padding({ left: 16 })
                .fontSize($r('sys.float.Body_M'))
                .fontColor($r('sys.color.warning'))
            }
          }

          // Password Input View (+ reveal) + warning
          if (this.mode === AuthenticationMode.LOGIN_WITH_PASSWORD) {
            SPTextInputView({
              inputId: 'auth_password',
              placeholder: AuthenticationStrings.PASSWORD_PLACEHOLDER,
              text: this.password,
              isSecureTextEntry: !this.passwordRevealed,
              inErrorState: this.passwordError !== '',
              hasRightView: true,
              rightView: (): void => {
                this.revealPasswordButton();
              },
              onTextChange: (text: string): void => {
                this.password = text;
                this.ensureWarningsAreDismissedWhenNeeded();
              },
              onShouldReturn: (): void => {
                this.performPrimaryActionIfPossible();
              }
            })
            if (this.passwordError !== '') {
              Text(this.passwordError)
                .width('100%')
                .padding({ left: 16 })
                .fontSize($r('sys.float.Body_M'))
                .fontColor($r('sys.color.warning'))
            }
          }

          // Code Input View + warning
          if (this.mode === AuthenticationMode.LOGIN_WITH_CODE) {
            SPTextInputView({
              inputId: 'auth_code',
              placeholder: AuthenticationStrings.CODE_PLACEHOLDER,
              text: this.code,
              maxLength: AuthenticationValidator.LOGIN_CODE_LENGTH,
              inErrorState: this.codeError !== '',
              onTextChange: (text: string): void => {
                this.code = text;
                this.ensureWarningsAreDismissedWhenNeeded();
              },
              onShouldReturn: (): void => {
                this.performPrimaryActionIfPossible();
              }
            })
            if (this.codeError !== '') {
              Text(this.codeError)
                .width('100%')
                .padding({ left: 16 })
                .fontSize($r('sys.float.Body_M'))
                .fontColor($r('sys.color.warning'))
            }
          }

          // Primary Action View: button + spinner
          Stack() {
            // HarmonyOS primary capsule; an invalid input dims it (the tap still validates, as before)
            Button(AuthenticationMode.primaryTitle(this.mode), { type: ButtonType.Capsule, stateEffect: true })
              .id('Main Action')
              .width('100%')
              .height(40)
              .backgroundColor($r('sys.color.brand'))
              .opacity(this.isInputValid() ? 1 : 0.4)
              .fontColor($r('sys.color.font_on_primary'))
              .fontSize($r('sys.float.Body_L'))
              .fontWeight(FontWeight.Medium)
              .onClick((): void => {
                this.performPrimaryActionIfPossible();
              })
            if (this.inProgress) {
              LoadingProgress()
                .width(24)
                .height(24)
                .color($r('sys.color.font_on_primary'))
                .margin({ right: 18 })
                .hitTestBehavior(HitTestMode.Transparent)
            }
          }
          .width('100%')
          .alignContent(Alignment.End)

          // Secondary Action
          if (this.mode === AuthenticationMode.REQUEST_LOGIN_CODE) {
            Text() {
              Span(AuthenticationStrings.USERNAME_AND_PASSWORD_PREFIX)
                .fontColor($r('sys.color.font_secondary'))
              Span(' ')
              Span(AuthenticationStrings.USERNAME_AND_PASSWORD_SUFFIX)
                .fontColor($r('sys.color.font_emphasize'))
            }
            .width('100%')
            .constraintSize({ minHeight: 44 })
            .fontSize($r('sys.float.Body_M'))
            .textAlign(TextAlign.Center)
            .id('auth_secondary_action')
            .onClick((): void => {
              this.presentUsernameAndPasswordInterface();
            })
          } else if (this.mode === AuthenticationMode.LOGIN_WITH_PASSWORD) {
            Button(AuthenticationStrings.FORGOT_PASSWORD_ACTION, { type: ButtonType.Normal, stateEffect: true })
              .id('auth_secondary_action')
              .width('100%')
              .height(40)
              .backgroundColor(Color.Transparent)
              .fontColor($r('sys.color.font_emphasize'))
              .fontSize($r('sys.float.Body_M'))
              .onClick((): void => {
                this.presentPasswordReset();
              })
          } else if (this.mode === AuthenticationMode.SIGNUP) {
            Text() {
              Span(AuthenticationStrings.TERMS_PREFIX)
                .fontColor($r('sys.color.font_secondary'))
              Span(' ')
              Span(AuthenticationStrings.TERMS_SUFFIX)
                .fontColor($r('sys.color.font_emphasize'))
            }
            .width('100%')
            .constraintSize({ minHeight: 44 })
            .fontSize($r('sys.float.Body_M'))
            .textAlign(TextAlign.Center)
            .id('auth_secondary_action')
            .onClick((): void => {
              this.presentTermsOfService();
            })
          }

          // Actions Separator View ("Or")
          if (this.mode === AuthenticationMode.REQUEST_LOGIN_CODE || this.mode === AuthenticationMode.LOGIN_WITH_CODE) {
            Row({ space: 8 }) {
              Divider()
                .layoutWeight(1)
                .color($r('sys.color.comp_divider'))
              Text(AuthenticationStrings.SEPARATOR_TEXT)
                .fontSize($r('sys.float.Body_S'))
                .fontColor($r('sys.color.font_secondary'))
              Divider()
                .layoutWeight(1)
                .color($r('sys.color.comp_divider'))
            }
            .width('100%')
            .height(44)
          }

          // Tertiary Action: WPCOM SSO
          if (this.mode === AuthenticationMode.REQUEST_LOGIN_CODE) {
            // WordPress.com keeps its brand blue (app colour), as a capsule
            Button(AuthenticationStrings.WPCOM_ACTION, { type: ButtonType.Capsule, stateEffect: true })
              .id('auth_tertiary_action')
              .width('100%')
              .height(40)
              .backgroundColor($r('app.color.simplenote_wpblue50'))
              .fontColor($r('sys.color.font_on_primary'))
              .fontSize($r('sys.float.Body_L'))
              .fontWeight(FontWeight.Medium)
              .onClick((): void => {
                this.performLogInWithWPCOM();
              })
          }

          // Quaternary Action: Enter password
          if (this.mode === AuthenticationMode.LOGIN_WITH_CODE) {
            Button(AuthenticationStrings.ENTER_PASSWORD_ACTION, { type: ButtonType.Capsule, stateEffect: true })
              .id('auth_quaternary_action')
              .width('100%')
              .height(40)
              .backgroundColor(Color.Transparent)
              .border({ width: 1, color: $r('sys.color.comp_divider') })
              .fontColor($r('sys.color.font_primary'))
              .fontSize($r('sys.float.Body_L'))
              .fontWeight(FontWeight.Medium)
              .onClick((): void => {
                this.presentPasswordInterface();
              })
          }
        }
        .width('100%')
        .constraintSize({ maxWidth: 480 })
        .padding({ left: 16, right: 16 })
        .margin({ top: 24 })
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('app.color.simplenote_background'))
      // lockdownInterface: view.isUserInteractionEnabled = false while a request runs
      .enabled(!this.inProgress)
      // The root Stack hosts the diagnostics sheet; one bindSheet per component.
      .bindSheet($$this.showWordPressSSO, this.wordPressSSOSheet(), {
        showClose: false,
        // modalPresentationStyle = .formSheet: full-height card on a phone
        height: SheetSize.LARGE,
        dragBar: false,
        backgroundColor: $r('sys.color.background_primary')
      })

      if (this.showSpinner) {
        SpinnerViewController()
      }
    }
    .id('screen_auth')
    .width('100%')
    .height('100%')
    .bindSheet($$this.showDiagnostics, this.diagnosticsSheet(), {
      showClose: false,
      // modalPresentationStyle = .formSheet: full-height card on a phone
      height: SheetSize.LARGE,
      dragBar: false,
      backgroundColor: $r('sys.color.background_primary')
    })
  }
}
