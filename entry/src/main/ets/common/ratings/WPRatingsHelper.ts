// Port of WordPress-Ratings-iOS 0.0.2 (Pods/WordPress-Ratings-iOS: WPRatingsHelper.h/.m,
// NSDate+Ratings.m) and of the app's subclass SPRatingsHelper.m, which feeds it the remote
// Settings entity and only prompts signed-in users. Counters live in UserDefaults, as upstream.
import { UserDefaults } from '../Database';
import { Settings } from '../../model/Settings';
import { SPCredentials, Simperium } from '../simperium/Simperium';

// UserDefault Keys
const WP_RATINGS_CURRENT_VERSION: string = 'WPRatingsCurrentVersion';
const WP_RATINGS_SIGNIFICANT_EVENT_COUNT: string = 'WPRatingsSignificantEventCount';
const WP_RATINGS_USE_COUNT: string = 'WPRatingsUseCount';
const WP_RATINGS_NUMBER_OF_VERSIONS_SKIPPED_PROMPTING: string = 'WPRatingsNumberOfVersionsSkippedPrompting';
const WP_RATINGS_NUMBER_OF_VERSIONS_TO_SKIP_PROMPTING: string = 'WPRatingsNumberOfVersionsToSkipPrompting';
const WP_RATINGS_SKIP_RATING_CURRENT_VERSION: string = 'WPRatingsSkipRatingCurrentVersion';
const WP_RATINGS_RATED_CURRENT_VERSION: string = 'WPRatingsRatedCurrentVersion';
const WP_RATINGS_DECLINED_TO_RATE_CURRENT_VERSION: string = 'WPRatingsDeclinedToRateCurrentVersion';
const WP_RATINGS_GAVE_FEEDBACK_FOR_CURRENT_VERSION: string = 'WPRatingsGaveFeedbackForCurrentVersion';
const WP_RATINGS_DISLIKED_CURRENT_VERSION: string = 'WPRatingsDislikedCurrentVersion';
const WP_RATINGS_LIKED_CURRENT_VERSION: string = 'WPRatingsLikedCurrentVersion';
const WP_RATINGS_USER_LIKE_COUNT: string = 'WPRatingsUserLikeCount';
const WP_RATINGS_USER_DISLIKE_COUNT: string = 'WPRatingsUserDislikeCount';
const WP_RATINGS_LAST_REVIEW_VERSION: string = 'WPRatingsLastReviewVersion';
const WP_RATINGS_LAST_REVIEW_DATE: string = 'WPRatingsLastReviewDate';

// Default Settings
const WP_RATINGS_DEFAULT_RATINGS_DISABLED: boolean = false;
const WP_RATINGS_DEFAULT_MINIMUM_EVENTS: number = 5;
const WP_RATINGS_DEFAULT_MINIMUM_INTERVAL_DAYS: number = 90;
const WP_RATINGS_DEFAULT_LIKE_SKIP_VERSIONS: number = 1;
const WP_RATINGS_DEFAULT_DECLINE_SKIP_VERSIONS: number = 2;
const WP_RATINGS_DEFAULT_DISLIKE_SKIP_VERSIONS: number = 2;

const MS_PER_DAY: number = 24 * 60 * 60 * 1000;

/** NSDate+Ratings: whole calendar days between the start of each date's day */
export function daysBetweenDate(fromDateTime: Date, toDateTime: Date): number {
  const fromDay = new Date(fromDateTime.getFullYear(), fromDateTime.getMonth(), fromDateTime.getDate());
  const toDay = new Date(toDateTime.getFullYear(), toDateTime.getMonth(), toDateTime.getDate());
  return Math.round((toDay.getTime() - fromDay.getTime()) / MS_PER_DAY);
}

export class WPRatingsHelper {
  /** Number of Significant events required by shouldPromptForAppReview */
  significantEventsCount: number = WP_RATINGS_DEFAULT_MINIMUM_EVENTS;
  /** Minimum number of days that must elapse before showing the Reminder again */
  minimumIntervalDays: number = WP_RATINGS_DEFAULT_MINIMUM_INTERVAL_DAYS;
  /** App Versions to skip when the user likes the app */
  likeSkipVersions: number = WP_RATINGS_DEFAULT_LIKE_SKIP_VERSIONS;
  /** App Versions to skip when the user declines to rate the app */
  declineSkipVersions: number = WP_RATINGS_DEFAULT_DECLINE_SKIP_VERSIONS;
  /** App Versions to skip when the user dislikes the app */
  dislikeSkipVersions: number = WP_RATINGS_DEFAULT_DISLIKE_SKIP_VERSIONS;
  /** Allows the user to entirely disable the Ratings Reminder */
  ratingsDisabled: boolean = WP_RATINGS_DEFAULT_RATINGS_DISABLED;

  protected get userDefaults(): UserDefaults {
    return UserDefaults.standard;
  }

