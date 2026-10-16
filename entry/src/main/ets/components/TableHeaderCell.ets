// Port of TableHeaderViewCell.swift: a non-selectable cell holding one title label (section header row).
// HarmonyOS list sub-header: sentence case, Subtitle_S medium, font_secondary.
import { LengthMetrics } from '@kit.ArkUI';

@Component
export struct TableHeaderViewCell {
  @Prop title: string = '';

  build() {
    Row() {
      Text(this.title)
        .fontSize($r('sys.float.Subtitle_S'))
        .fontWeight(FontWeight.Medium)
        .fontColor($r('sys.color.font_secondary'))
    }
    .width('100%')
    .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16), top: LengthMetrics.vp(16),
      bottom: LengthMetrics.vp(8) })
  }
}
