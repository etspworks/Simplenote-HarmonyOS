// Port of Simplenote/Classes/SPTracker.m (+ SPAutomatticTracker.m, the Tracks relay it calls).
// Automattic Tracks (TracksService) has no HarmonyOS package (resolver gap), so events go to the
// local hiAppEvent log instead of the remote Tracks endpoint; the opt-out and the user-identity
// bookkeeping are ported as-is.
import { util } from '@kit.ArkTS';
import { hiAppEvent, hilog } from '@kit.PerformanceAnalysisKit';
import { UserDefaults } from './Database';
import { OptionsTracker } from './OptionsStore';
import { Simperium } from './simperium/Simperium';
import { Preferences } from '../model/Preferences';

export type TrackerProperties = Record<string, string | number | boolean>;

const DOMAIN: number = 0x0001;
const LOG_TAG: string = 'SPTracker';

// SPConstants.m: kSimperiumPreferencesObjectKey
const SIMPERIUM_PREFERENCES_OBJECT_KEY: string = 'preferences-key';

// SPAutomatticTracker.m
const TRACKS_USER_DEFAULTS_ANONYMOUS_USER_ID_KEY: string = 'TracksUserDefaultsAnonymousUserIDKey';
const TRACKS_USER_DEFAULTS_LOGGED_IN_USER_ID_KEY: string = 'TracksUserDefaultsLoggedInUserIDKey';
const TRACKS_EVENT_NAME_PREFIX: string = 'spios';
// hiAppEvent domain: letters, digits and underscores only
const APP_EVENT_DOMAIN: string = 'simplenote_tracks';

/// SPAutomatticTracker: keeps the anonymous / logged-in identity and relays each event.
export class SPAutomatticTracker {
  private static instance: SPAutomatticTracker | null = null;

  private anonymousIDValue: string | null = null;
  private loggedInIDValue: string | null = null;
  private userProperties: Map<string, string | boolean> = new Map<string, string | boolean>();
  /// The Tracks user the events are attributed to (TracksService's current user).
  private currentUserID: string = '';

  static sharedInstance(): SPAutomatticTracker {
    if (SPAutomatticTracker.instance === null) {
      SPAutomatticTracker.instance = new SPAutomatticTracker();
    }
    return SPAutomatticTracker.instance;
  }

  refreshMetadataWithEmail(email: string): void {
    this.userProperties.clear();
    this.userProperties.set('platform', 'HarmonyOS');
    this.userProperties.set('accessibility_voice_over_enabled', false);
    this.userProperties.set('is_rtl_language', false);

    const loggedInID: string | null = this.loggedInID;
    if (loggedInID === null || loggedInID.length === 0) {
      // No previous username logged
      this.loggedInID = email;
      this.anonymousID = null;
      this.switchToAuthenticatedUser(email);
    } else if (loggedInID === email) {
      // Username did not change from last call to this method
      this.switchToAuthenticatedUser(email);
    } else {
      // Username changed for some reason: switch back to anonymous first
      this.switchToAnonymousUser(this.anonymousID);
      this.switchToAuthenticatedUser(email);
      this.loggedInID = email;
      this.anonymousID = null;
    }
  }

  refreshMetadataForAnonymousUser(): void {
    this.switchToAnonymousUser(this.anonymousID);
    this.loggedInID = null;
  }

  trackEventWithName(name: string, properties: TrackerProperties | null): void {
    const eventName: string = `${TRACKS_EVENT_NAME_PREFIX}_${name}`;
    const params: TrackerProperties = {};
    if (properties !== null) {
      for (const key of Object.keys(properties)) {
        params[key] = properties[key];
      }
    }
    params['user_id'] = this.currentUserID;
    const info: hiAppEvent.AppEventInfo = {
      domain: APP_EVENT_DOMAIN,
      name: eventName,
      eventType: hiAppEvent.EventType.BEHAVIOR,
      params: params
    };
    hiAppEvent.write(info).catch((e: Error) => {
      hilog.warn(DOMAIN, LOG_TAG, 'hiAppEvent write failed: %{public}s', e.message);
    });
    if (properties === null) {
      hilog.info(DOMAIN, LOG_TAG, 'Tracked: %{public}s', eventName);
    } else {
      hilog.info(DOMAIN, LOG_TAG, 'Tracked: %{public}s, properties: %{public}s', eventName,
        JSON.stringify(properties));
    }
  }

