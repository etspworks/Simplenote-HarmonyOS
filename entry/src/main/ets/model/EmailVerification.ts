// Port of EmailVerification.swift: the "email-verification" object of the Simperium Account
// bucket — the verification token (a JSON string holding the username) and where it was sent.
import { SPDict } from '../common/simperium/JsonDiff';

/** EmailVerificationToken: Decodable { username } */
export class EmailVerificationToken {
  username: string;

  constructor(username: string) {
    this.username = username;
  }
}

// EmailVerificationKeys
const TOKEN_KEY: string = 'token';
const SENT_TO_KEY: string = 'sent_to';

export class EmailVerification {
  token: EmailVerificationToken | null;
  sentTo: string | null;

  constructor(token: EmailVerificationToken | null, sentTo: string | null) {
    this.token = token;
    this.sentTo = sentTo;
  }

  /** init(payload:) */
  static fromPayload(payload: SPDict): EmailVerification {
    let token: EmailVerificationToken | null = null;
    const dataString = payload[TOKEN_KEY];
    if (typeof dataString === 'string') {
      try {
        const decoded = JSON.parse(dataString as string) as Record<string, Object | null>;
        const username = decoded['username'];
        if (typeof username === 'string') {
          token = new EmailVerificationToken(username as string);
        }
      } catch (e) {
        token = null;
      }
    }
    const sentTo = payload[SENT_TO_KEY];
    return new EmailVerification(token, typeof sentTo === 'string' ? sentTo as string : null);
  }
}
