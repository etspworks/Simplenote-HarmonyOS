// Port of SimplenoteEndpoints-Swift: Tools/Remote.swift, Tools/RemoteConstants.swift,
// Endpoints/EndpointConstants.swift, Interfaces/URLSessionProtocol.swift
// URLSession -> @kit.NetworkKit http (one HttpRequest per call, destroyed in finally).
import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { bundleManager } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { RemoteError } from './RemoteError';

const DOMAIN: number = 0x0001;
const LOG_TAG: string = 'Remote';

// MARK: - RemoteConstants

export const REMOTE_METHOD_GET: string = 'GET';
export const REMOTE_METHOD_POST: string = 'POST';
/// Seconds
export const REMOTE_TIMEOUT: number = 30;

// MARK: - EndpointConstants

export class EndpointConstants {
  static shared: EndpointConstants = new EndpointConstants();

  engineBaseURL: string = 'https://app.simplenote.com';
  // Source picks "iOS" / "macOS"; the HarmonyOS port identifies itself the same way the iOS build did.
  platformName: string = 'iOS';

  private static join(path: string): string {
    const base: string = EndpointConstants.shared.engineBaseURL.replace(new RegExp('/+$'), '');
    return base + path;
  }

  static platform(): string {
    return EndpointConstants.shared.platformName;
  }

  static loginRequestURL(): string {
    return EndpointConstants.join('/account/request-login');
  }

  static loginCompletionURL(): string {
    return EndpointConstants.join('/account/complete-login');
  }

  // NSString.appendingPathComponent drops the trailing slash
  static simplenoteVerificationURL(): string {
    return EndpointConstants.join('/account/verify-email');
  }

  static simplenoteRequestSignupURL(): string {
    return EndpointConstants.join('/account/request-signup');
  }

  static accountDeletionURL(): string {
    return EndpointConstants.join('/account/request-delete');
  }
}

// MARK: - URLRequest analogue

export class RemoteRequest {
  url: string;
  httpMethod: string = REMOTE_METHOD_GET;
  httpBody: string | null = null;
  headers: Map<string, string> = new Map<string, string>();
  /// Seconds
  timeoutInterval: number = REMOTE_TIMEOUT;

  constructor(url: string, timeoutInterval: number = REMOTE_TIMEOUT) {
    this.url = url;
    this.timeoutInterval = timeoutInterval;
  }

  setValue(value: string, field: string): void {
    this.headers.set(field, value);
  }
}

export class RemoteResponse {
  statusCode: number;
  data: string;

  constructor(statusCode: number, data: string) {
    this.statusCode = statusCode;
    this.data = data;
  }
}

/// Result<Data?, RemoteError>
export class RemoteResult {
  readonly data: string | null;
  readonly error: RemoteError | null;

  private constructor(data: string | null, error: RemoteError | null) {
    this.data = data;
    this.error = error;
  }

  static success(data: string | null): RemoteResult {
    return new RemoteResult(data, null);
  }

  static failure(error: RemoteError): RemoteResult {
    return new RemoteResult(null, error);
  }

  get isSuccess(): boolean {
    return this.error === null;
  }
}

export type RemoteCompletion = (result: RemoteResult) => void;

// MARK: - URLSessionProtocol

export interface RemoteSession {
  /// Throws the transport error; resolves with any HTTP status.
  data(request: RemoteRequest): Promise<RemoteResponse>;
}

export class HttpRemoteSession implements RemoteSession {
  static shared: HttpRemoteSession = new HttpRemoteSession();
  private static userAgent: string | null = null;

  /// URLSession sends 'Simplenote/<ver> CFNetwork/... Darwin/...' on iOS; NetworkKit http sends no app UA.
  /// ponytail: UA string unconfirmed against server rules (TC-AUTH-113 hypothesis); align it once the
  /// warn log in Remote shows what /account/request-signup actually refuses.
  private static defaultUserAgent(): string {
    if (HttpRemoteSession.userAgent === null) {
      let version: string = '';
      try {
        version = bundleManager.getBundleInfoForSelfSync(
          bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT).versionName;
      } catch (e) {
        hilog.error(DOMAIN, LOG_TAG, 'bundle version unavailable: %{public}s', JSON.stringify(e));
      }
      HttpRemoteSession.userAgent = (version === '' ? 'Simplenote' : 'Simplenote/' + version) + ' (HarmonyOS)';
    }
    return HttpRemoteSession.userAgent;
  }

