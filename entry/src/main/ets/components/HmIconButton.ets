// HarmonyOS title-bar icon button: a 40vp circle with a 24vp system symbol, drawn in the system title-bar
// colours, for menus that must keep their test ids (Navigation's NavigationMenuItem has no id).
@Component
export struct HmIconButton {
  symbol: Resource = $r('sys.symbol.dot_grid_2x2');
  @Prop label: string = '';
  /// Test id, set on the Button itself (an id on the custom component does not reach the tappable node).
  buttonId: string = '';
  @Prop isEnabled: boolean = true;
  @Prop tint: ResourceColor = $r('sys.color.titlebar_icon_color');
  action: () => void = () => {
  };

  build() {
    Button({ type: ButtonType.Circle, stateEffect: true }) {
      SymbolGlyph(this.symbol)
        .fontSize(24)
        .fontColor([this.tint])
    }
    .width(40)
    .height(40)
    .backgroundColor($r('sys.color.titlebar_icon_background_color'))
    .id(this.buttonId)
    .enabled(this.isEnabled)
    .opacity(this.isEnabled ? 1 : 0.4)
    .accessibilityText(this.label)
    .onClick(() => this.action())
  }
}