  private switchToAuthenticatedUser(userID: string): void {
    this.currentUserID = userID;
  }

  private switchToAnonymousUser(anonymousID: string): void {
    this.currentUserID = anonymousID;
  }

  private get anonymousID(): string {
    if (this.anonymousIDValue === null || this.anonymousIDValue.length === 0) {
      let anonymousID: string | null = UserDefaults.standard.string(TRACKS_USER_DEFAULTS_ANONYMOUS_USER_ID_KEY);
      if (anonymousID === null) {
        anonymousID = util.generateRandomUUID(false).toUpperCase();
        UserDefaults.standard.set(TRACKS_USER_DEFAULTS_ANONYMOUS_USER_ID_KEY, anonymousID);
      }
      this.anonymousIDValue = anonymousID;
    }
    return this.anonymousIDValue as string;
  }

  private set anonymousID(anonymousID: string | null) {
    this.anonymousIDValue = anonymousID;
    UserDefaults.standard.set(TRACKS_USER_DEFAULTS_ANONYMOUS_USER_ID_KEY, anonymousID);
  }

  private get loggedInID(): string | null {
    if (this.loggedInIDValue === null || this.loggedInIDValue.length === 0) {
      const loggedInID: string | null = UserDefaults.standard.string(TRACKS_USER_DEFAULTS_LOGGED_IN_USER_ID_KEY);
      if (loggedInID !== null) {
        this.loggedInIDValue = loggedInID;
      }
    }
    return this.loggedInIDValue;
  }

  private set loggedInID(loggedInID: string | null) {
    this.loggedInIDValue = loggedInID;
    UserDefaults.standard.set(TRACKS_USER_DEFAULTS_LOGGED_IN_USER_ID_KEY, loggedInID);
  }
}

export class SPTracker {
  // MARK: - Metadata

  static refreshMetadataWithEmail(email: string): void {
    SPAutomatticTracker.sharedInstance().refreshMetadataWithEmail(email);
  }

  static refreshMetadataForAnonymousUser(): void {
    SPAutomatticTracker.sharedInstance().refreshMetadataForAnonymousUser();
  }

  // MARK: - Preferences

  static trackSettingsPinlockEnabled(isOn: boolean): void {
    const properties: TrackerProperties = { 'enabled': isOn };
    SPTracker.trackAutomatticEventWithName('settings_pinlock_enabled', properties);
  }

  static trackSettingsListCondensedEnabled(isOn: boolean): void {
    const properties: TrackerProperties = { 'enabled': isOn };
    SPTracker.trackAutomatticEventWithName('settings_list_condensed_enabled', properties);
  }

  static trackSettingsNoteListSortMode(description: string): void {
    const properties: TrackerProperties = { 'description': description };
    SPTracker.trackAutomatticEventWithName('settings_note_list_sort_mode', properties);
  }

  static trackSettingsThemeUpdated(themeName: string): void {
    const properties: TrackerProperties = { 'name': themeName };
    SPTracker.trackAutomatticEventWithName('settings_theme_updated', properties);
  }

  // MARK: - Events

  static trackApplicationOpened(): void {
    SPTracker.trackAutomatticEventWithName('application_opened', null);
  }

  static trackApplicationClosed(): void {
    SPTracker.trackAutomatticEventWithName('application_closed', null);
  }

  static trackEditorNoteCreated(): void {
    SPTracker.trackAutomatticEventWithName('editor_note_created', null);
  }

  static trackEditorNoteDeleted(): void {
    SPTracker.trackAutomatticEventWithName('editor_note_deleted', null);
  }

  static trackEditorNoteRestored(): void {
    SPTracker.trackAutomatticEventWithName('editor_note_restored', null);
  }

  static trackEditorNoteContentShared(): void {
    SPTracker.trackAutomatticEventWithName('editor_note_content_shared', null);
  }

  static trackEditorNoteEdited(): void {
    SPTracker.trackAutomatticEventWithName('editor_note_edited', null);
  }

  static trackEditorEmailTagAdded(): void {
    SPTracker.trackAutomatticEventWithName('editor_email_tag_added', null);
  }

  static trackEditorEmailTagRemoved(): void {
    SPTracker.trackAutomatticEventWithName('editor_email_tag_removed', null);
  }