  /** Call with the current App Version to set up internal tracking */
  initializeForVersion(version: string): void {
    const userDefaults = this.userDefaults;
    let trackingVersion = userDefaults.string(WP_RATINGS_CURRENT_VERSION);
    if (trackingVersion === null) {
      trackingVersion = version;
      userDefaults.set(WP_RATINGS_CURRENT_VERSION, version);
    }

    if (trackingVersion === version) {
      // Increment the use count
      userDefaults.set(WP_RATINGS_USE_COUNT, userDefaults.integer(WP_RATINGS_USE_COUNT) + 1);
      return;
    }

    // Restarting tracking for new version of app
    const interactedWithReviewPromptInPreviousVersion = this.interactedWithReviewPrompt();
    const skippedRatingPreviousVersion = this.skipRatingCurrentVersion();

    userDefaults.set(WP_RATINGS_CURRENT_VERSION, version);
    userDefaults.set(WP_RATINGS_SIGNIFICANT_EVENT_COUNT, 0);
    userDefaults.set(WP_RATINGS_RATED_CURRENT_VERSION, false);
    userDefaults.set(WP_RATINGS_DECLINED_TO_RATE_CURRENT_VERSION, false);
    userDefaults.set(WP_RATINGS_GAVE_FEEDBACK_FOR_CURRENT_VERSION, false);
    userDefaults.set(WP_RATINGS_DISLIKED_CURRENT_VERSION, false);
    userDefaults.set(WP_RATINGS_LIKED_CURRENT_VERSION, false);
    userDefaults.set(WP_RATINGS_SKIP_RATING_CURRENT_VERSION, false);

    if (interactedWithReviewPromptInPreviousVersion || skippedRatingPreviousVersion) {
      let numberOfVersionsSkippedPrompting = userDefaults.integer(WP_RATINGS_NUMBER_OF_VERSIONS_SKIPPED_PROMPTING);
      const numberOfVersionsToSkipPrompting = userDefaults.integer(WP_RATINGS_NUMBER_OF_VERSIONS_TO_SKIP_PROMPTING);
      if (numberOfVersionsToSkipPrompting > 0) {
        if (numberOfVersionsSkippedPrompting < numberOfVersionsToSkipPrompting) {
          // We haven't skipped enough versions, skip this one
          numberOfVersionsSkippedPrompting++;
          userDefaults.set(WP_RATINGS_NUMBER_OF_VERSIONS_SKIPPED_PROMPTING, numberOfVersionsSkippedPrompting);
          userDefaults.set(WP_RATINGS_SKIP_RATING_CURRENT_VERSION, true);
        } else {
          // We have skipped enough, reset data
          userDefaults.set(WP_RATINGS_NUMBER_OF_VERSIONS_SKIPPED_PROMPTING, 0);
          userDefaults.set(WP_RATINGS_NUMBER_OF_VERSIONS_TO_SKIP_PROMPTING, 0);
        }
      }
    }
  }

  incrementSignificantEvent(): void {
    const count = this.userDefaults.integer(WP_RATINGS_SIGNIFICANT_EVENT_COUNT) + 1;
    this.userDefaults.set(WP_RATINGS_SIGNIFICANT_EVENT_COUNT, count);
  }

  declinedToRateCurrentVersion(): void {
    this.userDefaults.set(WP_RATINGS_DECLINED_TO_RATE_CURRENT_VERSION, true);
    this.userDefaults.set(WP_RATINGS_NUMBER_OF_VERSIONS_TO_SKIP_PROMPTING, this.declineSkipVersions);
  }

  gaveFeedbackForCurrentVersion(): void {
    this.userDefaults.set(WP_RATINGS_GAVE_FEEDBACK_FOR_CURRENT_VERSION, true);
  }

  ratedCurrentVersion(): void {
    this.userDefaults.set(WP_RATINGS_RATED_CURRENT_VERSION, true);
  }

  dislikedCurrentVersion(): void {
    const userDislikeCount = this.userDefaults.integer(WP_RATINGS_USER_DISLIKE_COUNT) + 1;
    this.userDefaults.set(WP_RATINGS_USER_DISLIKE_COUNT, userDislikeCount);
    this.userDefaults.set(WP_RATINGS_DISLIKED_CURRENT_VERSION, true);
    this.userDefaults.set(WP_RATINGS_NUMBER_OF_VERSIONS_TO_SKIP_PROMPTING, this.dislikeSkipVersions);
  }

  likedCurrentVersion(): void {
    const userLikeCount = this.userDefaults.integer(WP_RATINGS_USER_LIKE_COUNT) + 1;
    this.userDefaults.set(WP_RATINGS_USER_LIKE_COUNT, userLikeCount);
    this.userDefaults.set(WP_RATINGS_LIKED_CURRENT_VERSION, true);
    this.userDefaults.set(WP_RATINGS_NUMBER_OF_VERSIONS_TO_SKIP_PROMPTING, this.likeSkipVersions);
  }

