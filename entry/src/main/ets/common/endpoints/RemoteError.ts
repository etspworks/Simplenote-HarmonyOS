// Port of SimplenoteEndpoints-Swift: Tools/RemoteError.swift

export class RemoteError extends Error {
  readonly statusCode: number;
  readonly response: string | null;
  readonly networkError: Error | null;

  constructor(statusCode: number, response: string | null, networkError: Error | null) {
    super(`RemoteError ${statusCode}${response !== null ? ': ' + response : ''}`);
    this.name = 'RemoteError';
    this.statusCode = statusCode;
    this.response = response;
    this.networkError = networkError;
  }

  /// Failable init: returns null for any 2xx status code; otherwise wraps the `{"error": ...}` body.
  static fromResponse(statusCode: number | null, responseData: string | null = null,
    networkError: Error | null = null): RemoteError | null {
    if (statusCode !== null && Math.trunc(statusCode / 100) === 2) {
      return null;
    }
    const response: ReponseErrorContainer | null = ReponseErrorContainer.decode(responseData);
    return new RemoteError(statusCode ?? 0, response === null ? null : response.error, networkError);
  }

  /// Equatable (==)
  equals(other: RemoteError): boolean {
    const lhsMessage: string | null = this.networkError === null ? null : this.networkError.message;
    const rhsMessage: string | null = other.networkError === null ? null : other.networkError.message;
    return this.statusCode === other.statusCode && this.response === other.response && lhsMessage === rhsMessage;
  }
}

interface ReponseErrorBody {
  error?: string;
}

class ReponseErrorContainer {
  readonly error: string;

  constructor(error: string) {
    this.error = error;
  }

  static decode(body: string | null): ReponseErrorContainer | null {
    if (body === null || body.length === 0) {
      return null;
    }
    try {
      const decoded: ReponseErrorBody = JSON.parse(body) as ReponseErrorBody;
      if (decoded === null || typeof decoded.error !== 'string') {
        return null;
      }
      return new ReponseErrorContainer(decoded.error);
    } catch (e) {
      return null;
    }
  }
}
