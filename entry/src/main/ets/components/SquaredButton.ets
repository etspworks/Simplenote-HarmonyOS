// Port of SPSquaredButton.swift: a plain UIButton subclass whose only addition is a default corner
// radius (4pt). The caller supplies the title, the source accessibility slug, the tap handler and
// the per-call-site colours the source sets on each outlet (filled tint / WordPress blue / outlined).
import { hilog } from '@kit.PerformanceAnalysisKit';

/// SPSquaredButton.defaultCornerRadius
const DEFAULT_CORNER_RADIUS: number = 4;
/// Every SPSquaredButton in the xibs is pinned to a 44pt height.
const DEFAULT_HEIGHT: number = 44;

@Component
export struct SPSquaredButton {
  @Prop title: string = '';
  /// The SOURCE control's accessibility identifier (Rule 12) — set on the tappable node itself.
  @Prop buttonId: string = '';
  @Prop fillColor: ResourceColor = $r('app.color.simplenote_blue50');
  @Prop titleColor: ResourceColor = Color.White;
  @Prop buttonOutlineWidth: number = 0;
  @Prop buttonOutlineColor: ResourceColor = Color.Transparent;
  onTap: () => void = (): void => {
    hilog.warn(0x0002, 'SPSquaredButton', 'tap with no handler');
  };

  build() {
    Button(this.title, { type: ButtonType.Normal, stateEffect: true })
      .id(this.buttonId)
      .width('100%')
      .height(DEFAULT_HEIGHT)
      .borderRadius(DEFAULT_CORNER_RADIUS)
      .backgroundColor(this.fillColor)
      .fontColor(this.titleColor)
      // UICTFontTextStyleHeadline (17pt semibold)
      .fontSize($r('sys.float.Body_L'))
      .fontWeight(FontWeight.Medium)
      .border({ width: this.buttonOutlineWidth, color: this.buttonOutlineColor, radius: DEFAULT_CORNER_RADIUS })
      .onClick((): void => {
        this.onTap();
      })
  }
}
