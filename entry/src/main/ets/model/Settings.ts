// Port of Settings.h/.m: the synced "Settings" entity — remote configuration for the ratings
// prompt (read by SPRatingsHelper.reloadSettings).
import { SPManagedObject, SPMemberDefinition } from '../common/simperium/Bucket';
import { SPValue } from '../common/simperium/JsonDiff';

function numberOrNull(value: SPValue): number | null {
  if (typeof value === 'number') {
    return value as number;
  }
  if (typeof value === 'boolean') {
    return (value as boolean) ? 1 : 0;
  }
  return null;
}

export class Settings extends SPManagedObject {
  /** Synced members of the Settings entity (Simplenote 7.xcdatamodel). */
  static readonly SCHEMA_MEMBERS: SPMemberDefinition[] = [
    new SPMemberDefinition('decline_skip_versions', 'int', 0),
    new SPMemberDefinition('dislike_skip_versions', 'int', 0),
    new SPMemberDefinition('like_skip_versions', 'int', 0),
    new SPMemberDefinition('minimum_events', 'int', 0),
    new SPMemberDefinition('minimum_interval_days', 'int', 0),
    new SPMemberDefinition('ratings_disabled', 'int')
  ];

  ratings_disabled: number | null = null;
  minimum_events: number | null = null;
  minimum_interval_days: number | null = null;
  like_skip_versions: number | null = null;
  decline_skip_versions: number | null = null;
  dislike_skip_versions: number | null = null;

  protected getMemberValue(key: string): SPValue {
    switch (key) {
      case 'ratings_disabled':
        return this.ratings_disabled;
      case 'minimum_events':
        return this.minimum_events;
      case 'minimum_interval_days':
        return this.minimum_interval_days;
      case 'like_skip_versions':
        return this.like_skip_versions;
      case 'decline_skip_versions':
        return this.decline_skip_versions;
      case 'dislike_skip_versions':
        return this.dislike_skip_versions;
      default:
        return null;
    }
  }

  protected setMemberValue(key: string, value: SPValue): void {
    const n = numberOrNull(value);
    switch (key) {
      case 'ratings_disabled':
        this.ratings_disabled = n;
        break;
      case 'minimum_events':
        this.minimum_events = n;
        break;
      case 'minimum_interval_days':
        this.minimum_interval_days = n;
        break;
      case 'like_skip_versions':
        this.like_skip_versions = n;
        break;
      case 'decline_skip_versions':
        this.decline_skip_versions = n;
        break;
      case 'dislike_skip_versions':
        this.dislike_skip_versions = n;
        break;
      default:
        break;
    }
  }
}
