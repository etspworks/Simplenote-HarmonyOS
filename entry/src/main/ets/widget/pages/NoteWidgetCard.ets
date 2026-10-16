// NoteWidgetView (+ WidgetWarningView): the note's title and body; a tap opens it.
let noteWidgetStorage: LocalStorage = new LocalStorage();

@Entry(noteWidgetStorage)
@Component
struct NoteWidgetCard {
  @LocalStorageProp('state') state: string = '';
  @LocalStorageProp('noteTitle') noteTitle: string = '';
  @LocalStorageProp('noteBody') noteBody: string = '';
  @LocalStorageProp('noteUrl') noteUrl: string = '';

  build() {
    if (this.state === '') {
      Column().width('100%').height('100%').backgroundColor($r('app.color.simplenote_widget_background'))
    } else if (this.state !== 'standard') {
      // WidgetWarningView: a tap opens Simplenote.
      FormLink({ action: 'router', abilityName: 'EntryAbility', uri: 'simplenote://',
        params: { 'url': 'simplenote://' } }) {
        Text(this.state === 'loggedOut' ? $r('app.string.log_in_to_see_your_notes') :
          $r('app.string.note_no_longer_available'))
          .fontSize(15)
          .fontColor($r('app.color.simplenote_secondary_text'))
          .textAlign(TextAlign.Center)
          .width('100%')
          .height('100%')
          .padding(16)
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('app.color.simplenote_widget_background'))
    } else {
      FormLink({ action: 'router', abilityName: 'EntryAbility', uri: this.noteUrl,
        params: { 'url': this.noteUrl } }) {
        Column({ space: 4 }) {
          Text(this.noteTitle)
            .fontSize(17)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.simplenote_text'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(this.noteBody)
            .fontSize(15)
            .fontColor($r('app.color.simplenote_text'))
            .layoutWeight(1)
            .align(Alignment.TopStart)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .alignItems(HorizontalAlign.Start)
        .padding({ left: 16, right: 16, top: 16 })
        .width('100%')
        .height('100%')
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('app.color.simplenote_widget_background'))
    }
  }
}
