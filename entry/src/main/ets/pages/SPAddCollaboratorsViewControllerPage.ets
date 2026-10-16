// Port of SPAddCollaboratorsViewController (SPEntryListViewController subclass): pushed page (from
// OptionsViewController's Collaborate row). The page owns the collaborator data (the note's email
// tags merged with the picked contacts) and the section titles; SPEntryListViewController renders
// the entry field, the plus button and the rows. The SPCollaboratorDelegate calls land on
// SPObjectManager (NoteStore) insertTagNamed / removeTagNamed for the note.
import { router, EditableTitleBar, EditableLeftIconType } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { CollaboratorsRouteParams, REOPEN_NOTE_OPTIONS_KEY } from './OptionsViewControllerPage';
import { SPEntryListViewController } from '../components/EntryList';
import { ArrayDataSource } from '../common/ArrayDataSource';
import { NoteStore, isValidEmailAddress, noteHasTagNamed } from '../common/NoteStore';
import { SPContactsManager } from '../common/ContactsPicker';
import { PersonTag } from '../model/PersonTag';
import { Note } from '../model/Note';

const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'Collaborators';

@Entry
@Component
struct SPAddCollaboratorsViewControllerPage {
  @State collaborators: PersonTag[] = [];
  @State entryText: string = '';
  noteKey: string = '';
  dataSource: ArrayDataSource<PersonTag> = new ArrayDataSource<PersonTag>([]);
  autoCompleteDataSource: ArrayDataSource<PersonTag> = new ArrayDataSource<PersonTag>([]);
  @State autoCompleteCount: number = 0;
  /// Typed text matches no picked contact: offer the picker again (a dismissed first picker, or a
  /// contact that was not picked, otherwise left no way to get a suggestion).
  @State showChooseContacts: boolean = false;
  /// The note's email tags (Note.emailTags), kept in step with every insert / remove.
  emailTags: string[] = [];
  private spContactsManager: SPContactsManager = SPContactsManager.shared();
  private contactsRequested: boolean = false;

  aboutToAppear(): void {
    const params: CollaboratorsRouteParams | undefined = router.getParams() as CollaboratorsRouteParams | undefined;
    if (params !== undefined && params !== null && params.noteKey !== undefined) {
      this.noteKey = params.noteKey;
    }
    const note: Note | null = this.note();
    this.emailTags = note !== null ? note.emailTags.slice() : [];
    this.setupWithCollaborators(this.emailTags);
  }

  /// viewWillAppear: requestAuthorizationIfNeededWithCompletion:. The system contact picker stands
  /// in for the permission prompt (D6); re-run the match so picked contacts show as suggestions.
  /// ponytail: suggestions search the picked contacts only; full address-book search needs
  /// READ_CONTACTS (restricted ACL) via contact.queryContacts.
  onPageShow(): void {
    // The picker hides this page; its return re-fires onPageShow before status leaves NOT_DETERMINED.
    if (this.contactsRequested) {
      return;
    }
    this.contactsRequested = true;
    this.spContactsManager.requestAuthorizationIfNeeded((success: boolean): void => {
      if (success) {
        this.updateAutoCompleteMatchesForString(this.entryText);
      }
    });
  }

  private note(): Note | null {
    const found: Note | undefined = NoteStore.sharedManager().notes()
      .find((n: Note) => n.simperiumKey === this.noteKey);
    return found !== undefined ? found : null;
  }

  /// setupWithCollaborators: merge each email tag with the matching contacts, sorted by name.
  setupWithCollaborators(emails: string[]): void {
    const merged: PersonTag[] = [];
    for (const tag of emails) {
      const filtered: PersonTag[] = SPContactsManager.shared().people(tag);
      const people: PersonTag[] = filtered.length === 0 ? [new PersonTag('', tag)] : filtered;
      for (const person of people) {
        if (merged.find((p: PersonTag) => p.isEqual(person)) === undefined) {
          merged.push(person);
        }
      }
    }
    merged.sort((a: PersonTag, b: PersonTag) => a.compareName(b));
    this.reloadCollaborators(merged);
  }

  private reloadCollaborators(people: PersonTag[]): void {
    this.collaborators = people;
    this.dataSource.reload(people.slice());
  }

  // MARK: - SPCollaboratorDelegate (OptionsViewController / editor side of the source)

  private shouldAddCollaborator(email: string): boolean {
    const note: Note | null = this.note();
    return note !== null && !noteHasTagNamed(note, email);
  }

