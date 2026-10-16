// Port of SPAuthenticator.h/.m, NSURLRequest+Simperium.m and SPKeychain (SSKeychain):
// username/password login and signup against auth.simperium.com, token persistence (the
// keychain becomes @kit.AssetStoreKit; the username stays in UserDefaults as "SPUsername").
import { http, connection } from '@kit.NetworkKit';
import { asset } from '@kit.AssetStoreKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { UserDefaults } from '../Database';
import { SPUser } from '../../model/SPUser';
import { SP_AUTH_URL } from './WebSocketChannel';

const SP_USERNAME: string = 'SPUsername';

export type SuccessBlockType = () => void;
export type FailureBlockType = (responseCode: number, responseString: string | null, error: Error | null) => void;

export interface SPAuthenticatorDelegate {
  authenticationDidSucceedForUsername?: (username: string, token: string) => void;
  authenticationDidCreateAccount?: () => void;
  authenticationDidFail?: () => void;
  authenticationDidCancel?: () => void;
}

/** What the authenticator reads from / writes to Simperium. */
export interface SPAuthenticatorSimperium {
  readonly appID: string | null;
  readonly APIKey: string | null;
  user: SPUser | null;
}

// MARK: - SPKeychain over AssetStoreKit

export class SPKeychain {
  private static bytes(text: string): Uint8Array {
    return util.TextEncoder.create('utf-8').encodeInto(text);
  }

  private static alias(service: string, account: string): Uint8Array {
    return SPKeychain.bytes(`${service}:${account}`);
  }

  // Index of stored aliases: asset_service logs a system ERROR on every query/remove of a
  // missing alias, so only aliases known to be stored are ever queried or removed.
  private static readonly INDEX_KEY: string = 'SPKeychainAliases';

  private static readIndex(): string[] | null {
    const raw = UserDefaults.standard.string(SPKeychain.INDEX_KEY);
    if (raw === null) {
      return null;
    }
    try {
      return JSON.parse(raw) as string[];
    } catch (e) {
      return [];
    }
  }

  private static writeIndex(key: string, present: boolean): void {
    const index: string[] = (SPKeychain.readIndex() ?? []).filter((k: string) => k !== key);
    if (present) {
      index.push(key);
    }
    UserDefaults.standard.set(SPKeychain.INDEX_KEY, JSON.stringify(index));
  }

  private static isStored(service: string, account: string): boolean {
    const key = `${service}:${account}`;
    const index = SPKeychain.readIndex();
    if (index !== null) {
      return index.includes(key);
    }
    // Pre-index install: only the sign-in token (account == SPUsername) may exist.
    return UserDefaults.standard.string(SP_USERNAME) === account;
  }

  static passwordForService(service: string, account: string): string | null {
    if (!SPKeychain.isStored(service, account)) {
      return null;
    }
    const query: asset.AssetMap = new Map<asset.Tag, asset.Value>();
    query.set(asset.Tag.ALIAS, SPKeychain.alias(service, account));
    query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
    try {
      const results = asset.querySync(query);
      if (results.length === 0) {
        return null;
      }
      const secret = results[0].get(asset.Tag.SECRET);
      if (secret instanceof Uint8Array) {
        SPKeychain.writeIndex(`${service}:${account}`, true);
        return util.TextDecoder.create('utf-8').decodeToString(secret as Uint8Array);
      }
      return null;
    } catch (e) {
      const err = e as BusinessError;
      if (err.code !== asset.ErrorCode.NOT_FOUND) {
        console.error(`Simperium couldn't retrieve token from keychain. Error: ${err.message}`);
      }
      return null;
    }
  }