  static trackEditorTagAdded(): void {
    SPTracker.trackAutomatticEventWithName('editor_tag_added', null);
  }

  static trackEditorTagRemoved(): void {
    SPTracker.trackAutomatticEventWithName('editor_tag_removed', null);
  }

  static trackEditorActivitiesAccessed(): void {
    SPTracker.trackAutomatticEventWithName('editor_activities_accessed', null);
  }

  static trackEditorChecklistInserted(): void {
    SPTracker.trackAutomatticEventWithName('editor_checklist_inserted', null);
  }

  static trackEditorCollaboratorsAccessed(): void {
    SPTracker.trackAutomatticEventWithName('editor_collaborators_accessed', null);
  }

  static trackEditorVersionsAccessed(): void {
    SPTracker.trackAutomatticEventWithName('editor_versions_accessed', null);
  }

  static trackEditorCopiedInternalLink(): void {
    SPTracker.trackAutomatticEventWithName('editor_copied_internal_link', null);
  }

  static trackEditorCopiedPublicLink(): void {
    SPTracker.trackAutomatticEventWithName('editor_copied_public_link', null);
  }

  static trackEditorInterlinkAutocompleteViewed(): void {
    SPTracker.trackAutomatticEventWithName('editor_interlink_autocomplete_viewed', null);
  }

  static trackListNoteCreated(): void {
    SPTracker.trackAutomatticEventWithName('list_note_created', null);
  }

  static trackListNoteDeleted(): void {
    SPTracker.trackAutomatticEventWithName('list_note_deleted', null);
  }

  static trackListNoteOpened(): void {
    SPTracker.trackAutomatticEventWithName('list_note_opened', null);
  }

  static trackListTrashEmptied(): void {
    SPTracker.trackAutomatticEventWithName('list_trash_emptied', null);
  }

  static trackListNotesSearched(): void {
    SPTracker.trackAutomatticEventWithName('list_notes_searched', null);
  }

  static trackListPinToggled(): void {
    SPTracker.trackAutomatticEventWithName('list_note_toggled_pin', null);
  }

  static trackListCopiedInternalLink(): void {
    SPTracker.trackAutomatticEventWithName('list_copied_internal_link', null);
  }

  static trackListTagViewed(): void {
    SPTracker.trackAutomatticEventWithName('list_tag_viewed', null);
  }

  static trackListUntaggedViewed(): void {
    SPTracker.trackAutomatticEventWithName('list_untagged_viewed', null);
  }

  static trackTrashViewed(): void {
    SPTracker.trackAutomatticEventWithName('list_trash_viewed', null);
  }

  static trackSidebarSidebarPanned(): void {
    SPTracker.trackAutomatticEventWithName('sidebar_sidebar_panned', null);
  }

  static trackSidebarButtonPresed(): void {
    SPTracker.trackAutomatticEventWithName('sidebar_button_pressed', null);
  }

  static trackTagRowRenamed(): void {
    SPTracker.trackAutomatticEventWithName('tag_row_renamed', null);
  }

  static trackTagRowDeleted(): void {
    SPTracker.trackAutomatticEventWithName('tag_row_deleted', null);
  }

  static trackTagCellPressed(): void {
    SPTracker.trackAutomatticEventWithName('tag_cell_pressed', null);
  }

  static trackTagMenuRenamed(): void {
    SPTracker.trackAutomatticEventWithName('tag_menu_renamed', null);
  }

  static trackTagMenuDeleted(): void {
    SPTracker.trackAutomatticEventWithName('tag_menu_deleted', null);
  }

  static trackTagEditorAccessed(): void {
    SPTracker.trackAutomatticEventWithName('tag_editor_accessed', null);
  }

  static trackRatingsPromptSeen(): void {
    SPTracker.trackAutomatticEventWithName('ratings_prompt_seen', null);
  }

  static trackRatingsAppRated(): void {
    SPTracker.trackAutomatticEventWithName('ratings_app_rated', null);
  }

  static trackRatingsAppLiked(): void {
    SPTracker.trackAutomatticEventWithName('ratings_app_liked', null);
  }

  static trackRatingsAppDisliked(): void {
    SPTracker.trackAutomatticEventWithName('ratings_app_disliked', null);
  }

