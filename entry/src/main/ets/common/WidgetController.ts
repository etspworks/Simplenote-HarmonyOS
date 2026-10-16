// Port of Simplenote/Controllers/WidgetController.swift plus the SimplenoteWidgets providers
// (NoteWidgetProvider / ListWidgetProvider, WidgetDefaults, WidgetsState).
//
// Platform mapping:
//   WidgetKit timeline            -> FormKit formBindingData pushed with formProvider.updateForm
//   WidgetCenter.reloadAllTimelines -> reloadAll(): every published running form of this bundle
//   WidgetDefaults (app group)    -> the shared 'SimplenoteDefaults' preferences file
//   ExtensionCoreDataWrapper      -> CoreDataManager(usageType: WIDGETS) over the app's store
//
//   IntentConfiguration (Edit Widget) -> WidgetEditAbility (formConfigAbility); the chosen note / tag is kept
//                                     per formId in its own preferences file (CONFIG_FILE)
import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { formBindingData, formInfo, formProvider } from '@kit.FormKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { CoreDataManager, CoreDataUsageType, ManagedObjectModel, StorageSettings, StoredEntityRow } from './Database';
import { DefaultsKey, Options, SORT_MODES } from './OptionsStore';
import { dictFromJSONString, SPMember, SPSchema, SPValue } from './simperium/JsonDiff';
import { NoteStore, tagHash } from './NoteStore';
import { Tag } from '../model/Tag';
import { caseInsensitiveCompare, Note, noteStructure, NoteStructure, SIMPLENOTE_SCHEME, SIMPLENOTE_INTERLINK_HOST } from '../model/Note';
import { SortMode } from '../model/SortMode';
import {
  descriptorForNotes, predicateForNotesTag, sortNotes
} from '../model/NotesListState';

const DOMAIN: number = 0x0001;
const LOG_TAG: string = 'WidgetController';

/// form_config.json form names.
export const NEW_NOTE_WIDGET: string = 'NewNoteWidget';
export const NOTE_WIDGET: string = 'NoteWidget';
export const LIST_WIDGET: string = 'ListWidget';

/// WidgetDefaults.loggedIn (the sort mode is Options' own listSortMode key in the same file).
const WIDGET_LOGGED_IN_KEY: string = 'widgetLoggedIn';
/// ListWidget Constants.mediumRows / largeRows
const MEDIUM_ROWS: number = 3;
const NOTE_SCHEMA: SPSchema = new SPSchema(ManagedObjectModel.ENTITY_NOTE, Note.SCHEMA_MEMBERS);
const LARGE_ROWS: number = 8;
/// NoteWidgetIntent.note / ListWidgetIntent.tag, per placed widget. A missing tag key is All Notes (defaultTag).
/// Its own file: it is written from three processes (app, widget provider, editor), and a process flushing a
/// stale cached copy of the shared defaults would drop the others' choices. Always read fresh from disk.
const CONFIG_FILE: string = 'SimplenoteWidgetConfig';
const NOTE_KEY_PREFIX: string = 'widgetNote.';
const TAG_KEY_PREFIX: string = 'widgetTag.';

/// WidgetsState raw values; the cards map them to the warning strings.
export enum WidgetState {
  STANDARD = 'standard',
  NOTE_MISSING = 'noteMissing',
  TAG_DELETED = 'tagDeleted',
  LOGGED_OUT = 'loggedOut'
}

class WidgetRow {
  title: string;
  url: string;

  constructor(title: string, url: string) {
    this.title = title;
    this.url = url;
  }
}

class WidgetData {
  state: string = WidgetState.STANDARD;
  noteTitle: string = '';
  noteBody: string = '';
  noteUrl: string = '';
  /// Empty means All Notes (the card shows $string:all_notes).
  tagTitle: string = '';
  tagUrl: string = '';
  newNoteUrl: string = '';
  rows: WidgetRow[] = [];
}

