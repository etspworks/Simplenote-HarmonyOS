// Port of the open-note half of UIKit state restoration:
// SPNoteEditorViewController.encodeRestorableState (CodingKeys.currentNoteKey) and
// SPAppDelegate.viewController(restorationIdentifier:coder:) rebuilding the editor for that key.
// The coder is a preferences key in the shared UserDefaults store.
import { preferences } from '@kit.ArkData';
import { Options } from './OptionsStore';
import { NoteStore } from './NoteStore';
import { ActivityType, SEARCHABLE_ITEM_ACTIVITY_IDENTIFIER, ShortcutsHandler, UserActivity } from './DeepLinkRouter';
import { Note } from '../model/Note';

/// SPNoteEditorViewController.CodingKeys.currentNoteKey
const CURRENT_NOTE_KEY: string = 'currentNoteKey';

function storedNoteKey(): string {
  const store: preferences.Preferences | null = Options.shared.store;
  const value: preferences.ValueType = store === null ? '' : store.getSync(CURRENT_NOTE_KEY, '');
  return typeof value === 'string' ? value as string : '';
}

function putNoteKey(key: string): void {
  const store: preferences.Preferences | null = Options.shared.store;
  if (store !== null) {
    store.putSync(CURRENT_NOTE_KEY, key);
    store.flushSync();
  }
}

/// encodeRestorableState: the editor showing `key` is on screen.
export function encodeOpenNoteKey(key: string): void {
  if (key.length > 0 && storedNoteKey() !== key) {
    putNoteKey(key);
  }
}

/// The editor for `key` left the stack: nothing to restore. A replacing editor may already have stored its own key.
export function clearOpenNoteKey(key: string): void {
  if (storedNoteKey() === key) {
    putNoteKey('');
  }
}

/// viewController(restorationIdentifier:coder:): reopen the stored note when it still exists and is not trashed.
export function restoreOpenNote(): void {
  const key: string = storedNoteKey();
  if (key.length === 0) {
    return;
  }
  NoteStore.sharedManager().whenReady().then((): void => {
    const note: Note | undefined = NoteStore.sharedManager().notes()
      .find((n: Note): boolean => n.simperiumKey === key && !n.deleted);
    if (note === undefined) {
      putNoteKey('');
      return;
    }
    const activity: UserActivity = new UserActivity(ActivityType.OPEN_NOTE, '');
    activity.userInfo.set(SEARCHABLE_ITEM_ACTIVITY_IDENTIFIER, key);
    ShortcutsHandler.shared.handleUserActivity(activity);
  });
}
