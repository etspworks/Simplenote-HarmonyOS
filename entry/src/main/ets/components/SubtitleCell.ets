// Port of SubtitleTableViewCell.swift: a .subtitle style cell — title (textLabel) over a detail value.
// Tap handling and the row id belong to the list that hosts it. HarmonyOS two-line row: 56vp, 16vp sides.
import { LengthMetrics } from '@kit.ArkUI';

@Component
export struct SubtitleTableViewCell {
  @Prop title: string = '';
  @Prop value: string = '';

  build() {
    Column({ space: 2 }) {
      // textLabel: body, simplenoteTextColor
      Text(this.title)
        .fontSize($r('sys.float.Body_L'))
        .fontColor($r('sys.color.font_primary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      // detailTextLabel: subheadline, simplenoteSecondaryTextColor
      Text(this.value)
        .fontSize($r('sys.float.Body_M'))
        .fontColor($r('sys.color.font_secondary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .justifyContent(FlexAlign.Center)
    .constraintSize({ minHeight: 56 })
    .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16), top: LengthMetrics.vp(8),
      bottom: LengthMetrics.vp(8) })
  }
}
