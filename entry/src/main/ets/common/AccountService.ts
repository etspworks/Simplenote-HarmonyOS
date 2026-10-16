// Port of Verification/AccountVerificationController.swift and
// Controllers/AccountDeletionController.swift (+ Date+Simplenote.swift's increased(byDays:)).
import { AccountRemote, UserProtocol } from './endpoints/AccountRemote';
import { RemoteCompletion, RemoteResult } from './endpoints/Remote';
import { SPDict } from './simperium/JsonDiff';
import { EmailVerification } from '../model/EmailVerification';
import { SPUser } from '../model/SPUser';

/** Date.increased(byHours:) */
export function dateIncreasedByHours(date: Date, hours: number): Date {
  const result: Date = new Date(date.getTime());
  result.setHours(result.getHours() + hours);
  return result;
}

/** Date.increased(byDays:) — calendar days, as Calendar.current.date(byAdding:) */
export function dateIncreasedByDays(date: Date, days: number): Date {
  const result: Date = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

// MARK: - AccountVerificationController

/** Possible verification states */
export enum AccountVerificationState {
  UNKNOWN = 0,
  UNVERIFIED = 1,
  VERIFICATION_IN_PROGRESS = 2,
  VERIFIED = 3
}

export type AccountVerificationStateChange =
  (oldState: AccountVerificationState, state: AccountVerificationState) => void;

export class AccountVerificationController {
  private stateValue: AccountVerificationState = AccountVerificationState.UNKNOWN;

  /** User's email */
  readonly email: string;

  /** Callback is invoked when state changes */
  onStateChange: AccountVerificationStateChange | null = null;

  /** Remote service */
  private readonly remote: AccountRemote;

  constructor(email: string, remote: AccountRemote = new AccountRemote()) {
    this.email = email;
    this.remote = remote;
  }

  /** Current verification state */
  get state(): AccountVerificationState {
    return this.stateValue;
  }

  private setState(state: AccountVerificationState): void {
    const oldValue: AccountVerificationState = this.stateValue;
    this.stateValue = state;
    if (oldValue === state) {
      return;
    }
    if (this.onStateChange !== null) {
      this.onStateChange(oldValue, state);
    }
  }

  /** Update verification state with data from the `email-verification` entity */
  update(rawData: SPDict | null | undefined): void {
    if (this.email.length === 0) {
      return;
    }
    if (rawData === null || rawData === undefined) {
      this.setState(AccountVerificationState.UNVERIFIED);
      return;
    }

    const emailVerification: EmailVerification = EmailVerification.fromPayload(rawData);
    if (emailVerification.token !== null &&
      emailVerification.token.username.toLowerCase() === this.email.toLowerCase()) {
      this.setState(AccountVerificationState.VERIFIED);
    } else if (emailVerification.sentTo !== null) {
      this.setState(AccountVerificationState.VERIFICATION_IN_PROGRESS);
    } else {
      this.setState(AccountVerificationState.UNVERIFIED);
    }
  }

  /** Send verification request */
  verify(completion: RemoteCompletion): void {
    this.remote.verify(this.email, completion);
  }
}

// MARK: - AccountDeletionController

export class AccountDeletionController {
  private accountDeletionRequestDate: Date | null = null;
  private readonly remote: AccountRemote;

  constructor(remote: AccountRemote = new AccountRemote()) {
    this.remote = remote;
  }

  get hasValidDeletionRequest(): boolean {
    if (this.accountDeletionRequestDate === null) {
      return false;
    }
    const expirationDate: Date = dateIncreasedByDays(this.accountDeletionRequestDate, 1);
    return new Date().getTime() < expirationDate.getTime();
  }

  requestAccountDeletion(user: SPUser, completion: RemoteCompletion): void {
    const account: UserProtocol = { email: user.email ?? '', authToken: user.authToken ?? '' };
    this.remote.requestDelete(account, (result: RemoteResult) => {
      if (result.isSuccess) {
        this.accountDeletionRequestDate = new Date();
      }
      completion(result);
    });
  }

  clearRequestToken(): void {
    this.accountDeletionRequestDate = null;
  }
}
