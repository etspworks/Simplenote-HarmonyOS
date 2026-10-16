// Port of SPAuthHandler.swift, MagicLinkAuthenticator.swift and WPAuthHandler.m.
// SFSafariViewController -> the presenter's in-app sheet (InAppBrowserSheet), else UIAbilityContext.openLink;
// NotificationCenter -> @kit.BasicServicesKit emitter; SPKeychain -> simperium/Authenticator.
import { common } from '@kit.AbilityKit';
import { emitter } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { LoginConfirmationResponse, LoginRemote } from './endpoints/LoginRemote';
import { SignupRemote } from './endpoints/SignupRemote';
import { RemoteError } from './endpoints/RemoteError';
import { RemoteResult } from './endpoints/Remote';
import { SPAuthenticator, SPKeychain } from './simperium/Authenticator';
import { SPCredentials } from './simperium/Simperium';
import { UserDefaults } from './Database';
import { SPTracker } from './Tracker';
import { SPAuthError, SPAuthErrorKind } from '../model/SPAuthError';
import { SPUser } from '../model/SPUser';

const DOMAIN: number = 0x0000;
const LOG_TAG: string = 'AuthService';

// SPConstants.m
export const SIMPERIUM_FORGOT_PASSWORD_URL: string = 'https://app.simplenote.com/forgot/';
export const SIMPLENOTE_WP_SERVICE_NAME: string = 'simplenote-wpcom';
export const SIGN_IN_ERROR_NOTIFICATION_NAME: string = 'SPSignInErrorNotificationName';
export const WORDPRESS_AUTH_URL_BASE: string =
  'https://public-api.wordpress.com/oauth2/authorize?response_type=code&scope=global';

// SPCredentials.swift (WordPress half; demo values as shipped)
export const WPCOM_CLIENT_ID: string = 'not-required';
export const WPCOM_REDIRECT_URL: string = 'not-required';

// NSNotification.Name (MagicLinkAuthenticator.swift)
export class MagicLinkEvent {
  static readonly MAGIC_LINK_AUTH_WILL_START: string = 'magicLinkAuthWillStart';
  static readonly MAGIC_LINK_AUTH_DID_SUCCEED: string = 'magicLinkAuthDidSucceed';
  static readonly MAGIC_LINK_AUTH_DID_FAIL: string = 'magicLinkAuthDidFail';
}

// MARK: - URL helpers (URLComponents / URLQueryItem)

export class URLQueryItem {
  name: string;
  value: string | null;

  constructor(name: string, value: string | null) {
    this.name = name;
    this.value = value;
  }
}

