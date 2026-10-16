// Port of SwitchTableViewCell.swift: icon + title with a UISwitch accessory. Tapping anywhere on the
// cell flips the switch (contentWasPressed); either path reports the new state through onChange.
// HarmonyOS list row: 48vp, 16vp sides, Body_L title, system-coloured Toggle, container background.

import { LengthMetrics } from '@kit.ArkUI';

@Component
export struct SwitchTableViewCell {
  /// The SOURCE cell's accessibilityIdentifier (Rule 12)
  @Prop cellId: string = '';
  @Prop title: ResourceStr = '';
  @Prop icon: Resource | null = null;
  /// A sys.symbol leading glyph (used instead of `icon` when set).
  @Prop symbol: Resource | null = null;
  /// Opt-in system pressed state (card rows); off for callers that paint their own selection.
  @Prop pressEffect: boolean = false;
  @Prop isOn: boolean = false;
  onChange: (isOn: boolean) => void = (isOn: boolean): void => {
    this.isOn = isOn;
  };

  /// contentWasPressed
  private contentWasPressed(): void {
    this.isOn = !this.isOn;
    this.onChange(this.isOn);
  }

  build() {
    Row({ space: 16 }) {
      if (this.symbol !== null) {
        SymbolGlyph(this.symbol as Resource)
          .fontSize(24)
          .fontColor([$r('sys.color.icon_primary')])
          .accessibilityLevel('no')
      } else if (this.icon !== null) {
        Image(this.icon as Resource)
          .width(24)
          .height(24)
          .objectFit(ImageFit.Contain)
          .fillColor($r('sys.color.icon_primary'))
          .accessibilityLevel('no')
      }
      Text(this.title)
        .fontSize($r('sys.float.Body_L'))
        .fontColor($r('sys.color.font_primary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      Toggle({ type: ToggleType.Switch, isOn: this.isOn })
        .onChange((isOn: boolean): void => {
          if (isOn === this.isOn) {
            return;
          }
          this.isOn = isOn;
          this.onChange(isOn);
        })
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
      this.contentWasPressed();
    })
  }
}