  async data(request: RemoteRequest): Promise<RemoteResponse> {
    const httpRequest: http.HttpRequest = http.createHttp();
    try {
      const header: Record<string, string> = {};
      request.headers.forEach((value: string, key: string) => {
        header[key] = value;
      });
      if (!Object.keys(header).some((key: string) => key.toLowerCase() === 'user-agent')) {
        header['User-Agent'] = HttpRemoteSession.defaultUserAgent();
      }
      const options: http.HttpRequestOptions = {
        method: request.httpMethod === REMOTE_METHOD_POST ? http.RequestMethod.POST : http.RequestMethod.GET,
        header: header,
        expectDataType: http.HttpDataType.STRING,
        usingCache: false,
        connectTimeout: request.timeoutInterval * 1000,
        readTimeout: request.timeoutInterval * 1000
      };
      if (request.httpBody !== null) {
        options.extraData = request.httpBody;
      }
      const response: http.HttpResponse = await httpRequest.request(request.url, options);
      const body: string = typeof response.result === 'string' ? response.result as string : '';
      return new RemoteResponse(response.responseCode as number, body);
    } finally {
      httpRequest.destroy();
    }
  }
}

function toError(e: Object): Error {
  if (e instanceof Error) {
    return e;
  }
  const business: BusinessError = e as BusinessError;
  const err: Error = new Error(business.message ?? 'network error');
  return err;
}

// MARK: - Remote

export class Remote {
  private urlSession: RemoteSession;

  constructor(urlSession: RemoteSession = HttpRemoteSession.shared) {
    this.urlSession = urlSession;
  }

  /// Sends a task and reports through `completion` (network error / non-2xx -> failure).
  performDataTaskWithCompletion(request: RemoteRequest, completion: RemoteCompletion): void {
    this.urlSession.data(request).then((response: RemoteResponse) => {
      const error: RemoteError | null = Remote.errorFor(request, response.statusCode, response.data, null);
      if (error !== null) {
        completion(RemoteResult.failure(error));
        return;
      }
      completion(RemoteResult.success(response.data));
    }).catch((e: Object) => {
      const error: RemoteError | null = Remote.errorFor(request, null, null, toError(e));
      completion(RemoteResult.failure(error as RemoteError));
    });
  }

  /// Performs a data task; throws RemoteError for a non-2xx status, rethrows transport errors.
  async performDataTask(request: RemoteRequest): Promise<string> {
    const response: RemoteResponse = await this.urlSession.data(request);
    const error: RemoteError | null = Remote.errorFor(request, response.statusCode, response.data, null);
    if (error !== null) {
      throw error;
    }
    return response.data;
  }

  /// RemoteError.fromResponse, plus a warn log of path / status / response body whenever it fails, so the
  /// server's real refusal shows up in hilog. Path and body are private (verify-email embeds the base64 email):
  /// `hdc shell hilog -p off` reveals them on a debug device. Never logs the request body.
  private static errorFor(request: RemoteRequest, statusCode: number | null, responseData: string | null,
    networkError: Error | null): RemoteError | null {
    const error: RemoteError | null = RemoteError.fromResponse(statusCode, responseData, networkError);
    if (error !== null) {
      const path: string = request.url.replace(new RegExp('^[a-zA-Z]+://[^/]+'), '');
      const body: string = responseData ?? (networkError === null ? '' : networkError.message);
      hilog.warn(DOMAIN, LOG_TAG, 'HTTP %{public}d for %{private}s: %{private}s', error.statusCode, path, body);
    }
    return error;
  }

  /// Builds a request for the specified URL / Method / params (JSON body)
  requestForURL(url: string, method: string, httpBody: Record<string, string> | null): RemoteRequest {
    const request: RemoteRequest = new RemoteRequest(url, REMOTE_TIMEOUT);
    request.httpMethod = method;
    request.setValue('application/json', 'Content-Type');
    if (httpBody !== null) {
      request.httpBody = JSON.stringify(httpBody);
    }
    return request;
  }
}
