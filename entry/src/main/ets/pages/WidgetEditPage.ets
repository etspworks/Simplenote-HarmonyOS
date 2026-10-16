// The Edit Widget picker: NoteWidgetIntentHandler.provideNoteOptionsCollection (every note, by title) or
// ListWidgetIntentHandler.provideTagOptionsCollection (All Notes, then every tag). A tap saves the choice and
// redraws the widget and the sheet's preview; the launcher's OK closes the sheet.
import { common } from '@kit.AbilityKit';
import { formInfo, formProvider } from '@kit.FormKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { NOTE_WIDGET, WidgetController, WidgetStoreSnapshot } from '../common/WidgetController';
import { Note } from '../model/Note';

class WidgetOption {
  value: string;
  title: string;

  constructor(value: string, title: string) {
    this.value = value;
    this.title = title;
  }
}

@Entry({ useSharedStorage: true })
@Component
struct WidgetEditPage {
  @LocalStorageProp('formId') formId: string = '';
  @LocalStorageProp('previewFormId') previewFormId: string = '';
  @State formName: string = '';
  @State options: WidgetOption[] = [];
  @State selected: string | null = null;
  @State allNotesTitle: string = '';

  private context(): common.Context {
    return this.getUIContext().getSharedLocalStorage()?.get<common.Context>('context') as common.Context;
  }

  async aboutToAppear(): Promise<void> {
    try {
      const info: formInfo.RunningFormInfo = await formProvider.getPublishedRunningFormInfoById(this.formId);
      const context: common.Context = this.context();
      const store: WidgetStoreSnapshot = await WidgetController.loadStore(context);
      this.selected = WidgetController.selection(context, this.formId, info.formName);
      if (info.formName === NOTE_WIDGET) {
        this.options = WidgetController.visibleNotes(store.notes, WidgetController.freshDefaults(context))
          .map((note: Note): WidgetOption => {
            note.ensurePreviewStringsAreAvailable();
            return new WidgetOption(note.simperiumKey, note.titlePreview ?? '');
          });
      } else {
        this.allNotesTitle = context.resourceManager.getStringByNameSync('all_notes');
        this.selected = this.selected ?? '';
        this.options = [new WidgetOption('', this.allNotesTitle)]
          .concat(store.tagNames.map((name: string): WidgetOption => new WidgetOption(name, name)));
      }
      this.formName = info.formName;
      if (this.selected !== null && this.previewFormId !== '') {
        // The sheet's preview starts on the default; show the widget's current choice instead.
        await WidgetController.saveSelection(context, this.previewFormId, this.formName, this.selected);
      }
    } catch (e) {
      hilog.error(0x0001, 'WidgetEditPage', 'load %{public}s failed: %{public}s', this.formId, JSON.stringify(e));
    }
  }

  private async choose(value: string): Promise<void> {
    this.selected = value;
    for (const formId of [this.formId, this.previewFormId].filter((id: string): boolean => id !== '')) {
      try {
        await WidgetController.saveSelection(this.context(), formId, this.formName, value);
      } catch (e) {
        hilog.error(0x0001, 'WidgetEditPage', 'save %{public}s failed: %{public}s', formId, JSON.stringify(e));
      }
    }
  }

  build() {
    Column() {
      // HarmonyOS sheet title (the launcher hosts the sheet and its OK, so there is no close button here)
      Text(this.formName === NOTE_WIDGET ? $r('app.string.note') : $r('app.string.tag'))
        .fontSize($r('sys.float.Title_S'))
        .fontWeight(FontWeight.Bold)
        .fontColor($r('sys.color.font_primary'))
        .maxLines(1)
        .height(56)
        .padding({ left: 16, right: 16 })
        .width('100%')
      // One HarmonyOS card group with inset dividers
      List() {
        ListItemGroup({ style: ListItemGroupStyle.CARD }) {
          ForEach(this.options, (option: WidgetOption) => {
            ListItem({ style: ListItemStyle.CARD }) {
              Row({ space: 16 }) {
                Text(option.title)
                  .fontSize($r('sys.float.Body_L'))
                  .fontColor($r('sys.color.font_primary'))
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .layoutWeight(1)
                if (option.value === this.selected) {
                  SymbolGlyph($r('sys.symbol.checkmark'))
                    .fontSize(24)
                    .fontColor([$r('sys.color.icon_emphasize')])
                }
              }
              .constraintSize({ minHeight: 48 })
              .width('100%')
              .onClick(() => {
                this.choose(option.value);
              })
            }
          }, (option: WidgetOption) => option.value)
        }
        .divider({ strokeWidth: '1px', color: $r('sys.color.comp_divider'), startMargin: 8, endMargin: 8 })
      }
      .layoutWeight(1)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.background_secondary'))
  }
}
