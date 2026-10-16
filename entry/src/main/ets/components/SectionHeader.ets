// Port of SPSectionHeaderView: the title of a notes-list section ('Search by Tag' / 'Notes').
// HarmonyOS list sub-header: sentence case, Subtitle_S medium, font_secondary, on the list's own background.
import { LengthMetrics } from '@kit.ArkUI';

@Component
export struct SPSectionHeaderView {
  @Prop title: string = '';

  build() {
    Row() {
      Text(this.title)
        .fontSize($r('sys.float.Subtitle_S'))
        .fontWeight(FontWeight.Medium)
        .fontColor($r('sys.color.font_secondary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16), top: LengthMetrics.vp(16), bottom: LengthMetrics.vp(8) })
  }
}