  static setPassword(password: string, service: string, account: string): boolean {
    SPKeychain.deletePasswordForService(service, account);
    const attributes: asset.AssetMap = new Map<asset.Tag, asset.Value>();
    attributes.set(asset.Tag.ALIAS, SPKeychain.alias(service, account));
    attributes.set(asset.Tag.SECRET, SPKeychain.bytes(password));
    // kSecAttrAccessibleAlways
    attributes.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_POWERED_ON);
    try {
      try {
        asset.addSync(attributes);
      } catch (e) {
        if ((e as BusinessError).code !== asset.ErrorCode.DUPLICATED) {
          throw e as Error;
        }
        // An unindexed (pre-index) item exists: overwrite it.
        const query: asset.AssetMap = new Map<asset.Tag, asset.Value>();
        query.set(asset.Tag.ALIAS, SPKeychain.alias(service, account));
        const update: asset.AssetMap = new Map<asset.Tag, asset.Value>();
        update.set(asset.Tag.SECRET, SPKeychain.bytes(password));
        asset.updateSync(query, update);
      }
      SPKeychain.writeIndex(`${service}:${account}`, true);
      return true;
    } catch (e) {
      console.error(`Simperium couldn't store token in the keychain. Error: ${(e as BusinessError).message}`);
      return false;
    }
  }

  static deletePasswordForService(service: string, account: string): void {
    if (!SPKeychain.isStored(service, account)) {
      return;
    }
    const query: asset.AssetMap = new Map<asset.Tag, asset.Value>();
    query.set(asset.Tag.ALIAS, SPKeychain.alias(service, account));
    try {
      asset.removeSync(query);
    } catch (e) {
      // NOT_FOUND: nothing to delete
    }
    SPKeychain.writeIndex(`${service}:${account}`, false);
  }
}

class SPHTTPResult {
  statusCode: number;
  responseString: string | null;
  error: Error | null;

  constructor(statusCode: number, responseString: string | null, error: Error | null) {
    this.statusCode = statusCode;
    this.responseString = responseString;
    this.error = error;
  }
}

// MARK: - SPAuthenticator

export class SPAuthenticator {
  authURL: string = SP_AUTH_URL;
  customHTTPHeaders: Record<string, string> = {};
  providerString: string | null = null;
  private delegate: SPAuthenticatorDelegate;
  private simperium: SPAuthenticatorSimperium;

  /// SPAuthenticator.connected: SPReachability currentReachabilityStatus != NotReachable.
  /// Fails open so a probe error never blocks an online user.
  get connected(): boolean {
    try {
      return connection.hasDefaultNetSync();
    } catch (e) {
      return true;
    }
  }

  constructor(delegate: SPAuthenticatorDelegate, simperium: SPAuthenticatorSimperium) {
    this.delegate = delegate;
    this.simperium = simperium;
  }

  /** Returns true when the user must authenticate (no stored credentials). */
  authenticateIfNecessary(): boolean {
    const appID = this.simperium.appID ?? '';
    const username = UserDefaults.standard.string(SP_USERNAME);
    let token: string | null = null;
    if (username !== null) {
      token = SPKeychain.passwordForService(appID, username);
    }

    if (username === null || username.length === 0 || token === null || token.length === 0) {
      console.info(`Simperium didn't find an existing auth token (appID: ${appID})`);
      if (this.delegate.authenticationDidFail !== undefined) {
        this.delegate.authenticationDidFail();
      }
      return true;
    }

    console.info(`Simperium found an existing auth token for ${username}`);
    this.simperium.user = new SPUser(username, token);
    if (this.delegate.authenticationDidSucceedForUsername !== undefined) {
      this.delegate.authenticationDidSucceedForUsername(username, token);
    }
    return false;
  }

  // MARK: Authentication

  authenticateWithUsernameAndToken(username: string, token: string): void {
    const user = new SPUser(username, token);
    this.simperium.user = user;
    this.saveCredentialsForUser(user);
    this.notifySignupDidSucceed();
    this.notifyAuthenticationDidSucceed();
  }

  authenticateWithUsername(username: string, password: string, successHandler: SuccessBlockType,
    failureHandler: FailureBlockType): void {
    const url = `${this.authURL}${this.simperium.appID ?? ''}/authorize/`;
    this.performRequest(url, username, password).then((result: SPHTTPResult) => {
      if (!this.processAuthenticationResponse(result.responseString, result.statusCode)) {
        console.error(`Simperium authentication error (${result.statusCode})`);
        failureHandler(result.statusCode, result.responseString, result.error);
        this.notifyAuthenticationDidFail();
        return;
      }
      successHandler();
      this.notifyAuthenticationDidSucceed();
    });
  }

  // MARK: Validation

