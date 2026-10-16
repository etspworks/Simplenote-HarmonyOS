import { LengthMetrics } from '@kit.ArkUI';
// Port of SPRatingsPromptView (+ SPRatingsPromptView.xib): the list's table-header ratings prompt.
// Its three-state machine (initial / liked / disliked) lives here; each transition calls the
// host's SPRatingsPromptDelegate callbacks.
// Identifiers are the xib's own: the LEFT button carries 'ratings_prompt_decline' and the RIGHT
// 'ratings_prompt_accept' (sic, as declared in the source xib).
enum RatingsState {
  INITIAL = 0,
  LIKED = 1,
  DISLIKED = 2
}

const BUTTON_HEIGHT: number = 32;

@Component
export struct SPRatingsPromptView {
  @State private ratingsState: RatingsState = RatingsState.INITIAL;
  onLiked: (() => void) | null = null;
  onDisliked: (() => void) | null = null;
  onDisplayReview: (() => void) | null = null;
  onDisplayFeedback: (() => void) | null = null;
  onDismiss: (() => void) | null = null;

  private titleText(): string {
    if (this.ratingsState === RatingsState.LIKED) {
      return 'Great! Mind leaving a review to tell us what you like?';
    }
    if (this.ratingsState === RatingsState.DISLIKED) {
      return 'Could you tell us how we could improve?';
    }
    return 'What do you think about Simplenote?';
  }

  private leftTitle(): string {
    if (this.ratingsState === RatingsState.LIKED) {
      return 'Leave a review';
    }
    if (this.ratingsState === RatingsState.DISLIKED) {
      return 'Send feedback';
    }
    return 'I like it';
  }

  private rightTitle(): string {
    return this.ratingsState === RatingsState.INITIAL ? 'Could be better' : 'No thanks';
  }

  private run(callback: (() => void) | null): void {
    if (callback !== null) {
      callback();
    }
  }

  /// leftActionWasPressed
  private leftActionWasPressed(): void {
    if (this.ratingsState === RatingsState.INITIAL) {
      this.run(this.onLiked);
      this.ratingsState = RatingsState.LIKED;
    } else if (this.ratingsState === RatingsState.LIKED) {
      this.run(this.onDisplayReview);
    } else {
      this.run(this.onDisplayFeedback);
    }
  }

  /// rightActionWasPressed
  private rightActionWasPressed(): void {
    if (this.ratingsState === RatingsState.INITIAL) {
      this.run(this.onDisliked);
      this.ratingsState = RatingsState.DISLIKED;
    } else {
      this.run(this.onDismiss);
    }
  }

  build() {
    // SPRatingsPromptView.xib: vertical stack (spacing 15, max 320 wide, 20pt vertical inset) of the
    // headline message and two equal outlined buttons (spacing 10, 1pt tint border, 4pt corners).
    Column() {
      Column({ space: 15 }) {
        Text(this.titleText())
          .textAlign(TextAlign.Center)
          .fontSize($r('sys.float.Body_L'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.simplenote_note_headline'))
        Row({ space: 10 }) {
          Button(this.leftTitle(), { type: ButtonType.Normal, stateEffect: true })
            .id('ratings_prompt_decline')
            .layoutWeight(1)
            .height(BUTTON_HEIGHT)
            .fontSize($r('sys.float.Body_M'))
            .fontColor($r('app.color.simplenote_tint'))
            .backgroundColor(Color.Transparent)
            .borderWidth(1)
            .borderColor($r('app.color.simplenote_tint'))
            .borderRadius(4)
            .onClick(() => {
              this.leftActionWasPressed();
            })
          Button(this.rightTitle(), { type: ButtonType.Normal, stateEffect: true })
            .id('ratings_prompt_accept')
            .layoutWeight(1)
            .height(BUTTON_HEIGHT)
            .fontSize($r('sys.float.Body_M'))
            .fontColor($r('app.color.simplenote_tint'))
            .backgroundColor(Color.Transparent)
            .borderWidth(1)
            .borderColor($r('app.color.simplenote_tint'))
            .borderRadius(4)
            .onClick(() => {
              this.rightActionWasPressed();
            })
        }
        .width('100%')
      }
      .width('100%')
      .constraintSize({ maxWidth: 320 })
      .alignItems(HorizontalAlign.Center)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Center)
    .padding({ top: LengthMetrics.vp(20), bottom: LengthMetrics.vp(20), start: LengthMetrics.vp(10), end: LengthMetrics.vp(10) })
  }
}