  private didAddCollaborator(email: string): void {
    const note: Note | null = this.note();
    if (note === null) {
      return;
    }
    this.emailTags.push(email);
    NoteStore.sharedManager().insertTagNamed(email, note).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'insertTagNamed failed: %{public}s', e.message);
    });
  }

  private didRemoveCollaborator(email: string): void {
    const note: Note | null = this.note();
    if (note === null) {
      return;
    }
    this.emailTags = this.emailTags.filter((tag: string) => tag !== email);
    NoteStore.sharedManager().removeTagNamed(email, note).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'removeTagNamed failed: %{public}s', e.message);
    });
  }

  // MARK: - Entry list events

  /// addPersonTag: validate, ask the delegate, insert, clear the field.
  addPersonTag(person: PersonTag): void {
    person.email = person.email.trim();
    if (!isValidEmailAddress(person.email)) {
      return;
    }
    if (!this.shouldAddCollaborator(person.email)) {
      return;
    }
    this.didAddCollaborator(person.email);
    person.active = true;
    const people: PersonTag[] = this.collaborators.slice();
    people.push(person);
    this.reloadCollaborators(people);
    this.entryText = '';
    this.updateAutoCompleteMatchesForString('');
  }

  /// processTextInField
  processTextInField(): void {
    const email: string = this.entryText;
    if (!isValidEmailAddress(email)) {
      return;
    }
    const filtered: PersonTag[] = SPContactsManager.shared().people(email);
    this.addPersonTag(filtered.length > 0 ? filtered[0] : new PersonTag('', email));
  }

  /// updateAutoCompleteMatchesForString:
  updateAutoCompleteMatchesForString(text: string): void {
    this.entryText = text;
    if (!this.spContactsManager.authorized) {
      this.showChooseContacts = text.length > 0;
      return;
    }
    let matches: PersonTag[] = [];
    if (text.length > 0) {
      matches = SPContactsManager.shared().people(text).filter((p: PersonTag) =>
        this.collaborators.find((c: PersonTag) => c.isEqual(p)) === undefined);
      matches.sort((a: PersonTag, b: PersonTag) => a.compareName(b));
    }
    this.autoCompleteDataSource.reload(matches);
    this.autoCompleteCount = matches.length;
    this.showChooseContacts = text.length > 0 && matches.length === 0;
  }

  /// Opens the system picker; the picked contacts become suggestions, not collaborators.
  chooseContacts(): void {
    this.spContactsManager.pickPeople().then(() => {
      this.updateAutoCompleteMatchesForString(this.entryText);
    }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'contact picker failed: %{public}s', e.message);
    });
  }

  /// tableView:didSelectRowAtIndexPath: (primary) — toggle person.active.
  toggleCollaborator(index: number): void {
    const person: PersonTag = this.collaborators[index];
    person.active = !person.active;
    if (person.active) {
      this.didAddCollaborator(person.email);
    } else {
      this.didRemoveCollaborator(person.email);
    }
    this.reloadCollaborators(this.collaborators.slice());
  }

  /// removeItemFromDataSourceAtIndexPath:
  removeCollaborator(index: number): void {
    const person: PersonTag = this.collaborators[index];
    this.didRemoveCollaborator(person.email);
    const people: PersonTag[] = this.collaborators.slice();
    people.splice(index, 1);
    this.reloadCollaborators(people);
  }

  /// entryFieldPlusButtonTapped: -> displayAddressPicker (system contact picker; picked emails added).
  entryFieldPlusButtonTapped(): void {
    SPContactsManager.shared().pickPeople().then((people: PersonTag[]) => {
      for (const person of people) {
        if (person.email.length > 0) {
          this.addPersonTag(person);
        }
      }
    }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'contact picker failed: %{public}s', e.message);
    });
  }

  /// onDone: processTextInField then dismiss.
  onDone(): void {
    this.processTextInField();
    router.back();
  }

  /// The UIKit back item / swipe pops to OptionsViewController in the same navigation stack: the editor
  /// re-presents its Options sheet when it sees REOPEN_NOTE_OPTIONS_KEY. Done (onDone) dismisses to the editor.
  private backToOptions(): void {
    AppStorage.setOrCreate<boolean>(REOPEN_NOTE_OPTIONS_KEY, true);
    router.back();
  }

  onBackPress(): boolean {
    this.backToOptions();
    return true;
  }

  build() {
    Column() {
      // HarmonyOS level-2 title bar: Back keeps backToOptions (re-presents Options), the confirm
      // checkmark is Done (onDone). The wrapper keeps the collaborators_done id for QA: EditableTitleBar
      // does not expose its buttons.
      Column() {
        EditableTitleBar({
          leftIconStyle: EditableLeftIconType.Back,
          title: 'Collaborators',
          isSaveIconRequired: true,
          onSave: (): void => {
            this.onDone();
          },
          onCancel: (): void => {
            this.backToOptions();
          }
        })
      }
      .id('collaborators_done')
      .width('100%')

      SPEntryListViewController({
        entryText: $entryText,
        placeholder: 'Add a new collaborator...',
        headerTitle: this.collaborators.length > 0 || this.emailTags.length > 0 ? 'Current Collaborators' : '',
        footerTitle: this.collaborators.length > 0 || this.emailTags.length > 0 ? '' :
          'Add an email address to share this note with someone. Then you can both make changes to it.',
        // Only @State reads: a short-circuit on the plain `authorized` flag left this prop untracked
        // on the first visit (picker still open at first build). Count > 0 implies authorized + text.
        showAutoComplete: this.autoCompleteCount > 0,
        showChooseContacts: this.showChooseContacts,
        dataSource: this.dataSource,
        autoCompleteDataSource: this.autoCompleteDataSource,
        onEntrySubmit: () => this.processTextInField(),
        onEntryChange: (text: string) => this.updateAutoCompleteMatchesForString(text),
        onPlusTapped: () => this.entryFieldPlusButtonTapped(),
        onChooseContacts: () => this.chooseContacts(),
        onRowTapped: (index: number) => this.toggleCollaborator(index),
        onRowDeleted: (index: number) => this.removeCollaborator(index),
        onAutoCompleteTapped: (index: number) => this.addPersonTag(this.autoCompleteDataSource.getData(index))
      })
    }
    .id('screen_add_collaborators')
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.background_secondary'))
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
  }
}