/// ExtensionResultsController.notes() + tags(), read from the store outside the app process.
export class WidgetStoreSnapshot {
  notes: Note[] = [];
  tagNames: string[] = [];
}

/// URL.internalUrl(forTag:) / URL.newNoteURL(withTag:) / Note.url
function simplenoteUrl(host: string, path: string, tag: string | null): string {
  const query: string = tag === null ? '' : `?tag=${encodeURIComponent(tag)}`;
  return `${SIMPLENOTE_SCHEME}://${host}${path}${query}`;
}

export class WidgetController {
  /// syncWidgetDefaults(authenticated:sortMode:) — the sort mode already lives in the shared file.
  static syncWidgetDefaults(authenticated: boolean): void {
    const store: preferences.Preferences | null = Options.shared.store;
    if (store === null) {
      return;
    }
    try {
      store.putSync(WIDGET_LOGGED_IN_KEY, authenticated);
      store.flushSync();
    } catch (e) {
      hilog.error(DOMAIN, LOG_TAG, 'syncWidgetDefaults failed: %{public}s', JSON.stringify(e));
    }
  }

  /// resetWidgetTimelines(): refreshes every placed data widget from the app process.
  /// A logged-out store needs nothing more: every widget shows the logged-out warning.
  static reloadAll(context: common.Context): void {
    const store: NoteStore = NoteStore.sharedManager();
    const notes: Note[] = store.notes();
    const tagNames: string[] = store.tags().map((tag: Tag): string => tag.name);
    const defaults: preferences.Preferences | null = Options.shared.store;
    if (defaults === null) {
      return;
    }
    try {
      formProvider.getPublishedRunningFormInfos().then((infos: formInfo.RunningFormInfo[]) => {
        for (const info of infos) {
          if (info.formName !== NEW_NOTE_WIDGET) {
            WidgetController.push(info.formId, WidgetController.buildData(info.formId, info.formName, info.dimension,
              notes, tagNames, defaults, WidgetController.config(context)));
          }
        }
      }).catch((e: BusinessError) => {
        hilog.error(DOMAIN, LOG_TAG, 'getPublishedRunningFormInfos failed: %{public}d %{public}s', e.code, e.message);
      });
    } catch (e) {
      hilog.error(DOMAIN, LOG_TAG, 'reloadAll threw: %{public}s', JSON.stringify(e));
    }
  }

  /// FormExtensionAbility side (its own process): reads the store and defaults fresh from disk.
  static async updateFromExtension(context: common.Context, formId: string, formName: string,
    dimension: number): Promise<void> {
    if (formName === NEW_NOTE_WIDGET) {
      return;
    }
    try {
      const defaults: preferences.Preferences = WidgetController.freshDefaults(context);
      const store: WidgetStoreSnapshot = await WidgetController.loadStore(context);
      WidgetController.push(formId,
        WidgetController.buildData(formId, formName, dimension, store.notes, store.tagNames, defaults,
          WidgetController.config(context)));
    } catch (e) {
      hilog.error(DOMAIN, LOG_TAG, 'widget %{public}s not updated: %{public}s', formId, JSON.stringify(e));
    }
  }

  /// The shared defaults as the app last flushed them (this process may hold a stale cached copy).
  static freshDefaults(context: common.Context): preferences.Preferences {
    return WidgetController.fresh(context, Options.PREFERENCES_NAME);
  }

  private static config(context: common.Context): preferences.Preferences {
    return WidgetController.fresh(context, CONFIG_FILE);
  }

  private static fresh(context: common.Context, name: string): preferences.Preferences {
    const options: preferences.Options = { name: name };
    preferences.removePreferencesFromCacheSync(context, options);
    return preferences.getPreferencesSync(context, options);
  }

