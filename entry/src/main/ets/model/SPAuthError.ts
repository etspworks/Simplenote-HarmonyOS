// Port of SPAuthError.swift: authentication / signup failures and their alert title + message.
// Swift's enum with an associated `unknown(statusCode:response:error:)` case becomes a class
// holding a kind plus the unknown case's payload.

export enum SPAuthErrorKind {
  LOGIN_BAD_CREDENTIALS = 0,
  SIGNUP_BAD_CREDENTIALS = 1,
  SIGNUP_USER_ALREADY_EXISTS = 2,
  NETWORK = 3,
  COMPROMISED_PASSWORD = 4,
  UNVERIFIED_EMAIL = 5,
  TOO_MANY_ATTEMPTS = 6,
  GENERIC = 7,
  REQUEST_NOT_FOUND = 8,
  INVALID_CODE = 9,
  UNKNOWN = 10
}

/** The fields of SimplenoteEndpoints' RemoteError that SPAuthError reads. */
export interface SPRemoteErrorFields {
  statusCode: number;
  response?: string | null;
  networkError?: Error | null;
}

export class SPAuthError extends Error {
  // Private Constants
  static readonly COMPROMISED_PASSWORD: string = 'compromised password';
  static readonly REQUIRES_VERIFICATION: string = 'verification required';
  static readonly REQUEST_NOT_FOUND: string = 'request-not-found';
  static readonly INVALID_CODE: string = 'invalid-code';

  kind: SPAuthErrorKind;
  statusCode: number;
  response: string | null;
  error: Error | null;

  constructor(kind: SPAuthErrorKind, statusCode: number = 0, response: string | null = null,
    error: Error | null = null) {
    super('SPAuthError');
    this.kind = kind;
    this.statusCode = statusCode;
    this.response = response;
    this.error = error;
    this.message = this.localizedMessage();
  }

  /** init(loginRemoteError:) */
  static fromLoginRemoteError(remoteError: SPRemoteErrorFields): SPAuthError {
    return SPAuthError.fromLoginErrorCode(remoteError.statusCode, remoteError.response ?? null,
      remoteError.networkError ?? null);
  }

  /** init(signupRemoteError:) */
  static fromSignupRemoteError(remoteError: SPRemoteErrorFields): SPAuthError {
    return SPAuthError.fromSignupErrorCode(remoteError.statusCode, remoteError.response ?? null,
      remoteError.networkError ?? null);
  }

  /** init(loginErrorCode:response:error:) — the Simperium login error mapping */
  static fromLoginErrorCode(loginErrorCode: number, response: string | null, error: Error | null): SPAuthError {
    if (loginErrorCode === 0) {
      return new SPAuthError(SPAuthErrorKind.NETWORK);
    }
    if (loginErrorCode === 400 && response === SPAuthError.REQUEST_NOT_FOUND) {
      return new SPAuthError(SPAuthErrorKind.REQUEST_NOT_FOUND);
    }
    if (loginErrorCode === 400 && response === SPAuthError.INVALID_CODE) {
      return new SPAuthError(SPAuthErrorKind.INVALID_CODE);
    }
    if (loginErrorCode === 401 && response === SPAuthError.COMPROMISED_PASSWORD) {
      return new SPAuthError(SPAuthErrorKind.COMPROMISED_PASSWORD);
    }
    if (loginErrorCode === 401) {
      return new SPAuthError(SPAuthErrorKind.LOGIN_BAD_CREDENTIALS);
    }
    if (loginErrorCode === 403 && response === SPAuthError.REQUIRES_VERIFICATION) {
      return new SPAuthError(SPAuthErrorKind.UNVERIFIED_EMAIL);
    }
    if (loginErrorCode === 429) {
      return new SPAuthError(SPAuthErrorKind.TOO_MANY_ATTEMPTS);
    }
    return new SPAuthError(SPAuthErrorKind.UNKNOWN, loginErrorCode, response, error);
  }

  /** init(signupErrorCode:response:error:) */
  static fromSignupErrorCode(signupErrorCode: number, response: string | null, error: Error | null): SPAuthError {
    switch (signupErrorCode) {
      case 0:
        return new SPAuthError(SPAuthErrorKind.NETWORK);
      case 401:
        return new SPAuthError(SPAuthErrorKind.SIGNUP_BAD_CREDENTIALS);
      case 409:
        return new SPAuthError(SPAuthErrorKind.SIGNUP_USER_ALREADY_EXISTS);
      case 429:
        return new SPAuthError(SPAuthErrorKind.TOO_MANY_ATTEMPTS);
      default:
        return new SPAuthError(SPAuthErrorKind.UNKNOWN, signupErrorCode, response, error);
    }
  }

  /** Returns the Error Title, for Alert purposes */
  get title(): string {
    switch (this.kind) {
      case SPAuthErrorKind.SIGNUP_USER_ALREADY_EXISTS:
        return 'Email in use';
      case SPAuthErrorKind.COMPROMISED_PASSWORD:
        return 'Compromised Password';
      case SPAuthErrorKind.UNVERIFIED_EMAIL:
        return 'Account Verification Required';
      case SPAuthErrorKind.TOO_MANY_ATTEMPTS:
        return 'Too Many Login Attempts';
      default:
        return 'Sorry!';
    }
  }

  /** Returns the Error Message, for Alert purposes (Swift's `message`) */
  localizedMessage(): string {
    switch (this.kind) {
      case SPAuthErrorKind.LOGIN_BAD_CREDENTIALS:
        return 'Could not login with the provided email address and password.';
      case SPAuthErrorKind.SIGNUP_BAD_CREDENTIALS:
        return 'Could not create an account with the provided email address and password.';
      case SPAuthErrorKind.SIGNUP_USER_ALREADY_EXISTS:
        return 'The email you\'ve entered is already associated with a Simplenote account.';
      case SPAuthErrorKind.NETWORK:
        return 'The network could not be reached.';
      case SPAuthErrorKind.COMPROMISED_PASSWORD:
        return 'This password has appeared in a data breach, which puts your account at high risk of compromise. ' +
          'To protect your data, you\'ll need to update your password before being able to log in again.';
      case SPAuthErrorKind.UNVERIFIED_EMAIL:
        return 'You must verify your email before being able to login.';
      case SPAuthErrorKind.TOO_MANY_ATTEMPTS:
        return 'Too many login attempts. Try again later.';
      case SPAuthErrorKind.REQUEST_NOT_FOUND:
        return 'Your authentication code has expired. Please request a new one';
      case SPAuthErrorKind.INVALID_CODE:
        return 'The code you\'ve entered is not correct. Please try again';
      default:
        return 'We\'re having problems. Please try again soon.';
    }
  }
}
