// Port of Simplenote/Classes/StatusChecker.m
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Simperium } from './simperium/Simperium';
import { SPBucket, SPDiffableObject } from './simperium/Bucket';

const ENTITY_NAME: string = 'Note';
const DOMAIN: number = 0x0001;
const TAG: string = 'StatusChecker';

export class StatusChecker {
  static hasUnsentChanges(simperium: Simperium): boolean {
    if (simperium.user === null || !simperium.user.authenticated()) {
      return false;
    }
    const bucket: SPBucket | null = simperium.bucketForName(ENTITY_NAME);
    if (bucket === null) {
      return false;
    }
    const allNotes: SPDiffableObject[] = bucket.allObjects();
    const startDate: number = Date.now();
    hilog.info(DOMAIN, TAG, '<> Status Checker: Found %{public}d Entities [%{public}d ms elapsed]',
      allNotes.length, Date.now() - startDate);

    for (const note of allNotes) {
      if (bucket.hasLocalChangesForKey(note.simperiumKey)) {
        hilog.info(DOMAIN, TAG, '<> Status Checker: FOUND entities with local changes [%{public}d ms elapsed]',
          Date.now() - startDate);
        return true;
      }
    }
    hilog.info(DOMAIN, TAG, '<> Status Checker: No entities with local changes [%{public}d ms elapsed]',
      Date.now() - startDate);
    return false;
  }
}
