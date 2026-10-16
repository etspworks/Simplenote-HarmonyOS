// Port of SPThemeViewController.swift (pushed from Settings). Structure: navigation bar 'Themes' with back,
// one grouped section with a row per Theme.allThemes; the selected theme carries the selected Radio.
// Selecting a row writes Options.theme; SessionStore listens for SIMPLENOTE_THEME_CHANGED and applies the
// color mode (SPUserInterface.refreshUserInterfaceStyle).
import { router, LengthMetrics, EditableTitleBar, EditableLeftIconType } from '@kit.ArkUI';
import { Options, themeDescription } from '../common/OptionsStore';
import { Theme, ThemeInfo } from '../model/Theme';

@Entry
@Component
struct SPThemeViewControllerPage {
  /// Options.theme (selectedTheme), shared with Settings through AppStorage
  @StorageLink('theme') theme: Theme = Options.shared.theme;

  aboutToAppear(): void {
    this.theme = Options.shared.theme;
  }

  /// Back -> pop to Settings.
  dismiss(): void {
    router.back();
  }

  /// tableView(_:didSelectRowAt:) -> selectedTheme didSet -> onChange -> Options.theme
  private selectTheme(mode: Theme): void {
    this.theme = mode;
    Options.shared.theme = mode;
  }

  build() {
    Column() {
      // HarmonyOS level-2 title bar: system back arrow + left-aligned title.
      EditableTitleBar({
        leftIconStyle: EditableLeftIconType.Back,
        title: $r('app.string.themes'),
        isSaveIconRequired: false,
        onCancel: (): void => {
          this.dismiss();
        }
      })

      // UITableView(style: .grouped) + applySimplenoteGroupedStyle
      List() {
        ListItemGroup({ style: ListItemGroupStyle.CARD }) {
          ForEach(ThemeInfo.ALL_THEMES, (mode: Theme) => {
            ListItem({ style: ListItemStyle.CARD }) {
              Row({ space: 16 }) {
                Text(themeDescription(mode))
                  .fontSize($r('sys.float.Body_L'))
                  .fontColor($r('sys.color.font_primary'))
                  .layoutWeight(1)
                // Single choice: a system Radio replaces the iOS checkmark accessory. The row owns the tap.
                Radio({ value: mode.toString(), group: 'theme' })
                  .checked(mode === this.theme)
                  .hitTestBehavior(HitTestMode.None)
                  .accessibilityLevel('no')
              }
              .width('100%')
              .constraintSize({ minHeight: 48 })
            }
            .id('theme_itemroot')
            .accessibilitySelected(mode === this.theme)
            .onClick((): void => {
              this.selectTheme(mode);
            })
          }, (mode: Theme): string => mode.toString())
        }
        .divider({ strokeWidth: '1px', color: $r('sys.color.comp_divider'), startMargin: 8, endMargin: 8 })
      }
      .width('100%')
      .layoutWeight(1)
      .padding({ top: LengthMetrics.vp(8) })
      .scrollBar(BarState.Off)
    }
    .id('screen_theme')
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.background_secondary'))
    // The grouped background runs under the gesture bar (no white strip at the bottom).
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
  }
}
