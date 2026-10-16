// Port of SearchDisplayController + SPSearchBar: the list's search field.
// Focusing the field begins search mode (searchBarShouldBeginEditing -> updateStatus(active: true));
// every edit reports the keyword (textDidChange); a back arrow ('Cancel') is shown only while active and dismisses.
// setEnabled(false) (multi-select mode) blocks interaction.
// Styled as the HarmonyOS Search field: 40vp capsule on comp_background_tertiary, magnifyingglass symbol,
// symbol clear button. It stays a TextInput so the placeholder Text, onEditChange and the ids are unchanged.
import { LengthMetrics, SymbolGlyphModifier } from '@kit.ArkUI';

const SEARCH_FIELD_HEIGHT: number = 40;

@Component
export struct SearchDisplayController {
  @Link text: string;
  @Prop active: boolean = false;
  @Prop searchEnabled: boolean = true;
  onBeginSearch: (() => void) | null = null;
  onUpdateSearchResults: ((keyword: string) => void) | null = null;
  onCancel: (() => void) | null = null;
  /// searchBar.isFirstResponder: the field has the keyboard.
  onEditingChange: ((editing: boolean) => void) | null = null;

  build() {
    Row() {
      if (this.active) {
        // keyboardStopSearching: Escape. Cmd(Ctrl)+Shift+F lives on the list page, which also starts the search.
        Button({ type: ButtonType.Circle, stateEffect: true }) {
          SymbolGlyph($r('sys.symbol.arrow_left'))
            .fontSize(24)
            .fontColor([$r('sys.color.icon_primary')])
        }
        .id('search_cancel')
        .width(40)
        .height(40)
        .backgroundColor(Color.Transparent)
        .margin({ end: LengthMetrics.vp(8) })
        .accessibilityText('Cancel')
        .keyboardShortcut(FunctionKey.ESC, [])
        .onClick(() => {
          if (this.onCancel !== null) {
            this.onCancel();
          }
        })
      }
      Row() {
        SymbolGlyph($r('sys.symbol.magnifyingglass'))
          .fontSize(16)
          .fontColor([this.searchEnabled ? $r('sys.color.icon_secondary') : $r('sys.color.icon_tertiary')])
          .margin({ start: LengthMetrics.vp(12) })
        // UISearchBar draws its placeholder as visible text; ArkUI's placeholder attribute never
        // reaches the accessibility tree, so the empty-state prompt is a Text over the field.
        Stack({ alignContent: Alignment.Start }) {
          TextInput({ text: this.text })
            .id('search-bar')
            .width('100%')
            .height(SEARCH_FIELD_HEIGHT)
            .backgroundColor(Color.Transparent)
            .borderRadius(0)
            .padding({ start: LengthMetrics.vp(6), end: LengthMetrics.vp(8) })
            .fontSize($r('sys.float.Body_L'))
            .fontColor($r('sys.color.font_primary'))
            .caretColor($r('sys.color.brand'))
            .cancelButton({
              style: CancelButtonStyle.INPUT,
              icon: new SymbolGlyphModifier($r('sys.symbol.xmark_circle_fill'))
                .fontColor([$r('sys.color.icon_tertiary')])
            })
            .enterKeyType(EnterKeyType.Search)
            .enabled(this.searchEnabled)
            .onEditChange((isEditing: boolean) => {
              if (this.onEditingChange !== null) {
                this.onEditingChange(isEditing);
              }
              if (isEditing && !this.active && this.onBeginSearch !== null) {
                this.onBeginSearch();
              }
            })
            .onChange((value: string) => {
              if (value === this.text) {
                return;
              }
              this.text = value;
              if (this.onUpdateSearchResults !== null) {
                this.onUpdateSearchResults(value);
              }
            })
            if (this.text.length === 0) {
              Text('Search notes or tags')
                .fontSize($r('sys.float.Body_L'))
                .fontColor(this.searchEnabled ? $r('sys.color.font_secondary') : $r('sys.color.font_fourth'))
                .padding({ start: LengthMetrics.vp(6) })
                .hitTestBehavior(HitTestMode.None)
            }
        }
        .layoutWeight(1)
        .height(SEARCH_FIELD_HEIGHT)
      }
      .layoutWeight(1)
      .height(SEARCH_FIELD_HEIGHT)
      .borderRadius(SEARCH_FIELD_HEIGHT / 2)
      .backgroundColor($r('sys.color.comp_background_tertiary'))
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    // 16vp screen margin; 8vp below the title bar.
    .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16), top: LengthMetrics.vp(4), bottom: LengthMetrics.vp(8) })
  }
}