  static async loadStore(context: common.Context): Promise<WidgetStoreSnapshot> {
    const snapshot: WidgetStoreSnapshot = new WidgetStoreSnapshot();
    const manager: CoreDataManager =
      await CoreDataManager.create(context, new StorageSettings(), CoreDataUsageType.WIDGETS);
    if (manager.managedObjectContext === null) {
      return snapshot;
    }
    const noteRows: StoredEntityRow[] = await manager.managedObjectContext.fetchAll(ManagedObjectModel.ENTITY_NOTE);
    snapshot.notes = noteRows.map((row: StoredEntityRow): Note => WidgetController.noteFromRow(row));
    // NSSortDescriptor.descriptorForTags: by name, case-insensitive ascending.
    const tagRows: StoredEntityRow[] = await manager.managedObjectContext.fetchAll(ManagedObjectModel.ENTITY_TAG);
    snapshot.tagNames = tagRows.map((row: StoredEntityRow): string => {
      const data = dictFromJSONString(row.data);
      const name: SPValue = data === null ? undefined : data['name'];
      return typeof name === 'string' ? name : row.simperiumKey;
    }).sort((a: string, b: string): number => caseInsensitiveCompare(a, b));
    return snapshot;
  }

  /// Edit Widget: stores the choice (a note's simperiumKey, or a tag name with '' for All Notes) and redraws.
  static async saveSelection(context: common.Context, formId: string, formName: string, value: string): Promise<void> {
    const config: preferences.Preferences = WidgetController.config(context);
    config.putSync((formName === NOTE_WIDGET ? NOTE_KEY_PREFIX : TAG_KEY_PREFIX) + formId, value);
    await config.flush();
    const info: formInfo.RunningFormInfo = await formProvider.getPublishedRunningFormInfoById(formId);
    await WidgetController.updateFromExtension(context, formId, formName, info.dimension);
  }

  /// The current choice, for the edit page's checkmark (null: the default).
  static selection(context: common.Context, formId: string, formName: string): string | null {
    const value = WidgetController.config(context)
      .getSync((formName === NOTE_WIDGET ? NOTE_KEY_PREFIX : TAG_KEY_PREFIX) + formId, null);
    return typeof value === 'string' ? value : null;
  }

  static forget(context: common.Context, formId: string): void {
    try {
      const config: preferences.Preferences = WidgetController.config(context);
      config.deleteSync(NOTE_KEY_PREFIX + formId);
      config.deleteSync(TAG_KEY_PREFIX + formId);
      config.flushSync();
    } catch (e) {
      hilog.error(DOMAIN, LOG_TAG, 'forget %{public}s failed: %{public}s', formId, JSON.stringify(e));
    }
  }

  /// ExtensionResultsController.notes(): not trashed, in the widgets' sort order.
  static visibleNotes(allNotes: Note[], defaults: preferences.Preferences): Note[] {
    // Options.listSortMode: the raw value is the index in SORT_MODES.
    const raw: number = Number(defaults.getSync(DefaultsKey.LIST_SORT_MODE, 0));
    const sortMode: SortMode = raw >= 0 && raw < SORT_MODES.length ? SORT_MODES[raw] : SortMode.MODIFIED_NEWEST;
    const notes: Note[] = allNotes.filter((n: Note): boolean => !n.deleted);
    // ExtensionResultsController.sortDescriptorForNotes: the sort mode only, pinned notes are not lifted.
    return sortNotes(notes, [descriptorForNotes(sortMode)]);
  }

  private static noteFromRow(row: StoredEntityRow): Note {
    const note: Note = new Note();
    note.simperiumKey = row.simperiumKey;
    note.ghostData = row.ghostData;
    // The extension has no Simperium bucket, so Note.loadMemberData (schema = bucket.differ.schema) would drop
    // every member: blank titles and trashed notes listed. Decode the row with the Note schema directly.
    const data = dictFromJSONString(row.data);
    if (data !== null) {
      for (const key of Object.keys(data)) {
        const member: SPMember | undefined = NOTE_SCHEMA.memberForKey(key);
        if (member !== undefined) {
          note.simperiumSetValue(member.getValueFromDictionary(data, key), member.keyName);
        }
      }
    }
    note.awakeFromFetch();
    return note;
  }

