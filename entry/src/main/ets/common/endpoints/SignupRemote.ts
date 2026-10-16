// Port of SimplenoteEndpoints-Swift: Endpoints/SignupRemote.swift
import { EndpointConstants, Remote, RemoteCompletion, RemoteRequest, REMOTE_METHOD_POST, REMOTE_TIMEOUT } from './Remote';

export class SignupRemote extends Remote {

  /// Send signup request for specified email address
  requestSignup(email: string, completion: RemoteCompletion): void {
    const requestURL: RemoteRequest = this.request(email);
    this.performDataTaskWithCompletion(requestURL, completion);
  }

  private request(email: string): RemoteRequest {
    const request: RemoteRequest = new RemoteRequest(EndpointConstants.simplenoteRequestSignupURL(), REMOTE_TIMEOUT);
    request.httpMethod = REMOTE_METHOD_POST;
    request.setValue('application/json', 'Content-Type');
    const body: Record<string, string> = { 'username': email.toLowerCase() };
    request.httpBody = JSON.stringify(body);
    return request;
  }
}
