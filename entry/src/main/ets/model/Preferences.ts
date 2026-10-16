// Port of Preferences.h/.m: the synced "Preferences" entity — analytics opt-in, recent searches
// and the sustainer subscription. A change of subscription_level posts
// SPSubscriptionStatusDidChangeNotification (here an @kit.BasicServicesKit emitter event).
import { emitter } from '@kit.BasicServicesKit';
import { SPManagedObject, SPMemberDefinition } from '../common/simperium/Bucket';
import { SPValue } from '../common/simperium/JsonDiff';

export const SP_SUBSCRIPTION_STATUS_DID_CHANGE_NOTIFICATION: string = 'SPSubscriptionStatusDidChangeNotification';

function numberOrNull(value: SPValue): number | null {
  if (typeof value === 'number') {
    return value as number;
  }
  if (typeof value === 'boolean') {
    return (value as boolean) ? 1 : 0;
  }
  return null;
}

export class Preferences extends SPManagedObject {
  /** Synced members of the Preferences entity (Simplenote 7.xcdatamodel). */
  static readonly SCHEMA_MEMBERS: SPMemberDefinition[] = [
    new SPMemberDefinition('analytics_enabled', 'int'),
    new SPMemberDefinition('recent_searches', 'base64'),
    new SPMemberDefinition('subscription_date', 'date'),
    new SPMemberDefinition('subscription_level', 'text'),
    new SPMemberDefinition('subscription_platform', 'text'),
    new SPMemberDefinition('was_sustainer', 'int')
  ];

  recent_searches: string[] | null = null;
  analytics_enabled: number | null = null;
  subscription_date: Date | null = null;
  subscription_level: string | null = null;
  subscription_platform: string | null = null;
  was_sustainer: number | null = null;

  protected getMemberValue(key: string): SPValue {
    switch (key) {
      case 'analytics_enabled':
        return this.analytics_enabled;
      case 'recent_searches':
        return this.recent_searches;
      case 'subscription_date':
        return this.subscription_date;
      case 'subscription_level':
        return this.subscription_level;
      case 'subscription_platform':
        return this.subscription_platform;
      case 'was_sustainer':
        return this.was_sustainer;
      default:
        return null;
    }
  }

  protected setMemberValue(key: string, value: SPValue): void {
    switch (key) {
      case 'analytics_enabled':
        this.analytics_enabled = numberOrNull(value);
        break;
      case 'recent_searches': {
        const list: string[] = [];
        if (Array.isArray(value)) {
          for (const item of value as Object[]) {
            list.push(String(item));
          }
          this.recent_searches = list;
        } else {
          this.recent_searches = null;
        }
        break;
      }
      case 'subscription_date':
        this.subscription_date = value instanceof Date ? value as Date : null;
        break;
      case 'subscription_level':
        this.subscription_level = typeof value === 'string' ? value as string : null;
        break;
      case 'subscription_platform':
        this.subscription_platform = typeof value === 'string' ? value as string : null;
        break;
      case 'was_sustainer':
        this.was_sustainer = numberOrNull(value);
        break;
      default:
        break;
    }
    this.didChangeValueForKey(key);
  }

  /** Note: `analytics_enabled` feeds CrashLogging's opt-out cache in the source; crash logging has no
   * target here (its cache key has no reader), so only the subscription notification is posted. */
  didChangeValueForKey(key: string): void {
    if (key === 'subscription_level') {
      emitter.emit(SP_SUBSCRIPTION_STATUS_DID_CHANGE_NOTIFICATION);
    }
  }
}
