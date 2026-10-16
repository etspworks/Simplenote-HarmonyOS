// Port of Simplenote/Options.swift (+ UserDefaults+Simplenote.swift keys).
// UserDefaults -> @kit.ArkData preferences; NotificationCenter -> @kit.BasicServicesKit emitter.
import { common, ConfigurationConstant } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { emitter } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { SortMode } from '../model/SortMode';
import { Theme } from '../model/Theme';

// UserDefaults.Key raw values (UserDefaults+Simplenote.swift)
export class DefaultsKey {
  static readonly CONDENSED_NOTES: string = 'SPCondensedNoteListPref';
  static readonly FIRST_LAUNCH: string = 'SPFirstLaunch';
  static readonly LAST_KNOWN_VERSION: string = 'lastKnownVersion';
  static readonly LIST_SORT_MODE: string = 'listSortMode';
  static readonly LIST_SORT_MODE_LEGACY: string = 'SPAlphabeticalSortPref';
  static readonly MARKDOWN: string = 'MarkdownDefault';
  static readonly THEME: string = 'theme';
  static readonly THEME_LEGACY: string = 'SPThemePref';
  static readonly WORDPRESS_SESSION_KEY: string = 'SPAuthSessionKey';
  static readonly USE_BIOMETRY_INSTEAD_OF_PIN: string = 'SimplenoteUseTouchID';
  static readonly ACCOUNT_IS_LOGGED_IN: string = 'accountIsLoggedIn';
  static readonly USE_SUSTAINER_ICON: string = 'useSustainerIcon';
  static readonly HAS_MIGRATED_SUSTAINER_PREFERENCES: string = 'hasMigratedSustainerPreferences';
  static readonly INDEX_NOTES_IN_SPOTLIGHT: string = 'indexNotesInSpotlight';
  // SPSettingsViewController.m: SPAlphabeticalTagSortPref
  static readonly ALPHABETICAL_TAG_SORT: string = 'SPAlphabeticalTagSortPref';
}

// NotificationCenter names posted by Options
export class OptionsEvent {
  static readonly CONDENSED_NOTE_LIST_PREFERENCE_CHANGED: string = 'SPCondensedNoteListPreferenceChanged';
  static readonly NOTES_LIST_SORT_MODE_CHANGED: string = 'SPNotesListSortModeChanged';
  static readonly SIMPLENOTE_THEME_CHANGED: string = 'SPSimplenoteThemeChanged';
  // SPNotifications.m
  static readonly ALPHABETICAL_TAG_SORT_PREFERENCE_CHANGED: string = 'SPAlphabeticalTagSortPreferenceChangedNotification';
}

// SortMode / Theme are Int-backed in the source; the raw value is the index in these tables.
export const SORT_MODES: SortMode[] = [
  SortMode.ALPHABETICALLY_ASCENDING,
  SortMode.ALPHABETICALLY_DESCENDING,
  SortMode.CREATED_NEWEST,
  SortMode.CREATED_OLDEST,
  SortMode.MODIFIED_NEWEST,
  SortMode.MODIFIED_OLDEST
];
const SORT_MODE_DESCRIPTIONS: string[] = [
  'Name: A-Z', 'Name: Z-A', 'Created: Newest', 'Created: Oldest', 'Modified: Newest', 'Modified: Oldest'
];
export const THEMES: Theme[] = [Theme.DARK, Theme.LIGHT, Theme.SYSTEM];
const THEME_DESCRIPTIONS: string[] = ['Dark', 'Light', 'System Default'];

export function sortModeRawValue(mode: SortMode): number {
  return SORT_MODES.indexOf(mode);
}

export function sortModeDescription(mode: SortMode): string {
  const raw: number = SORT_MODES.indexOf(mode);
  return raw >= 0 ? SORT_MODE_DESCRIPTIONS[raw] : '';
}

export function themeRawValue(theme: Theme): number {
  return THEMES.indexOf(theme);
}

export function themeDescription(theme: Theme): string {
  const raw: number = THEMES.indexOf(theme);
  return raw >= 0 ? THEME_DESCRIPTIONS[raw] : '';
}

/// SPTracker calls made by the Options setters. Tracker.ts attaches itself here.
export interface OptionsTracker {
  trackSettingsNoteListSortMode(description: string): void;
  trackSettingsThemeUpdated(themeName: string): void;
}