  static trackRatingsDeclinedToRate(): void {
    SPTracker.trackAutomatticEventWithName('ratings_declined_to_rate_app', null);
  }

  static trackRatingsFeedbackScreenOpened(): void {
    SPTracker.trackAutomatticEventWithName('ratings_feedback_screen_opened', null);
  }

  static trackRatingsFeedbackSent(): void {
    SPTracker.trackAutomatticEventWithName('ratings_feedback_sent', null);
  }

  static trackRatingsFeedbackDeclined(): void {
    SPTracker.trackAutomatticEventWithName('ratings_feedback_declined', null);
  }

  static trackUserAccountCreated(): void {
    SPTracker.trackAutomatticEventWithName('user_account_created', null);
  }

  static trackUserSignedIn(): void {
    SPTracker.trackAutomatticEventWithName('user_signed_in', null);
  }

  static trackUserSignedOut(): void {
    SPTracker.trackAutomatticEventWithName('user_signed_out', null);
  }

  static trackLoginLinkRequested(): void {
    SPTracker.trackAutomatticEventWithName('login_link_requested', null);
  }

  static trackLoginLinkConfirmationSuccess(): void {
    SPTracker.trackAutomatticEventWithName('login_link_confirmation_success', null);
  }

  static trackLoginLinkConfirmationFailure(): void {
    SPTracker.trackAutomatticEventWithName('login_link_confirmation_failure', null);
  }

  static trackWPCCButtonPressed(): void {
    SPTracker.trackAutomatticEventWithName('wpcc_button_pressed', null);
  }

  static trackWPCCLoginSucceeded(): void {
    SPTracker.trackAutomatticEventWithName('wpcc_login_succeeded', null);
  }

  static trackWPCCLoginFailed(): void {
    SPTracker.trackAutomatticEventWithName('wpcc_login_failed', null);
  }

  static trackEditorNotePublishEnabled(isOn: boolean): void {
    const name: string = isOn ? 'editor_note_published' : 'editor_note_unpublished';
    SPTracker.trackAutomatticEventWithName(name, null);
  }

  static trackEditorNotePinEnabled(isOn: boolean): void {
    const name: string = isOn ? 'editor_note_pinned' : 'editor_note_unpinned';
    SPTracker.trackAutomatticEventWithName(name, null);
  }

  static trackEditorNoteMarkdownEnabled(isOn: boolean): void {
    const name: string = isOn ? 'editor_note_markdown_enabled' : 'editor_note_markdown_disabled';
    SPTracker.trackAutomatticEventWithName(name, null);
  }

  // MARK: - Account Deletion (SPTracker+Extensions.swift)

  static trackDeleteAccountButttonTapped(): void {
    SPTracker.trackAutomatticEventWithName('spios_delete_account_button_clicked', null);
  }

  // MARK: - Tracks Helpers

  static trackAutomatticEventWithName(name: string, properties: TrackerProperties | null): void {
    if (SPTracker.isTrackingDisabled()) {
      return;
    }
    SPAutomatticTracker.sharedInstance().trackEventWithName(name, properties);
  }

  /// Preferences.analytics_enabled (synced) is the opt-in; absent / 0 means disabled.
  static isTrackingDisabled(): boolean {
    const simperium: Simperium | null = Simperium.shared;
    if (simperium === null) {
      return true;
    }
    const bucket = simperium.preferencesBucket;
    let object = bucket.objectForKey(SIMPERIUM_PREFERENCES_OBJECT_KEY);
    if (object === undefined) {
      object = bucket.insertNewObjectForKey(SIMPERIUM_PREFERENCES_OBJECT_KEY);
    }
    if (!(object instanceof Preferences)) {
      return true;
    }
    const enabled: number | null = (object as Preferences).analytics_enabled;
    return (enabled ?? 0) === 0;
  }
}

/// Options.shared.tracker hook (OptionsStore cannot import this module's statics directly).
export class SPOptionsTracker implements OptionsTracker {
  trackSettingsNoteListSortMode(description: string): void {
    SPTracker.trackSettingsNoteListSortMode(description);
  }

  trackSettingsThemeUpdated(themeName: string): void {
    SPTracker.trackSettingsThemeUpdated(themeName);
  }
}

export const SP_OPTIONS_TRACKER: OptionsTracker = new SPOptionsTracker();
