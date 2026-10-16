// Port of RoundedCrossButton.swift (a RoundedButton showing the `cross` image, in one of three
// styles). The caller supplies the source slug and the tap handler.
// Style (refreshStyle): standard = cardDismissButton background + tint, blue = blue30 / white,
// tagPill = tagPillDelete background tinted tagPillBackground. RoundedButton = full-round, 30pt.
import { hilog } from '@kit.PerformanceAnalysisKit';

export enum RoundedCrossButtonStyle {
  STANDARD = 0,
  BLUE = 1,
  TAG_PILL = 2
}

@Component
export struct RoundedCrossButton {
  /// The SOURCE control's accessibility identifier (Rule 12) — set on the tappable node itself.
  @Prop buttonId: string = '';
  @Prop crossStyle: RoundedCrossButtonStyle = RoundedCrossButtonStyle.STANDARD;
  /// Diameter (the verification/about screens pin it at 30pt).
  @Prop diameter: number = 30;
  /// Accessible name (About passes 'Close', History 'Dismiss History').
  @Prop label: Resource = $r('app.string.dismiss');
  onTap: () => void = (): void => {
    hilog.warn(0x0002, 'RoundedCrossButton', 'tap with no handler');
  };

  private backgroundFor(style: RoundedCrossButtonStyle): ResourceColor {
    if (style === RoundedCrossButtonStyle.BLUE) {
      return $r('app.color.simplenote_blue30');
    }
    if (style === RoundedCrossButtonStyle.TAG_PILL) {
      return $r('app.color.simplenote_tag_pill_delete_background');
    }
    return $r('app.color.simplenote_card_dismiss_button_background');
  }

  private tintFor(style: RoundedCrossButtonStyle): ResourceColor {
    if (style === RoundedCrossButtonStyle.BLUE) {
      return Color.White;
    }
    if (style === RoundedCrossButtonStyle.TAG_PILL) {
      return $r('app.color.simplenote_tag_pill_background');
    }
    return $r('app.color.simplenote_card_dismiss_button_tint');
  }

  build() {
    Button({ type: ButtonType.Circle, stateEffect: true }) {
      Image($r('app.media.ic_cross'))
        .width(this.diameter * 0.6)
        .height(this.diameter * 0.6)
        .objectFit(ImageFit.Contain)
        .fillColor(this.tintFor(this.crossStyle))
    }
    .id(this.buttonId)
    .width(this.diameter)
    .height(this.diameter)
    .backgroundColor(this.backgroundFor(this.crossStyle))
    .accessibilityText(this.label)
    .onClick((): void => {
      this.onTap();
    })
  }
}
