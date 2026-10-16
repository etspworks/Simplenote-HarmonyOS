// Port of Simperium's SPUser.h/.m (Pods/Simperium/Simperium) and of
// SPUser+UserProtocol.swift: the signed-in Simperium user. SPUser conforms to
// SimplenoteEndpoints' UserProtocol (email + authToken), which is exactly its public surface.
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';

export class SPUser {
  email: string | null;
  authToken: string | null;

  /** -initWithEmail:token: */
  constructor(email: string | null, authToken: string | null) {
    this.email = email;
    this.authToken = authToken;
  }

  /** -authenticated */
  authenticated(): boolean {
    return this.authToken !== null && this.authToken.length > 0;
  }

  /** -hashedEmail: MD5 of the UTF-8 email, lowercase hex (NSString sp_md5StringFromData:) */
  hashedEmail(): string {
    const md = cryptoFramework.createMd('MD5');
    const data = util.TextEncoder.create('utf-8').encodeInto(this.email ?? '');
    md.updateSync({ data: data });
    const digest = md.digestSync().data;
    let hex = '';
    for (let i = 0; i < digest.length; i++) {
      hex += digest[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  /** -setCustomObject:forKey: — a no-op in the library itself. */
  setCustomObject(object: Object, key: string): void {
    // Associate any JSON-serializable object with a particular key: never implemented upstream
  }

  /** -getCustomObjectForKey: — always nil in the library itself. */
  getCustomObjectForKey(key: string): Object | null {
    return null;
  }

  /** +parseUserFromResponseString: — nil unless the payload carries a non-empty access_token. */
  static parseUserFromResponseString(text: string | null | undefined): SPUser | null {
    if (text === null || text === undefined) {
      return null;
    }
    let dictionary: Record<string, Object | null> | null = null;
    try {
      dictionary = JSON.parse(text) as Record<string, Object | null>;
    } catch (e) {
      return null;
    }
    if (dictionary === null || typeof dictionary !== 'object') {
      return null;
    }
    const username = dictionary['username'];
    const token = dictionary['access_token'];
    if (typeof token !== 'string' || (token as string).length === 0) {
      return null;
    }
    return new SPUser(typeof username === 'string' ? username as string : null, token as string);
  }
}
