// Port of SPCardPresentationController / SPCardTransitioningManager / SPCardView: a card anchored to
// the bottom of the host, with rounded top corners, dismissed by swiping down (the host presents it
// with .bindSheet, which supplies the swipe-to-dismiss and the 32vp system corner rounding). This is
// now a plain container on background_primary; the sheet does the rounding.

/// SPCardDismissalReason
export enum SPCardDismissalReason {
  SWIPE_DOWN = 0,
  OUTSIDE_TAP = 1
}

@Component
export struct SPCardPresentationController {
  @BuilderParam content: () => void = this.emptyContent;

  @Builder
  emptyContent() {
  }

  build() {
    Column() {
      this.content()
    }
    .width('100%')
    .backgroundColor($r('sys.color.background_primary'))
  }
}