  /** Enough significant events, not skipped for this release, not disabled, not too soon. */
  shouldPromptForAppReview(): boolean {
    if (this.interactedWithReviewPrompt() || this.skipRatingCurrentVersion() || this.ratingsDisabled ||
      !this.enoughDaysElapsed()) {
      return false;
    }
    const shouldPrompt = this.eventCount() >= this.significantEventsCount;
    if (shouldPrompt) {
      this.markAsPrompted();
    }
    return shouldPrompt;
  }

  hasUserEverLikedApp(): boolean {
    return this.userDefaults.integer(WP_RATINGS_USER_LIKE_COUNT) > 0;
  }

  hasUserEverDislikedApp(): boolean {
    return this.userDefaults.integer(WP_RATINGS_USER_DISLIKE_COUNT) > 0;
  }

  // MARK: - Private Helpers

  private interactedWithReviewPrompt(): boolean {
    const d = this.userDefaults;
    return d.bool(WP_RATINGS_RATED_CURRENT_VERSION) ||
      d.bool(WP_RATINGS_DECLINED_TO_RATE_CURRENT_VERSION) ||
      d.bool(WP_RATINGS_GAVE_FEEDBACK_FOR_CURRENT_VERSION) ||
      d.bool(WP_RATINGS_LIKED_CURRENT_VERSION) ||
      d.bool(WP_RATINGS_DISLIKED_CURRENT_VERSION);
  }

  private skipRatingCurrentVersion(): boolean {
    return this.userDefaults.bool(WP_RATINGS_SKIP_RATING_CURRENT_VERSION);
  }

  private eventCount(): number {
    return this.userDefaults.integer(WP_RATINGS_SIGNIFICANT_EVENT_COUNT);
  }

  private enoughDaysElapsed(): boolean {
    const currentVersion = this.userDefaults.string(WP_RATINGS_CURRENT_VERSION);
    const lastVersionReviewed = this.userDefaults.string(WP_RATINGS_LAST_REVIEW_VERSION);
    // Proceed if: the app was never reviewed OR we've already prompted for this version
    if (lastVersionReviewed === null || currentVersion === lastVersionReviewed) {
      return true;
    }
    const lastReviewTime = this.userDefaults.number(WP_RATINGS_LAST_REVIEW_DATE) ?? 0;
    const delta = daysBetweenDate(new Date(lastReviewTime), new Date());
    return delta >= this.minimumIntervalDays;
  }

  private markAsPrompted(): void {
    const currentVersion = this.userDefaults.string(WP_RATINGS_CURRENT_VERSION);
    const lastVersionReviewed = this.userDefaults.string(WP_RATINGS_LAST_REVIEW_VERSION);
    // Mark just once per version
    if (currentVersion === lastVersionReviewed) {
      return;
    }
    this.userDefaults.set(WP_RATINGS_LAST_REVIEW_VERSION, currentVersion);
    this.userDefaults.set(WP_RATINGS_LAST_REVIEW_DATE, Date.now());
  }
}

/** SPRatingsHelper: the remote Settings entity drives the thresholds; only signed-in users are prompted. */
export class SPRatingsHelper extends WPRatingsHelper {
  private static instance: SPRatingsHelper | null = null;

  /** +sharedInstance */
  static sharedInstance(): SPRatingsHelper {
    if (SPRatingsHelper.instance === null) {
      SPRatingsHelper.instance = new SPRatingsHelper();
    }
    return SPRatingsHelper.instance;
  }

  /// The port launches Simperium asynchronously, so the list page can appear before -setupAppRatings has run
  /// (iOS runs it in didFinishLaunching, before the list's viewDidAppear). The list re-checks through this.
  onInitialized: (() => void) | null = null;

  initializeForVersion(version: string): void {
    super.initializeForVersion(version);
    if (this.onInitialized !== null) {
      this.onInitialized();
    }
  }

  reloadSettings(): void {
    const simperium = Simperium.shared;
    if (simperium === null) {
      return;
    }
    const object = simperium.settingsBucket.objectForKey(SPCredentials.SIMPERIUM_SETTINGS_OBJECT_KEY);
    if (!(object instanceof Settings)) {
      return;
    }
    const settings = object as Settings;
    const ratings = SPRatingsHelper.sharedInstance();
    ratings.ratingsDisabled = (settings.ratings_disabled ?? 0) !== 0;
    ratings.significantEventsCount = settings.minimum_events ?? 0;
    ratings.minimumIntervalDays = settings.minimum_interval_days ?? 0;
    ratings.likeSkipVersions = settings.like_skip_versions ?? 0;
    ratings.declineSkipVersions = settings.decline_skip_versions ?? 0;
    ratings.dislikeSkipVersions = settings.dislike_skip_versions ?? 0;
  }

  shouldPromptForAppReview(): boolean {
    const simperium = Simperium.shared;
    const authenticated = simperium !== null && simperium.user !== null && simperium.user.authenticated();
    return super.shouldPromptForAppReview() && authenticated;
  }
}
