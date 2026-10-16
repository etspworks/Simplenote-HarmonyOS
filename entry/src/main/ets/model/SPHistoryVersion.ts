// Port of SPHistoryVersion.swift: one version of a note, as returned by the Simperium
// entity-version request (e:<key>.<version>). Hashable by version.
import { SPDict } from '../common/simperium/JsonDiff';

// Parsing Keys
enum Keys {
  MODIFICATION_DATE = 'modificationDate',
  CONTENT = 'content'
}

export class SPHistoryVersion {
  version: number;
  content: string;
  modificationDate: Date;

  constructor(version: number, content: string, modificationDate: Date) {
    this.version = version;
    this.content = content;
    this.modificationDate = modificationDate;
  }

  /** init?(version:payload:) — null unless the payload carries a numeric date and a string content */
  static fromPayload(version: number, payload: SPDict): SPHistoryVersion | null {
    const modification = payload[Keys.MODIFICATION_DATE];
    const content = payload[Keys.CONTENT];
    if (typeof modification !== 'number' || typeof content !== 'string') {
      return null;
    }
    return new SPHistoryVersion(version, content as string, new Date((modification as number) * 1000));
  }

  /** Hashable: hash(into:) combines the version only */
  hash(): number {
    return this.version;
  }

  equals(other: SPHistoryVersion): boolean {
    return this.version === other.version && this.content === other.content &&
      this.modificationDate.getTime() === other.modificationDate.getTime();
  }
}
