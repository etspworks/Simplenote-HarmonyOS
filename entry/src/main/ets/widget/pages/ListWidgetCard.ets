// ListWidgetView (+ ListWidgetHeaderView, NoteListRow, WidgetWarningView): a tag header with a new-note
// button, then the first notes of that list. Every element is its own link.
let listWidgetStorage: LocalStorage = new LocalStorage();

interface WidgetRow {
  title: string;
  url: string;
}

@Entry(listWidgetStorage)
@Component
struct ListWidgetCard {
  @LocalStorageProp('state') state: string = '';
  @LocalStorageProp('tagTitle') tagTitle: string = '';
  @LocalStorageProp('tagUrl') tagUrl: string = '';
  @LocalStorageProp('newNoteUrl') newNoteUrl: string = '';
  @LocalStorageProp('rows') rows: WidgetRow[] = [];

  /// Dynamic-widget tap: a router event to EntryAbility; DeepLinkRouter reads params.url.
  private open(url: string): void {
    postCardAction(this, { action: 'router', abilityName: 'EntryAbility', params: { 'url': url } });
  }

  build() {
    if (this.state === '') {
      Column().width('100%').height('100%').backgroundColor($r('app.color.simplenote_widget_background'))
    } else if (this.state !== 'standard') {
      Text(this.state === 'loggedOut' ? $r('app.string.log_in_to_see_your_notes') :
        $r('app.string.tag_no_longer_available'))
        .fontSize(15)
        .fontColor($r('app.color.simplenote_secondary_text'))
        .textAlign(TextAlign.Center)
        .width('100%')
        .height('100%')
        .padding(16)
        .backgroundColor($r('app.color.simplenote_widget_background'))
        .onClick(() => this.open('simplenote://'))
    } else {
      Column() {
        Row() {
          Text(this.tagTitle.length > 0 ? this.tagTitle : $r('app.string.all_notes'))
            .fontSize(17)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.simplenote_text'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
            .onClick(() => this.open(this.tagUrl))
          Image($r('app.media.ic_new_note'))
            .width(24)
            .height(24)
            .fillColor($r('app.color.simplenote_tint'))
            .onClick(() => this.open(this.newNoteUrl))
        }
        .width('100%')
        .padding({ top: 5, bottom: 5 })
        ForEach(this.rows, (row: WidgetRow, index: number) => {
          Column() {
            Text(row.title)
              .fontSize(15)
              .fontColor($r('app.color.simplenote_text'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')
              .layoutWeight(1)
            Divider()
              .color($r('app.color.simplenote_divider'))
              .opacity(index === this.rows.length - 1 ? 0 : 1)
          }
          .width('100%')
          .layoutWeight(1)
          .onClick(() => {
            if (row.url !== '') {
              this.open(row.url);
            }
          })
        }, (row: WidgetRow, index: number) => `${index}:${row.url}`)
      }
      .alignItems(HorizontalAlign.Start)
      .padding({ left: 20, right: 20, bottom: 8 })
      .width('100%')
      .height('100%')
      .backgroundColor($r('app.color.simplenote_widget_background'))
    }
  }
}