const DOMAIN: number = 0x0001;
const TAG: string = 'OptionsStore';
const NUMBER_OF_PREVIEW_LINES_REGULAR: number = 3;
const NUMBER_OF_PREVIEW_LINES_CONDENSED: number = 1;

export class Options {
  static readonly PREFERENCES_NAME: string = 'SimplenoteDefaults';

  /// Shared Instance. Call `load(context)` once from EntryAbility.onCreate before any read.
  static readonly shared: Options = new Options();

  private defaults: preferences.Preferences | null = null;
  tracker: OptionsTracker | null = null;

  load(context: common.Context): void {
    if (this.defaults !== null) {
      return;
    }
    const opts: preferences.Options = { name: Options.PREFERENCES_NAME };
    this.defaults = preferences.getPreferencesSync(context, opts);
    this.migrateLegacyOptions();
    this.migrateLegacyTheme();
  }

  /// Underlying store, for other services persisting UserDefaults keys (PIN lock, ratings).
  get store(): preferences.Preferences | null {
    return this.defaults;
  }

  // MARK: - Actual Options

  get condensedNotesList(): boolean {
    return this.bool(DefaultsKey.CONDENSED_NOTES);
  }

  set condensedNotesList(newValue: boolean) {
    this.set(DefaultsKey.CONDENSED_NOTES, newValue);
    this.post(OptionsEvent.CONDENSED_NOTE_LIST_PREFERENCE_CHANGED, newValue ? 'true' : 'false');
  }

  get firstLaunch(): boolean {
    return this.bool(DefaultsKey.FIRST_LAUNCH);
  }

  set firstLaunch(newValue: boolean) {
    this.set(DefaultsKey.FIRST_LAUNCH, newValue);
  }

  get listSortMode(): SortMode {
    // reset() (sign out) removes the key; integer() would then read 0 = A-Z until the next launch's
    // migrateLegacyOptions writes the default back, so a fresh login listed the notes alphabetically (F-011).
    if (!this.containsObject(DefaultsKey.LIST_SORT_MODE)) {
      return SortMode.MODIFIED_NEWEST;
    }
    const payload: number = this.integer(DefaultsKey.LIST_SORT_MODE);
    if (payload >= 0 && payload < SORT_MODES.length) {
      return SORT_MODES[payload];
    }
    return SortMode.MODIFIED_NEWEST;
  }

  set listSortMode(newValue: SortMode) {
    this.set(DefaultsKey.LIST_SORT_MODE, sortModeRawValue(newValue));
    const description: string = sortModeDescription(newValue);
    if (this.tracker !== null) {
      this.tracker.trackSettingsNoteListSortMode(description);
    }
    this.post(OptionsEvent.NOTES_LIST_SORT_MODE_CHANGED, description);
  }

  get markdown(): boolean {
    return this.bool(DefaultsKey.MARKDOWN);
  }

  set markdown(newValue: boolean) {
    this.set(DefaultsKey.MARKDOWN, newValue);
  }

  get theme(): Theme {
    if (!this.containsObject(DefaultsKey.THEME)) {
      return Options.defaultThemeForCurrentOS();
    }
    const payload: number = this.integer(DefaultsKey.THEME);
    if (payload >= 0 && payload < THEMES.length) {
      return THEMES[payload];
    }
    return Options.defaultThemeForCurrentOS();
  }

  set theme(newValue: Theme) {
    this.set(DefaultsKey.THEME, themeRawValue(newValue));
    const name: string = themeDescription(newValue);
    if (this.tracker !== null) {
      this.tracker.trackSettingsThemeUpdated(name);
    }
    this.post(OptionsEvent.SIMPLENOTE_THEME_CHANGED, name);
  }

  get useBiometryInsteadOfPin(): boolean {
    return this.bool(DefaultsKey.USE_BIOMETRY_INSTEAD_OF_PIN);
  }

  set useBiometryInsteadOfPin(newValue: boolean) {
    this.set(DefaultsKey.USE_BIOMETRY_INSTEAD_OF_PIN, newValue);
  }

  /// SPSettingsViewController alphabeticalTagSortPref / TagListViewController reads.
  get alphabeticalTagSortPref(): boolean {
    return this.bool(DefaultsKey.ALPHABETICAL_TAG_SORT);
  }

