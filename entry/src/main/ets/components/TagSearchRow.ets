// Port of SPTagTableViewCell as used by the notes list's "Search by Tag" section: tag glyph + 'tag:<name>'.
import { LengthMetrics } from '@kit.ArkUI';

@Component
export struct SPTagTableViewCell {
  @Prop titleText: string = '';

  build() {
    Row() {
      Image($r('app.media.ic_tag'))
        .width(24)
        .height(24)
        .objectFit(ImageFit.Contain)
        .fillColor($r('app.color.simplenote_note_share_status_image'))
      Text(this.titleText)
        .fontSize($r('sys.float.Body_L'))
        .fontColor($r('app.color.simplenote_text'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
        .margin({ start: LengthMetrics.vp(16) })
    }
    .width('100%')
    .constraintSize({ minHeight: 44 })
    .padding({ start: LengthMetrics.vp(28), end: LengthMetrics.vp(16), top: LengthMetrics.vp(12), bottom: LengthMetrics.vp(12) })
  }
}