  validateWithUsername(username: string, password: string, successHandler: SuccessBlockType,
    failureHandler: FailureBlockType): void {
    const url = `${this.authURL}${this.simperium.appID ?? ''}/authorize/`;
    this.performRequest(url, username, password).then((result: SPHTTPResult) => {
      const user = SPUser.parseUserFromResponseString(result.responseString);
      if (user === null || !user.authenticated()) {
        console.error(`Simperium account validation error (${result.statusCode})`);
        failureHandler(result.statusCode, result.responseString, result.error);
        return;
      }
      successHandler();
    });
  }

  // MARK: Signup

  signupWithUsername(username: string, password: string, successHandler: SuccessBlockType,
    failureHandler: FailureBlockType): void {
    const url = `${this.authURL}${this.simperium.appID ?? ''}/create/`;
    this.performRequest(url, username, password).then((result: SPHTTPResult) => {
      if (!this.processAuthenticationResponse(result.responseString, result.statusCode)) {
        console.error(`Simperium signup error (${result.statusCode})`);
        failureHandler(result.statusCode, result.responseString, result.error);
        this.notifyAuthenticationDidFail();
        return;
      }
      successHandler();
      this.notifySignupDidSucceed();
      this.notifyAuthenticationDidSucceed();
    });
  }

  // MARK: Request (NSURLRequest+Simperium, NSURLSession+Simperium)

  private async performRequest(url: string, username: string, password: string): Promise<SPHTTPResult> {
    const body: Record<string, string> = {
      'username': username,
      'password': password,
      'provider': this.providerString ?? ''
    };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Simperium-API-Key': this.simperium.APIKey ?? ''
    };
    for (const key of Object.keys(this.customHTTPHeaders)) {
      headers[key] = this.customHTTPHeaders[key];
    }
    const httpRequest = http.createHttp();
    try {
      const response = await httpRequest.request(url, {
        method: http.RequestMethod.POST,
        header: headers,
        extraData: JSON.stringify(body),
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: 30000,
        readTimeout: 30000
      });
      const text = typeof response.result === 'string' ? response.result as string : JSON.stringify(response.result);
      return new SPHTTPResult(response.responseCode as number, text, null);
    } catch (e) {
      // Status 0: the network could not be reached
      return new SPHTTPResult(0, null, new Error((e as BusinessError).message));
    } finally {
      httpRequest.destroy();
    }
  }

  // MARK: Response Parsing

  private processAuthenticationResponse(responseString: string | null, statusCode: number): boolean {
    if (statusCode >= 400 || statusCode === 0) {
      return false;
    }
    const user = SPUser.parseUserFromResponseString(responseString);
    if (user === null) {
      return false;
    }
    this.saveCredentialsForUser(user);
    this.simperium.user = user;
    return true;
  }

  // MARK: Keychain Helpers

  private saveCredentialsForUser(user: SPUser): void {
    UserDefaults.standard.set(SP_USERNAME, user.email);
    if (user.authToken !== null) {
      SPKeychain.setPassword(user.authToken, this.simperium.appID ?? '', user.email ?? '');
    }
  }

  // MARK: Delegate Wrappers

  private notifyAuthenticationDidSucceed(): void {
    const user = this.simperium.user;
    if (this.delegate.authenticationDidSucceedForUsername !== undefined && user !== null) {
      this.delegate.authenticationDidSucceedForUsername(user.email ?? '', user.authToken ?? '');
    }
  }

  private notifyAuthenticationDidFail(): void {
    if (this.delegate.authenticationDidFail !== undefined) {
      this.delegate.authenticationDidFail();
    }
  }

  private notifySignupDidSucceed(): void {
    if (this.delegate.authenticationDidCreateAccount !== undefined) {
      this.delegate.authenticationDidCreateAccount();
    }
  }

  // MARK: Public API

  reset(): void {
    let username = UserDefaults.standard.string(SP_USERNAME);
    if (username === null || username.length === 0) {
      username = this.simperium.user !== null ? this.simperium.user.email : null;
    }
    UserDefaults.standard.removeObject(SP_USERNAME);
    if (username !== null && username.length > 0) {
      SPKeychain.deletePasswordForService(this.simperium.appID ?? '', username);
    }
  }

  cancel(): void {
    if (this.delegate.authenticationDidCancel !== undefined) {
      this.delegate.authenticationDidCancel();
    }
  }
}
