// Port of PersonTag.h/.m: a collaborator (name + email) shown in the collaborators list.
import { ComparisonResult } from './Note';

function localizedCaseInsensitiveCompare(a: string, b: string): ComparisonResult {
  const result = a.localeCompare(b, undefined, { sensitivity: 'accent' });
  if (result < 0) {
    return ComparisonResult.ORDERED_ASCENDING;
  }
  return result > 0 ? ComparisonResult.ORDERED_DESCENDING : ComparisonResult.ORDERED_SAME;
}

function stringHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return hash;
}

export class PersonTag {
  name: string;
  email: string;
  active: boolean;

  /** -initWithName:email: */
  constructor(name: string, email: string) {
    this.name = name;
    this.email = email;
    this.active = true;
  }

  /** -initWithName:email: */
  static initWithName(aName: string, anEmail: string): PersonTag {
    return new PersonTag(aName, anEmail);
  }

  hash(): number {
    return stringHash(this.name) + stringHash(this.email);
  }

  isEqual(object: Object | null): boolean {
    if (!(object instanceof PersonTag)) {
      return false;
    }
    const second = object as PersonTag;
    return this.name === second.name && this.email === second.email;
  }

  compareName(anotherTag: PersonTag): ComparisonResult {
    const str1 = this.name.length === 0 ? this.email : this.name;
    const str2 = anotherTag.name.length === 0 ? anotherTag.email : anotherTag.name;
    return localizedCaseInsensitiveCompare(str1, str2);
  }

  compareEmail(anotherTag: PersonTag): ComparisonResult {
    return localizedCaseInsensitiveCompare(this.email, anotherTag.email);
  }
}
