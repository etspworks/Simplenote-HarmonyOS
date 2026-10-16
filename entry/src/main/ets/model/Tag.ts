// Port of Tag.h/.m: the synced tag entity (an SPManagedObject; its simperiumKey is the tag name).
// `share` is a JSON list of collaborator emails; `recipients` is its decoded form.
import { SPManagedObject, SPMemberDefinition } from '../common/simperium/Bucket';
import { SPDict, SPValue, jsonString, objectFromJSONString } from '../common/simperium/JsonDiff';
import { ComparisonResult } from './Note';

export class Tag extends SPManagedObject {
  /** Synced members of the Tag entity (Simplenote 7.xcdatamodel). */
  static readonly SCHEMA_MEMBERS: SPMemberDefinition[] = [
    new SPMemberDefinition('index', 'int', 0),
    new SPMemberDefinition('name', 'text'),
    new SPMemberDefinition('share', 'jsonlist')
  ];

  name: string = '';
  index: number | null = null;
  count: number = 0;
  private shareValue: string | null = null;
  private recipientsValue: string[] = [];

  /** -initWithText: / -initWithText:recipients: (an unmanaged tag, never inserted into a bucket) */
  static initWithText(str: string, emailList: string[] = []): Tag {
    const tag = new Tag();
    tag.name = str;
    tag.recipientsValue = emailList.slice();
    tag.index = -1;
    return tag;
  }

  protected getMemberValue(key: string): SPValue {
    switch (key) {
      case 'index':
        return this.index;
      case 'name':
        return this.name;
      case 'share':
        return this.shareValue;
      default:
        return null;
    }
  }

  protected setMemberValue(key: string, value: SPValue): void {
    switch (key) {
      case 'index':
        this.index = typeof value === 'number' ? value as number : null;
        break;
      case 'name':
        this.name = typeof value === 'string' ? value as string : '';
        break;
      case 'share':
        this.share = typeof value === 'string' ? value as string : null;
        break;
      default:
        break;
    }
  }

  awakeFromFetch(): void {
    super.awakeFromFetch();
    this.updateRecipients();
  }

  get share(): string | null {
    return this.shareValue;
  }

  /** Setting the share JSON refreshes the recipients list */
  set share(newShare: string | null) {
    this.shareValue = newShare;
    this.updateRecipients();
  }

  updateRecipients(): void {
    if (this.shareValue !== null && this.shareValue.length > 0) {
      const parsed = objectFromJSONString(this.shareValue);
      const list: string[] = [];
      if (Array.isArray(parsed)) {
        for (const item of parsed as Object[]) {
          list.push(String(item));
        }
      }
      this.recipientsValue = list;
    } else {
      this.recipientsValue = [];
    }
  }

  /** -setRecipients: updates `share` instead; recipients follow via updateRecipients */
  setRecipients(newRecipients: string[]): void {
    this.share = newRecipients.length > 0 ? jsonString(newRecipients) : '[]';
  }

  recipients(): string[] {
    return this.recipientsValue;
  }

  compareIndex(tag: Tag): ComparisonResult {
    const i1 = this.index ?? 0;
    const i2 = tag.index ?? 0;
    if (i1 >= 0 && i2 >= 0) {
      if (i1 < i2) {
        return ComparisonResult.ORDERED_ASCENDING;
      }
      return i1 > i2 ? ComparisonResult.ORDERED_DESCENDING : ComparisonResult.ORDERED_SAME;
    }
    return ComparisonResult.ORDERED_SAME;
  }

  textWithPrefix(): string {
    return `#${this.name}`;
  }

  addRecipient(emailAddress: string): void {
    this.recipientsValue.push(emailAddress);
    this.shareValue = jsonString(this.recipientsValue);
  }

  tagDictionary(): SPDict {
    const dict: SPDict = {};
    dict['name'] = this.name;
    if (this.recipientsValue.length > 0) {
      dict['share'] = this.recipientsValue.slice();
    }
    dict['index'] = this.index;
    return dict;
  }
}
