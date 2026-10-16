// Port of Value1TableViewCell.swift: a UITableViewCell (.value1 style) — optional icon, title,
// trailing detail value and optional disclosure chevron. `selectable` only dims the text (the row
// still reports taps, as the source's table delegate does). HarmonyOS list row: 48vp, 16vp sides, Body_L title,
// Body_M secondary value, chevron_right symbol; the background comes from the container (card or page).
import { LengthMetrics } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';

@Component
export struct Value1TableViewCell {
  /// The SOURCE cell's accessibilityIdentifier (Rule 12)
  @Prop cellId: string = '';
  @Prop title: ResourceStr = '';
  @Prop value: string = '';
  @Prop icon: Resource | null = null;
  /// A sys.symbol leading glyph (used instead of `icon` when set), tinted like the icon.
  @Prop symbol: Resource | null = null;
  /// Title colour override (e.g. sys.color.warning for a destructive row); dimmed rows ignore it.
  @Prop titleColor: ResourceColor | undefined = undefined;
  /// Opt-in system pressed state (card rows); off for callers that paint their own selection.
  @Prop pressEffect: boolean = false;
  @Prop selectable: boolean = true;
  /// Kept for callers; the row never paints its own background now.
  @Prop hasClearBackground: boolean = false;
  /// accessoryType = .disclosureIndicator
  @Prop showsDisclosure: boolean = false;
  /// imageTintColor (nil -> textColor)
  @Prop imageTintColor: ResourceColor | undefined = undefined;
  onTap: () => void = (): void => {
    hilog.warn(0x0002, 'Value1TableViewCell', 'tap with no handler');
  };

  build() {
    Row({ space: 16 }) {
      if (this.symbol !== null) {
        SymbolGlyph(this.symbol as Resource)
          .fontSize(24)
          .fontColor([this.imageTintColor ??
            (this.selectable ? $r('sys.color.icon_primary') : $r('sys.color.icon_tertiary'))])
          .accessibilityLevel('no')
      } else if (this.icon !== null) {
        // imageTintColor ?? textColor
        Image(this.icon as Resource)
          .width(24)
          .height(24)
          .objectFit(ImageFit.Contain)
          .fillColor(this.imageTintColor ??
            (this.selectable ? $r('sys.color.icon_primary') : $r('sys.color.icon_tertiary')))
          .accessibilityLevel('no')
      }
      Text(this.title)
        .fontSize($r('sys.float.Body_L'))
        .fontColor(this.selectable ? (this.titleColor ?? $r('sys.color.font_primary')) : $r('sys.color.font_tertiary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      if (this.value.length > 0) {
        Text(this.value)
          .fontSize($r('sys.float.Body_M'))
          .fontColor(this.selectable ? $r('sys.color.font_secondary') : $r('sys.color.font_tertiary'))
          .maxLines(1)
      }
      if (this.showsDisclosure) {
        SymbolGlyph($r('sys.symbol.chevron_right'))
          .fontSize(20)
          .fontColor([$r('sys.color.icon_tertiary')])
          .accessibilityLevel('no')
      }
    }
    .id(this.cellId)
    .width('100%')
    .constraintSize({ minHeight: 48 })
    .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16) })
    .stateStyles({
      normal: {
        .backgroundColor(Color.Transparent)
      },
      pressed: {
        .backgroundColor(this.pressEffect ? $r('sys.color.interactive_pressed') : Color.Transparent)
      }
    })
    .onClick((): void => {
      this.onTap();
    })
  }
}
