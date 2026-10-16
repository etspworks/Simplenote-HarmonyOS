// Port of SPTagHeaderView.swift (+ .xib): leading title label, trailing action button.
// HarmonyOS list-group header: Subtitle_S / font_secondary title and a symbol edit toggle
// (square_and_pencil = Edit, checkmark = Done) carrying the action id (tag_list_edit).
import { LengthMetrics } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { HmIconButton } from './HmIconButton';

@Component
export struct SPTagHeaderView {
  @Prop title: string = '';
  /// Accessibility label of the action ('Edit' / 'Done')
  @Prop actionTitle: string = '';
  /// Editing: the action shows Done (checkmark) instead of Edit (square_and_pencil)
  @Prop isEditing: boolean = false;
  /// The SOURCE button's accessibilityIdentifier (Rule 12)
  @Prop actionId: string = '';
  onAction: () => void = (): void => {
    hilog.warn(0x0002, 'SPTagHeaderView', 'action with no handler');
  };

  build() {
    Row({ space: 8 }) {
      Text(this.title)
        .fontSize($r('sys.float.Subtitle_S'))
        .fontWeight(FontWeight.Medium)
        .fontColor($r('sys.color.font_secondary'))
        .layoutWeight(1)
      // HmIconButton's symbol is not reactive: one instance per state.
      if (this.isEditing) {
        HmIconButton({
          symbol: $r('sys.symbol.checkmark'),
          label: this.actionTitle,
          buttonId: this.actionId,
          action: (): void => this.onAction()
        })
      } else {
        HmIconButton({
          symbol: $r('sys.symbol.square_and_pencil'),
          label: this.actionTitle,
          buttonId: this.actionId,
          action: (): void => this.onAction()
        })
      }
    }
    .width('100%')
    .constraintSize({ minHeight: 48 })
    .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(8) })
    .backgroundColor($r('sys.color.background_primary'))
  }
}