  set alphabeticalTagSortPref(isOn: boolean) {
    this.set(DefaultsKey.ALPHABETICAL_TAG_SORT, isOn);
    this.post(OptionsEvent.ALPHABETICAL_TAG_SORT_PREFERENCE_CHANGED, isOn ? 'true' : 'false');
  }

  // MARK: - Convenience

  get listSortModeDescription(): string {
    return sortModeDescription(this.listSortMode);
  }

  get themeDescription(): string {
    return themeDescription(this.theme);
  }

  /// Nukes all of the Options. Useful for *logout* scenarios
  reset(): void {
    this.removeObject(DefaultsKey.THEME);
    this.removeObject(DefaultsKey.LIST_SORT_MODE);
    this.removeObject(DefaultsKey.MARKDOWN);
    this.removeObject(DefaultsKey.USE_BIOMETRY_INSTEAD_OF_PIN);
  }

  get numberOfPreviewLines(): number {
    return this.condensedNotesList ? NUMBER_OF_PREVIEW_LINES_CONDENSED : NUMBER_OF_PREVIEW_LINES_REGULAR;
  }

  /// Persisted only: HarmonyOS has no Spotlight-style app content index for third-party apps.
  get indexNotesInSpotlight(): boolean {
    return this.bool(DefaultsKey.INDEX_NOTES_IN_SPOTLIGHT);
  }

  set indexNotesInSpotlight(newValue: boolean) {
    this.set(DefaultsKey.INDEX_NOTES_IN_SPOTLIGHT, newValue);
  }

  /// Applies the selected theme to the whole app (SPUserInterface.refreshUserInterfaceStyle).
  applyTheme(context: common.ApplicationContext): void {
    const theme: Theme = this.theme;
    let mode: ConfigurationConstant.ColorMode = ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET;
    if (theme === Theme.DARK) {
      mode = ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    } else if (theme === Theme.LIGHT) {
      mode = ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT;
    }
    context.setColorMode(mode);
  }

  static defaultThemeForCurrentOS(): Theme {
    return Theme.SYSTEM;
  }

  // MARK: - Migrations

  migrateLegacyOptions(): void {
    if (this.containsObject(DefaultsKey.LIST_SORT_MODE)) {
      return;
    }
    const legacySortAlphabetically: boolean = this.bool(DefaultsKey.LIST_SORT_MODE_LEGACY);
    const newMode: SortMode = legacySortAlphabetically ? SortMode.ALPHABETICALLY_ASCENDING : SortMode.MODIFIED_NEWEST;
    this.set(DefaultsKey.LIST_SORT_MODE, sortModeRawValue(newMode));
    this.removeObject(DefaultsKey.LIST_SORT_MODE_LEGACY);
  }

  migrateLegacyTheme(): void {
    if (this.containsObject(DefaultsKey.THEME) || !this.containsObject(DefaultsKey.THEME_LEGACY)) {
      return;
    }
    const newTheme: Theme = this.bool(DefaultsKey.THEME_LEGACY) ? Theme.DARK : Theme.LIGHT;
    this.set(DefaultsKey.THEME, themeRawValue(newTheme));
  }

  // MARK: - UserDefaults helpers

  private bool(key: string): boolean {
    if (this.defaults === null) {
      return false;
    }
    const value: preferences.ValueType = this.defaults.getSync(key, false);
    return typeof value === 'boolean' ? value as boolean : false;
  }

  private integer(key: string): number {
    if (this.defaults === null) {
      return 0;
    }
    const value: preferences.ValueType = this.defaults.getSync(key, 0);
    return typeof value === 'number' ? value as number : 0;
  }

  private containsObject(key: string): boolean {
    return this.defaults !== null && this.defaults.hasSync(key);
  }

  private set(key: string, value: preferences.ValueType): void {
    if (this.defaults === null) {
      hilog.error(DOMAIN, TAG, 'write before load: %{public}s', key);
      return;
    }
    this.defaults.putSync(key, value);
    this.defaults.flushSync();
  }

  private removeObject(key: string): void {
    if (this.defaults === null) {
      return;
    }
    this.defaults.deleteSync(key);
    this.defaults.flushSync();
  }

  private post(name: string, value: string): void {
    const data: emitter.EventData = { data: { 'value': value } };
    emitter.emit(name, data);
  }
}

// Module-name alias.
export { Options as OptionsStore };
