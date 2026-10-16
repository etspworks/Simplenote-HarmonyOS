// Port of ActivityIndicatorButton.swift: a UIButton whose title is swapped for a centred activity
// indicator while `inProgress` is set; `isEnabled = !inProgress` (the source's didSet).
// Style (AccountVerificationViewController.refreshStyle): the primary button is filled
// simplenoteBlue50 with white title + white indicator and an 8pt corner radius; the secondary is
// clear with a simplenoteTint title. HarmonyOS: 40vp capsules, brand fill / font_emphasize text.
import { hilog } from '@kit.PerformanceAnalysisKit';

@Component
export struct ActivityIndicatorButton {
  @Prop title: string = '';
  /// The SOURCE control's accessibility identifier (Rule 12) — set on the tappable node itself.
  @Prop buttonId: string = '';
  @Prop inProgress: boolean = false;
  /// updateButtons(isEnabled:) — the caller disables both buttons while a request runs.
  @Prop isEnabled: boolean = true;
  /// Filled (primary) vs clear (secondary) appearance.
  @Prop isPrimary: boolean = true;
  onTap: () => void = (): void => {
    hilog.warn(0x0002, 'ActivityIndicatorButton', 'tap with no handler');
  };

  build() {
    Button({ type: ButtonType.Capsule, stateEffect: true }) {
      Stack() {
        Text(this.title)
          .fontSize($r('sys.float.Body_L'))
          .fontWeight(FontWeight.Medium)
          .fontColor(this.isPrimary ? $r('sys.color.font_on_primary') : $r('sys.color.font_emphasize'))
          .opacity(this.inProgress ? 0 : 1)
        if (this.inProgress) {
          LoadingProgress()
            .width(24)
            .height(24)
            .color(this.isPrimary ? $r('sys.color.font_on_primary') : $r('sys.color.font_primary'))
        }
      }
    }
    .id(this.buttonId)
    .width('100%')
    .height(40)
    .backgroundColor(this.isPrimary ? $r('sys.color.brand') : Color.Transparent)
    .enabled(this.isEnabled && !this.inProgress)
    .onClick((): void => {
      this.onTap();
    })
  }
}