/** URL.host, lowercased; null when the string has no `scheme://host` authority. */
export function urlHost(link: string): string | null {
  const match: RegExpMatchArray | null = link.match(/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/([^\/?#:]*)/);
  if (match === null || match[1].length === 0) {
    return null;
  }
  return match[1].toLowerCase();
}

/** URLComponents(url:).queryItems — null when the URL carries no query. */
export function urlQueryItems(link: string): URLQueryItem[] | null {
  const queryStart: number = link.indexOf('?');
  if (queryStart < 0) {
    return null;
  }
  let query: string = link.substring(queryStart + 1);
  const fragment: number = query.indexOf('#');
  if (fragment >= 0) {
    query = query.substring(0, fragment);
  }
  const items: URLQueryItem[] = [];
  for (const pair of query.split('&')) {
    if (pair.length === 0) {
      continue;
    }
    const eq: number = pair.indexOf('=');
    const rawName: string = eq < 0 ? pair : pair.substring(0, eq);
    const rawValue: string | null = eq < 0 ? null : pair.substring(eq + 1);
    items.push(new URLQueryItem(safeDecode(rawName), rawValue === null ? null : safeDecode(rawValue)));
  }
  return items;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch (e) {
    return text;
  }
}

/** [URLQueryItem].value(for:) */
export function queryValue(queryItems: URLQueryItem[], name: string): string | null {
  for (const item of queryItems) {
    if (item.name === name) {
      return item.value;
    }
  }
  return null;
}

/** [URLQueryItem].base64DecodedValue(for:) */
export function queryBase64DecodedValue(queryItems: URLQueryItem[], name: string): string | null {
  const base64String: string | null = queryValue(queryItems, name);
  if (base64String === null) {
    return null;
  }
  try {
    const data: Uint8Array = new util.Base64Helper().decodeSync(base64String);
    return util.TextDecoder.create('utf-8').decodeToString(data);
  } catch (e) {
    return null;
  }
}

function toSPAuthError(e: Object, forSignup: boolean): SPAuthError {
  if (e instanceof SPAuthError) {
    return e as SPAuthError;
  }
  if (e instanceof RemoteError) {
    const remoteError: RemoteError = e as RemoteError;
    return forSignup ? SPAuthError.fromSignupRemoteError(remoteError) : SPAuthError.fromLoginRemoteError(remoteError);
  }
  return new SPAuthError(SPAuthErrorKind.UNKNOWN, 0, null, e instanceof Error ? e as Error : null);
}

// MARK: - SPAuthHandler

export class SPAuthHandler {
  /** Simperium Authenticator */
  private readonly simperiumService: SPAuthenticator;

  constructor(simperiumService: SPAuthenticator) {
    this.simperiumService = simperiumService;
  }

  /** Authenticates against the Simperium Backend. Errors are mapped into SPAuthError instances. */
  loginWithCredentials(username: string, password: string, onCompletion: (error: SPAuthError | null) => void): void {
    this.simperiumService.authenticateWithUsername(username, password, () => {
      onCompletion(null);
    }, (statusCode: number, response: string | null, error: Error | null) => {
      onCompletion(SPAuthError.fromLoginErrorCode(statusCode, response, error));
    });
  }

  /** Validates a set of credentials, before presenting the Reset Password UI. */
  validateWithCredentials(username: string, password: string, onCompletion: (error: SPAuthError | null) => void): void {
    this.simperiumService.validateWithUsername(username, password, () => {
      onCompletion(null);
    }, (statusCode: number, response: string | null, error: Error | null) => {
      onCompletion(SPAuthError.fromLoginErrorCode(statusCode, response, error));
    });
  }

  /** Requests an Authentication Email. Throws SPAuthError. */
  async requestLoginEmail(username: string): Promise<void> {
    const remote: LoginRemote = new LoginRemote();
    try {
      await remote.requestLoginEmail(username);
    } catch (e) {
      throw toSPAuthError(e as Object, false);
    }
  }

  /** Logs the User in with an Authentication Code. Throws SPAuthError. */
  async loginWithCode(username: string, code: string): Promise<void> {
    const remote: LoginRemote = new LoginRemote();
    let confirmation: LoginConfirmationResponse;
    try {
      confirmation = await remote.requestLoginConfirmation(username, code.toUpperCase());
    } catch (e) {
      throw toSPAuthError(e as Object, false);
    }
    this.simperiumService.authenticateWithUsernameAndToken(confirmation.username, confirmation.syncToken);
  }

  /** Registers a new user in the Simperium Backend. Errors are mapped into SPAuthError instances. */
  signupWithCredentials(username: string, onCompletion: (error: SPAuthError | null) => void): void {
    new SignupRemote().requestSignup(username, (result: RemoteResult) => {
      if (result.error === null) {
        onCompletion(null);
      } else {
        onCompletion(SPAuthError.fromSignupRemoteError(result.error));
      }
    });
  }

  /** The Password Reset (Web) URL for a username (null when it cannot be built). */
  passwordResetURL(username: string): string {
    return SIMPERIUM_FORGOT_PASSWORD_URL + '?email=' + encodeURIComponent(username);
  }

  /** Presents the Password Reset (Web) Interface via `presenter` (the in-app sheet, SFSafariViewController's
   * role); the system browser when there is no presenter. */
  presentPasswordReset(context: common.UIAbilityContext, username: string,
    presenter: ((url: string) => void) | null = null): Promise<void> {
    const url: string = this.passwordResetURL(username);
    if (presenter !== null) {
      presenter(url);
      return Promise.resolve();
    }
    return context.openLink(url);
  }
}

// MARK: - MagicLinkAuthenticator

class AllowedHosts {
  static readonly HOST_FOR_SIMPLENOTE_SCHEMA: string = 'login';
  static readonly HOST_FOR_UNIVERSAL_LINKS: string | null = urlHost(SPCredentials.DEFAULT_ENGINE_URL);

  static contains(host: string | null): boolean {
    return host !== null &&
      (host === AllowedHosts.HOST_FOR_SIMPLENOTE_SCHEMA || host === AllowedHosts.HOST_FOR_UNIVERSAL_LINKS);
  }
}

class MagicLinkConstants {
  static readonly EMAIL_FIELD: string = 'email';
  static readonly TOKEN_FIELD: string = 'token';
  static readonly AUTH_CODE_FIELD: string = 'auth_code';
}

export class MagicLinkAuthenticator {
  readonly authenticator: SPAuthenticator;

  constructor(authenticator: SPAuthenticator) {
    this.authenticator = authenticator;
  }

  handle(url: string): boolean {
    if (!AllowedHosts.contains(urlHost(url))) {
      return false;
    }
    const queryItems: URLQueryItem[] | null = urlQueryItems(url);
    if (queryItems === null) {
      return false;
    }
    if (this.attemptLoginWithToken(queryItems)) {
      return true;
    }
    return this.attemptLoginWithAuthCode(queryItems);
  }

  attemptLoginWithToken(queryItems: URLQueryItem[]): boolean {
    const email: string | null = queryBase64DecodedValue(queryItems, MagicLinkConstants.EMAIL_FIELD);
    const token: string | null = queryValue(queryItems, MagicLinkConstants.TOKEN_FIELD);
    if (email === null || token === null || email.length === 0 || token.length === 0) {
      return false;
    }
    this.authenticator.authenticateWithUsernameAndToken(email, token);
    return true;
  }

  attemptLoginWithAuthCode(queryItems: URLQueryItem[]): boolean {
    const email: string | null = queryBase64DecodedValue(queryItems, MagicLinkConstants.EMAIL_FIELD);
    const authCode: string | null = queryValue(queryItems, MagicLinkConstants.AUTH_CODE_FIELD);
    if (email === null || authCode === null || email.length === 0 || authCode.length === 0) {
      return false;
    }

    hilog.info(DOMAIN, LOG_TAG, '[MagicLinkAuthenticator] Requesting SyncToken');
    emitter.emit(MagicLinkEvent.MAGIC_LINK_AUTH_WILL_START);

    new LoginRemote().requestLoginConfirmation(email, authCode).then((confirmation: LoginConfirmationResponse) => {
      this.authenticator.authenticateWithUsernameAndToken(confirmation.username, confirmation.syncToken);
      emitter.emit(MagicLinkEvent.MAGIC_LINK_AUTH_DID_SUCCEED);
    }).catch((e: Object) => {
      hilog.error(DOMAIN, LOG_TAG, '[MagicLinkAuthenticator] Magic Link TokenExchange Error: %{public}s',
        JSON.stringify(e));
      const message: string = e instanceof Error ? (e as Error).message : String(e);
      const data: emitter.EventData = { data: { 'error': message } };
      emitter.emit(MagicLinkEvent.MAGIC_LINK_AUTH_DID_FAIL, data);
    });
    return true;
  }
}

// MARK: - WPAuthHandler (WordPress.com OAuth)

const SP_AUTH_SESSION_KEY: string = 'SPAuthSessionKey';
const SP_USERNAME_KEY: string = 'SPUsername';

export class WPAuthHandler {
  static isWPAuthenticationUrl(url: string): boolean {
    return urlHost(url) === 'auth';
  }

  /** The OAuth authorize URL; stores the session state it carries. */
  static wordPressSSOURL(): string {
    const sessionState: string = 'app-' + util.generateRandomUUID(false).toUpperCase();
    UserDefaults.standard.set(SP_AUTH_SESSION_KEY, sessionState);
    return WORDPRESS_AUTH_URL_BASE +
      '&client_id=' + encodeURIComponent(WPCOM_CLIENT_ID) +
      '&redirect_uri=' + encodeURIComponent(WPCOM_REDIRECT_URL) +
      '&state=' + encodeURIComponent(sessionState);
  }

  /**
   * +presentWordPressSSOFromViewController: hands the WordPress.com OAuth URL to `presenter` (the in-app
   * sheet, SFSafariViewController's role); the system browser when there is no presenter.
   */
  static presentWordPressSSOFromViewController(context: common.UIAbilityContext,
    presenter: ((url: string) => void) | null = null): Promise<void> {
    const url: string = WPAuthHandler.wordPressSSOURL();
    SPTracker.trackWPCCButtonPressed();
    if (presenter !== null) {
      presenter(url);
      return Promise.resolve();
    }
    return context.openLink(url);
  }

  static authorizeSimplenoteUserFromUrl(url: string | null, appId: string | null): SPUser | null {
    if (url === null || appId === null) {
      return null;
    }
    const queryItems: URLQueryItem[] = urlQueryItems(url) ?? [];
    const state: string | null = WPAuthHandler.valueForKey('state', queryItems);
    const user: string | null = WPAuthHandler.valueForKey('user', queryItems);
    const token: string | null = WPAuthHandler.valueForKey('token', queryItems);
    const wpcomToken: string | null = WPAuthHandler.valueForKey('wp_token', queryItems);
    const errorCode: string | null = WPAuthHandler.valueForKey('code', queryItems);

    if (state === null || user === null || token === null) {
      if (errorCode === '1') {
        WPAuthHandler.postSignInError('Please activate your WordPress.com account via email and try again.');
      } else {
        WPAuthHandler.postSignInError(null);
      }
      SPTracker.trackWPCCLoginFailed();
      return null;
    }

    const defaults: UserDefaults = UserDefaults.standard;
    const storedState: string | null = defaults.string(SP_AUTH_SESSION_KEY);
    if (state !== storedState) {
      // States don't match!
      WPAuthHandler.postSignInError(null);
      SPTracker.trackWPCCLoginFailed();
      return null;
    }

    defaults.removeObject(SP_AUTH_SESSION_KEY);
    defaults.set(SP_USERNAME_KEY, user);
    if (!SPKeychain.setPassword(token, appId, user)) {
      WPAuthHandler.postSignInError(null);
      SPTracker.trackWPCCLoginFailed();
      return null;
    }

    // Store wpcom token for future integrations (the source stores `token`, verbatim)
    if (wpcomToken !== null) {
      SPKeychain.setPassword(token, SIMPLENOTE_WP_SERVICE_NAME, user);
    }
    return new SPUser(user, token);
  }

  static valueForKey(key: string, queryItems: URLQueryItem[]): string | null {
    return queryValue(queryItems, key);
  }

  private static postSignInError(message: string | null): void {
    if (message === null) {
      emitter.emit(SIGN_IN_ERROR_NOTIFICATION_NAME);
      return;
    }
    const data: emitter.EventData = { data: { 'message': message } };
    emitter.emit(SIGN_IN_ERROR_NOTIFICATION_NAME, data);
  }
}
