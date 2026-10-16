// Port of SimplenoteEndpoints-Swift: Endpoints/LoginRemote.swift, Interfaces/LoginRemoteProtocol.swift
import { EndpointConstants, Remote, RemoteRequest, REMOTE_METHOD_POST } from './Remote';

// MARK: - LoginConfirmationResponse

export class LoginConfirmationResponse {
  username: string;
  syncToken: string;

  constructor(username: string, syncToken: string) {
    this.username = username;
    this.syncToken = syncToken;
  }

  equals(other: LoginConfirmationResponse): boolean {
    return this.username === other.username && this.syncToken === other.syncToken;
  }
}

/// Wire shape; JSONDecoder.keyDecodingStrategy = .convertFromSnakeCase maps `sync_token` -> syncToken
interface LoginConfirmationPayload {
  username?: string;
  sync_token?: string;
  syncToken?: string;
}

function decodeLoginConfirmation(data: string): LoginConfirmationResponse {
  const payload: LoginConfirmationPayload = JSON.parse(data) as LoginConfirmationPayload;
  const username: string | undefined = payload.username;
  const syncToken: string | undefined = payload.sync_token ?? payload.syncToken;
  if (typeof username !== 'string' || typeof syncToken !== 'string') {
    throw new Error('LoginConfirmationResponse: keyNotFound (username / syncToken)');
  }
  const response: LoginConfirmationResponse = new LoginConfirmationResponse(username, syncToken);
  return response;
}

// MARK: - LoginRemoteProtocol

export interface LoginRemoteProtocol {
  requestLoginEmail(email: string): Promise<void>;
  requestLoginConfirmation(email: string, authCode: string): Promise<LoginConfirmationResponse>;
}

// MARK: - LoginRemote

export class LoginRemote extends Remote implements LoginRemoteProtocol {

  async requestLoginEmail(email: string): Promise<void> {
    const request: RemoteRequest = this.requestForLoginRequest(email);
    await this.performDataTask(request);
  }

  async requestLoginConfirmation(email: string, authCode: string): Promise<LoginConfirmationResponse> {
    const request: RemoteRequest = this.requestForLoginCompletion(email, authCode);
    const data: string = await this.performDataTask(request);
    return decodeLoginConfirmation(data);
  }

  private requestForLoginRequest(email: string): RemoteRequest {
    const body: Record<string, string> = {
      'request_source': EndpointConstants.platform(),
      'username': email.toLowerCase()
    };
    return this.requestForURL(EndpointConstants.loginRequestURL(), REMOTE_METHOD_POST, body);
  }

  private requestForLoginCompletion(email: string, authCode: string): RemoteRequest {
    const body: Record<string, string> = {
      'auth_code': authCode,
      'username': email
    };
    return this.requestForURL(EndpointConstants.loginCompletionURL(), REMOTE_METHOD_POST, body);
  }
}
