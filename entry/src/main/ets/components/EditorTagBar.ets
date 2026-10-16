// Port of NoteEditorTagListViewController (+ its TagView / TagViewCell / SPTagEntryField): the
// editor's bottom tag bar — a horizontally scrolling row of tag chips followed by the 'Tag…' entry
// field. Tapping a chip toggles its delete (cross) button, which auto-hides after 4 s; typing a
// space / comma / return (or ending editing) turns the field text into a tag.
import { LengthMetrics } from '@kit.ArkUI';
import { InterlinkRect } from '../common/InterlinkService';

/// Constants.autohideDeleteButtonTimeout
const AUTOHIDE_DELETE_BUTTON_TIMEOUT_MS: number = 4000;
/// SPTagEntryField / TagTextFieldInputValidator length limit
const MAXIMUM_TAG_LENGTH: number = 256;

@Component
export struct NoteEditorTagListViewController {
  /// note.tagsArray filtered !isValidEmailAddress (reload())
  @Prop tagNames: string[] = [];
  /// addTagField.text
  @Link addTagFieldText: string;
  @State private deleteButtonTag: string = '';
  private autohideTimer: number = -1;
  /// tagView(_:wantsToCreateTagWithName:)
  onCreateTag: (tagName: string) => void = (tagName: string): void => {
    this.addTagFieldText = '';
  };
  /// tagView(_:wantsToRemoveTagWithName:)
  onRemoveTag: (tagName: string) => void = (tagName: string): void => {
    this.hideDeleteButton();
  };
  /// tagViewDidBeginEditing(_:) / tagViewDidChange(_:) — the entry field's window frame is the popover anchor
  onEditing: (entryFieldFrame: InterlinkRect) => void = (entryFieldFrame: InterlinkRect): void => {
    this.hideDeleteButton();
  };
  private entryFieldFrame: InterlinkRect = new InterlinkRect(0, 0, 0, 0);

  aboutToDisappear(): void {
    this.clearAutohideTimer();
  }

  // MARK: - Delete button

  private toggleDeleteButton(tagName: string): void {
    const show: boolean = this.deleteButtonTag !== tagName;
    this.hideDeleteButton();
    if (!show) {
      return;
    }
    this.deleteButtonTag = tagName;
    this.autohideTimer = setTimeout((): void => {
      this.autohideTimer = -1;
      this.hideDeleteButton();
    }, AUTOHIDE_DELETE_BUTTON_TIMEOUT_MS);
  }

  private hideDeleteButton(): void {
    this.clearAutohideTimer();
    this.deleteButtonTag = '';
  }

  private clearAutohideTimer(): void {
    if (this.autohideTimer >= 0) {
      clearTimeout(this.autohideTimer);
      this.autohideTimer = -1;
    }
  }

  // MARK: - Entry field

  /// validateInput(_:range:replacement:) — whitespace / comma end the tag, embedded ones are rejected.
  private handleEntryChange(value: string): void {
    const lastCharacter: string = value.length > 0 ? value.charAt(value.length - 1) : '';
    const endsWithDisallowed: boolean = lastCharacter === ' ' || lastCharacter === ',' || lastCharacter === '\n';
    const body: string = endsWithDisallowed ? value.substring(0, value.length - 1) : value;
    const cleaned: string = body.replace(new RegExp('[\\s,]', 'g'), '').substring(0, MAXIMUM_TAG_LENGTH);
    this.addTagFieldText = cleaned;
    if (endsWithDisallowed) {
      this.processTextInFieldToTag();
      return;
    }
    this.hideDeleteButton();
    this.onEditing(this.entryFieldFrame);
  }

  /// processTextInFieldToTag()
  processTextInFieldToTag(): void {
    const tagName: string = this.addTagFieldText;
    if (tagName.length === 0) {
      return;
    }
    this.onCreateTag(tagName);
    this.addTagFieldText = '';
  }

  // MARK: - Views

  /// TagViewCell: tag title + (while toggled) the delete cross
  @Builder
  tagCell(tagName: string) {
    Row({ space: 4 }) {
      Text(tagName)
        .fontSize($r('sys.float.Body_M'))
        .fontColor($r('sys.color.font_primary'))
        .maxLines(1)
      if (this.deleteButtonTag === tagName) {
        // HarmonyOS chip delete: a 16vp xmark symbol in a 24vp hit area
        Button({ type: ButtonType.Circle, stateEffect: true }) {
          SymbolGlyph($r('sys.symbol.xmark'))
            .fontSize(16)
            .fontColor([$r('sys.color.icon_secondary')])
        }
        .id('tag_view_cell_delete')
        .width(24)
        .height(24)
        .backgroundColor(Color.Transparent)
        .accessibilityText($r('app.string.dismiss'))
        .onClick((): void => {
          this.hideDeleteButton();
          this.onRemoveTag(tagName);
        })
      }
    }
    // HarmonyOS chip: 32vp capsule on the control fill
    .height(32)
    .padding({ start: LengthMetrics.vp(12), end: LengthMetrics.vp(this.deleteButtonTag === tagName ? 4 : 12) })
    .constraintSize({ minWidth: 39 })
    .justifyContent(FlexAlign.Center)
    .borderRadius(16)
    .backgroundColor($r('sys.color.comp_background_tertiary'))
    .id('tag_view_cell_itemroot')
    .onClick((): void => {
      this.toggleDeleteButton(tagName);
    })
  }

  build() {
    Scroll() {
      // TagView: wrapping stack spacing 16, side margins 20
      Row({ space: 16 }) {
        // stackView (hidden while empty)
        if (this.tagNames.length > 0) {
          Row({ space: 8 }) {
            ForEach(this.tagNames, (tagName: string) => {
              this.tagCell(tagName)
            }, (tagName: string): string => tagName)
          }
        }
        // addTagField (SPTagEntryField, placeholder 'Tag…')
        TextInput({ placeholder: $r('app.string.tag_3'), text: this.addTagFieldText })
          .fontSize($r('sys.float.Body_M'))
          .fontColor($r('app.color.simplenote_text'))
          .placeholderColor($r('sys.color.font_tertiary'))
          .placeholderFont({ size: $r('sys.float.Body_M') })
          .caretColor($r('app.color.simplenote_tint'))
          .backgroundColor(Color.Transparent)
          .padding(0)
          .constraintSize({ minWidth: 80 })
          .onChange((value: string): void => {
            this.handleEntryChange(value);
          })
          .onSubmit((): void => {
            this.processTextInFieldToTag();
          })
          .onEditChange((isEditing: boolean): void => {
            if (isEditing) {
              this.hideDeleteButton();
              this.onEditing(this.entryFieldFrame);
            } else {
              this.hideDeleteButton();
              this.processTextInFieldToTag();
            }
          })
          .onAreaChange((oldValue: Area, newValue: Area): void => {
            this.entryFieldFrame = new InterlinkRect(Number(newValue.globalPosition.x ?? 0),
              Number(newValue.globalPosition.y ?? 0), Number(newValue.width), Number(newValue.height));
          })
      }
    }
    .scrollable(ScrollDirection.Horizontal)
    .scrollBar(BarState.Off)
    .width('100%')
    .padding({ start: LengthMetrics.vp(20), end: LengthMetrics.vp(20), top: LengthMetrics.vp(12),
      bottom: LengthMetrics.vp(12) })
    .align(Alignment.Start)
    .backgroundColor($r('app.color.simplenote_background'))
  }
}
