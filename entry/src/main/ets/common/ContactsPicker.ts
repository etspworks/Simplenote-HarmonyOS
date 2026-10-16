// Port of Simplenote/Classes/SPContactsManager.swift.
// Substitution (self-signed build): enumerating the whole address book needs
// ohos.permission.READ_CONTACTS, which a self-signed app cannot be granted. The system contact
// picker (contact.selectContacts) needs no permission, so the "store" here is the set of contacts
// the user picked; autocomplete (people(with:)) searches that set, exactly as the source searches
// the full store. "Authorization" is the user having answered the picker once.
import { contact } from '@kit.ContactsKit';
import { preferences } from '@kit.ArkData';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { PersonTag } from '../model/PersonTag';
import { Options } from './OptionsStore';

const DOMAIN: number = 0x0001;
const LOG_TAG: string = 'SPContactsManager';
/// The picked contacts (full name + emails only), kept across launches the way iOS keeps a contacts grant:
/// without it every launch re-opened the picker and a dismissed picker left no suggestions (T-0158).
const PICKED_CONTACTS_KEY: string = 'SPPickedContacts';

function contactKey(c: contact.Contact): string {
  return (c.name?.fullName ?? '') + '\n' + (c.emails ?? []).map((e: contact.Email): string => e.email ?? '').join(',');
}

class StoredContact {
  name: string = '';
  emails: string[] = [];
}

/// CNAuthorizationStatus
export enum ContactsAuthorizationStatus {
  NOT_DETERMINED = 'notDetermined',
  DENIED = 'denied',
  AUTHORIZED = 'authorized'
}

/// CNContactStore analogue: the contacts handed over by the system picker.
export class PickedContactStore {
  private contacts: contact.Contact[] = [];
  private changeListeners: Array<() => void> = [];
  authorizationStatus: ContactsAuthorizationStatus = ContactsAuthorizationStatus.NOT_DETERMINED;

  constructor() {
    this.restore();
  }

  /// requestAccess(for: .contacts): opens the system picker (multi-select)
  async requestAccess(): Promise<boolean> {
    return (await this.pick()).length > 0;
  }

  /// Opens the system picker and returns every contact picked this time (already-known ones included).
  async pick(): Promise<contact.Contact[]> {
    const options: contact.ContactSelectionOptions = { isMultiSelect: true };
    try {
      const picked: contact.Contact[] = await contact.selectContacts(options);
      this.merge(picked);
      this.authorizationStatus = picked.length > 0 ? ContactsAuthorizationStatus.AUTHORIZED :
        (this.contacts.length > 0 ? ContactsAuthorizationStatus.AUTHORIZED : ContactsAuthorizationStatus.DENIED);
      return picked;
    } catch (e) {
      hilog.error(DOMAIN, LOG_TAG, 'selectContacts failed: %{public}s', JSON.stringify(e));
      if (this.contacts.length === 0) {
        this.authorizationStatus = ContactsAuthorizationStatus.DENIED;
      }
      return [];
    }
  }

  /// enumerateContacts(with:)
  enumerateContacts(block: (c: contact.Contact) => void): void {
    for (const c of this.contacts) {
      block(c);
    }
  }

  /// .CNContactStoreDidChange
  addChangeListener(listener: () => void): void {
    this.changeListeners.push(listener);
  }

  private merge(picked: contact.Contact[]): void {
    for (const c of picked) {
      // Picking the same contact again must not duplicate its suggestions, now that the set is persisted.
      if (!this.contacts.some((known: contact.Contact): boolean => contactKey(known) === contactKey(c))) {
        this.contacts.push(c);
      }
    }
    this.persist();
    for (const listener of this.changeListeners) {
      listener();
    }
  }

  private persist(): void {
    const store: preferences.Preferences | null = Options.shared.store;
    if (store === null) {
      return;
    }
    const stored: StoredContact[] = this.contacts.map((c: contact.Contact): StoredContact => {
      const s: StoredContact = new StoredContact();
      s.name = c.name?.fullName ?? '';
      s.emails = (c.emails ?? []).map((e: contact.Email): string => e.email ?? '').filter((e: string) => e.length > 0);
      return s;
    });
    store.putSync(PICKED_CONTACTS_KEY, JSON.stringify(stored));
    store.flush();
  }

