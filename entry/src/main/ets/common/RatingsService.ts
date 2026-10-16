// svc_ratings: the app-facing surface of SPRatingsHelper.m. The WordPress-Ratings-iOS port and the
// SPRatingsHelper subclass live in ./ratings/WPRatingsHelper.ts; this service is what screens call.
import { SPRatingsHelper } from './ratings/WPRatingsHelper';

export class RatingsService {
  private static instance: RatingsService | null = null;

  private readonly helper: SPRatingsHelper = SPRatingsHelper.sharedInstance();

  static shared(): RatingsService {
    if (RatingsService.instance === null) {
      RatingsService.instance = new RatingsService();
    }
    return RatingsService.instance;
  }

  /// -reloadSettings: pull thresholds from the synced Settings entity
  reloadSettings(): void {
    this.helper.reloadSettings();
  }

  /// -shouldPromptForAppReview: upstream thresholds AND a signed-in Simperium user
  shouldPromptForAppReview(): boolean {
    return this.helper.shouldPromptForAppReview();
  }

  get ratings(): SPRatingsHelper {
    return this.helper;
  }
}

export { SPRatingsHelper };
