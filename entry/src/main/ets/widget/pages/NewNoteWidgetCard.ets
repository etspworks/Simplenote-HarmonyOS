// NewNoteWidgetView: static card, a tap opens a new note (simplenote://widgetNew).
@Entry
@Component
struct NewNoteWidgetCard {
  build() {
    FormLink({ action: 'router', abilityName: 'EntryAbility', uri: 'simplenote://widgetNew',
      params: { 'url': 'simplenote://widgetNew' } }) {
      Column() {
        Image($r('app.media.ic_new_note'))
          .width(48)
          .height(48)
          .fillColor(Color.White)
        Blank()
        Text($r('app.string.new_note_4'))
          .fontSize(17)
          .fontWeight(FontWeight.Medium)
          .fontColor(Color.White)
      }
      .alignItems(HorizontalAlign.Start)
      .padding(16)
      .width('100%')
      .height('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.studio_sp_blue50'))
  }
}
