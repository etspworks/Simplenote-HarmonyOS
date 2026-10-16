// Port of SimplenoteEndpoints-Swift: Endpoints/AccountRemote.swift, Interfaces/UserProtocol.swift
import { util } from '@kit.ArkTS';
import {
  EndpointConstants,
  Remote,
  RemoteCompletion,
  RemoteRequest,
  REMOTE_METHOD_GET,
  REMOTE_METHOD_POST,
  REMOTE_TIMEOUT
} from './Remote';

/// The signed-in user (SPUser conforms in the app)
export interface UserProtocol {
  email: string;
  authToken: string;
}

export class AccountRemote extends Remote {

  /// Send verification request for specified email address
  verify(email: string, completion: RemoteCompletion): void {
    const request: RemoteRequest = this.verificationURLRequest(email);
    this.performDataTaskWithCompletion(request, completion);
  }

  /// Send account deletion request for user
  requestDelete(user: UserProtocol, completion: RemoteCompletion): void {
    const request: RemoteRequest = this.deleteRequest(user);
    this.performDataTaskWithCompletion(request, completion);
  }

  private verificationURLRequest(email: string): RemoteRequest {
    const utf8: Uint8Array = new util.TextEncoder().encodeInto(email);
    const base64EncodedEmail: string = new util.Base64Helper().encodeToStringSync(utf8);
    const url: string = EndpointConstants.simplenoteVerificationURL() + '/' + base64EncodedEmail;

    const request: RemoteRequest = new RemoteRequest(url, REMOTE_TIMEOUT);
    request.httpMethod = REMOTE_METHOD_GET;
    return request;
  }

  private deleteRequest(user: UserProtocol): RemoteRequest {
    const request: RemoteRequest = new RemoteRequest(EndpointConstants.accountDeletionURL(), REMOTE_TIMEOUT);
    request.httpMethod = REMOTE_METHOD_POST;
    request.setValue('application/json', 'Content-Type');

    const body: Record<string, string> = {
      'username': user.email.toLowerCase(),
      'token': user.authToken
    };
    request.httpBody = JSON.stringify(body);
    return request;
  }
}