  private restore(): void {
    const store: preferences.Preferences | null = Options.shared.store;
    if (store === null) {
      return;
    }
    const value: preferences.ValueType = store.getSync(PICKED_CONTACTS_KEY, '');
    if (typeof value !== 'string' || value.length === 0) {
      return;
    }
    try {
      const stored: StoredContact[] = JSON.parse(value as string) as StoredContact[];
      for (const s of stored) {
        const c: contact.Contact = new contact.Contact();
        c.name = { fullName: s.name };
        c.emails = s.emails.map((email: string): contact.Email => {
          const e: contact.Email = { email: email };
          return e;
        });
        this.contacts.push(c);
      }
    } catch (e) {
      hilog.error(DOMAIN, LOG_TAG, 'restore picked contacts failed: %{public}s', JSON.stringify(e));
    }
    if (this.contacts.length > 0) {
      this.authorizationStatus = ContactsAuthorizationStatus.AUTHORIZED;
    }
  }
}

export class SPContactsManager {
  private static instance: SPContactsManager | null = null;

  /// All of the contacts!
  private peopleCache: PersonTag[] | null = null;

  /// Contacts Store Reference
  private readonly store: PickedContactStore = new PickedContactStore();

  static shared(): SPContactsManager {
    if (SPContactsManager.instance === null) {
      SPContactsManager.instance = new SPContactsManager();
    }
    return SPContactsManager.instance;
  }

  constructor() {
    this.store.addChangeListener(() => {
      this.resetCache();
    });
  }

  /// Checks if we've got permission to access the Contacts Store, or not
  get authorized(): boolean {
    return this.status === ContactsAuthorizationStatus.AUTHORIZED;
  }

  /// Returns the current Authorization Status
  get status(): ContactsAuthorizationStatus {
    return this.store.authorizationStatus;
  }

  /// Whenever the Auth Status is undetermined, this helper will request access (opens the picker).
  requestAuthorizationIfNeeded(completion: ((success: boolean) => void) | null): void {
    if (this.status !== ContactsAuthorizationStatus.NOT_DETERMINED) {
      return;
    }
    this.store.requestAccess().then((success: boolean) => {
      if (completion !== null) {
        completion(success);
      }
    });
  }

  /// Opens the system picker again (adds to the picked set). Returns all the people picked this time,
  /// including ones picked before (the stored set dedupes, the result does not).
  async pickPeople(): Promise<PersonTag[]> {
    return this.loadPeople(await this.store.pick());
  }

  /// Returns the subset of Persons that contain a specified keyword, in either their email or name
  people(keyword: string): PersonTag[] {
    const people: PersonTag[] | null = this.loadPeopleIfNeeded();
    if (people === null) {
      return [];
    }
    const normalizedKeyword: string = keyword.toLowerCase();
    return people.filter((person: PersonTag) => {
      return person.email.toLowerCase().includes(normalizedKeyword) ||
        person.name.toLowerCase().includes(normalizedKeyword);
    });
  }

  /// Returns a collection of all of the PersonTag's.
  loadPeopleIfNeeded(): PersonTag[] | null {
    if (!this.authorized) {
      return null;
    }
    if (this.peopleCache !== null) {
      return this.peopleCache;
    }
    this.peopleCache = this.loadPeople(this.loadContacts());
    return this.peopleCache;
  }

  /// Given a collection of Contacts, returns the matching PersonTag instances (one per email)
  private loadPeople(contacts: contact.Contact[]): PersonTag[] {
    const persons: PersonTag[] = [];
    for (const c of contacts) {
      const fullname: string = c.name?.fullName ?? '';
      const emails: contact.Email[] = c.emails ?? [];
      for (const email of emails) {
        // PersonTag(name:email:) is failable on a nil email
        if (email.email === undefined || email.email === null || email.email.length === 0) {
          continue;
        }
        persons.push(new PersonTag(fullname, email.email));
      }
    }
    return persons;
  }

  /// Returns a collection of all of the contacts: only Fullname + Email are used
  private loadContacts(): contact.Contact[] {
    const contacts: contact.Contact[] = [];
    try {
      this.store.enumerateContacts((c: contact.Contact) => {
        contacts.push(c);
      });
    } catch (e) {
      hilog.error(DOMAIN, LOG_TAG, '## Error while loading contacts: %{public}s', JSON.stringify(e));
    }
    return contacts;
  }

  /// Nukes the People Cache. Useful to deal with "Contacts Updated" Notifications
  resetCache(): void {
    this.peopleCache = null;
  }
}

export { SPContactsManager as ContactsPicker };