  private static push(formId: string, data: WidgetData): void {
    try {
      formProvider.updateForm(formId, formBindingData.createFormBindingData(data)).catch((e: BusinessError) => {
        hilog.error(DOMAIN, LOG_TAG, 'updateForm %{public}s failed: %{public}d %{public}s', formId, e.code, e.message);
      });
    } catch (e) {
      hilog.error(DOMAIN, LOG_TAG, 'updateForm %{public}s threw: %{public}s', formId, JSON.stringify(e));
    }
  }

  /// NoteWidgetProvider / ListWidgetProvider getTimeline.
  static buildData(formId: string, formName: string, dimension: number, allNotes: Note[], tagNames: string[],
    defaults: preferences.Preferences, config: preferences.Preferences): WidgetData {
    const data: WidgetData = new WidgetData();
    if (defaults.getSync(WIDGET_LOGGED_IN_KEY, false) !== true) {
      data.state = WidgetState.LOGGED_OUT;
      return data;
    }
    let notes: Note[] = WidgetController.visibleNotes(allNotes, defaults);

    if (formName === NOTE_WIDGET) {
      const noteKey: string = NOTE_KEY_PREFIX + formId;
      let key = config.getSync(noteKey, null);
      if (typeof key !== 'string' && notes.length > 0) {
        // NoteWidgetIntentHandler.defaultNote: the first note becomes this widget's configured note.
        key = notes[0].simperiumKey;
        config.putSync(noteKey, key);
        config.flushSync();
      }
      const note: Note | undefined = notes.find((n: Note): boolean => n.simperiumKey === key);
      if (note === undefined) {
        data.state = WidgetState.NOTE_MISSING;
        return data;
      }
      // Note+Widget title / body: the raw body lines, as iOS (markdown is not rendered).
      const content: string = note.content;
      const structure: NoteStructure = noteStructure(content);
      note.ensurePreviewStringsAreAvailable();
      data.noteTitle = note.titlePreview ?? '';
      data.noteBody = structure.body === null ? '' : content.substring(structure.body.lower, structure.body.upper);
      data.noteUrl = simplenoteUrl(SIMPLENOTE_INTERLINK_HOST, `/${note.simperiumKey}`, null);
      return data;
    }

    const storedTag = config.getSync(TAG_KEY_PREFIX + formId, '');
    const tag: string | null = typeof storedTag === 'string' && storedTag.length > 0 ? storedTag : null;
    if (tag !== null) {
      // ExtensionResultsController.tagExists: compared by tag hash.
      const hash: string = tagHash(tag);
      if (!tagNames.some((name: string): boolean => tagHash(name) === hash)) {
        data.state = WidgetState.TAG_DELETED;
        return data;
      }
      notes = notes.filter(predicateForNotesTag(tag));
    }

    data.tagTitle = tag ?? '';
    // DeepLinkRouter's SIMPLENOTE_INTERNAL_TAG_HOST / WIDGET_NEW_NOTE_HOST (not imported: it pulls the session stack).
    data.tagUrl = simplenoteUrl('list', '', tag);
    data.newNoteUrl = simplenoteUrl('widgetNew', '', tag);
    const limit: number = dimension === formInfo.FormDimension.Dimension_4_4 ? LARGE_ROWS : MEDIUM_ROWS;
    data.rows = notes.slice(0, limit).map((note: Note): WidgetRow => {
      note.ensurePreviewStringsAreAvailable();
      return new WidgetRow(note.titlePreview ?? '',
        simplenoteUrl(SIMPLENOTE_INTERLINK_HOST, `/${note.simperiumKey}`, null));
    });
    // ListWidgetView.rows: short lists are padded with empty rows, so rows keep their height.
    while (data.rows.length < limit) {
      data.rows.push(new WidgetRow('', ''));
    }
    return data;
  }
}
