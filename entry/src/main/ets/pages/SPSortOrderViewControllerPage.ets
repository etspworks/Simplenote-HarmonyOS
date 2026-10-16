// Port of SPSortOrderViewController.swift (pushed from Settings). Structure: navigation bar
// 'Sort Order' with back, one grouped section with a row per SortMode case; the selected mode
// carries the selected Radio. Selecting a row writes Options.listSortMode (the list re-sorts).
import { router, LengthMetrics, EditableTitleBar, EditableLeftIconType } from '@kit.ArkUI';
import { Options } from '../common/OptionsStore';
import { SortMode, SortModeInfo } from '../model/SortMode';

@Entry
@Component
struct SPSortOrderViewControllerPage {
  /// Options.listSortMode (selectedMode), shared with Settings / the note list through AppStorage
  @StorageLink('listSortMode') sortMode: SortMode = Options.shared.listSortMode;

  aboutToAppear(): void {
    this.sortMode = Options.shared.listSortMode;
  }

  /// Back -> pop to Settings.
  dismiss(): void {
    router.back();
  }

  /// tableView(_:didSelectRowAt:) -> selectedMode didSet -> onChange -> Options.listSortMode
  private selectMode(mode: SortMode): void {
    this.sortMode = mode;
    Options.shared.listSortMode = mode;
  }

  build() {
    Column() {
      // HarmonyOS level-2 title bar: system back arrow + left-aligned title.
      EditableTitleBar({
        leftIconStyle: EditableLeftIconType.Back,
        title: $r('app.string.sort_order'),
        isSaveIconRequired: false,
        onCancel: (): void => {
          this.dismiss();
        }
      })

      // UITableView(style: .grouped)
      List() {
        ListItemGroup({ style: ListItemGroupStyle.CARD }) {
          ForEach(SortModeInfo.ALL_CASES, (mode: SortMode) => {
            ListItem({ style: ListItemStyle.CARD }) {
              Row({ space: 16 }) {
                Text(SortModeInfo.description(mode))
                  .fontSize($r('sys.float.Body_L'))
                  .fontColor($r('sys.color.font_primary'))
                  .layoutWeight(1)
                // Single choice: a system Radio replaces the iOS checkmark accessory. The row owns the tap.
                Radio({ value: mode.toString(), group: 'sort_order' })
                  .checked(mode === this.sortMode)
                  .hitTestBehavior(HitTestMode.None)
                  .accessibilityLevel('no')
              }
              .width('100%')
              .constraintSize({ minHeight: 48 })
            }
            .id('sort_order_itemroot')
            .accessibilitySelected(mode === this.sortMode)
            .onClick((): void => {
              this.selectMode(mode);
            })
          }, (mode: SortMode): string => mode.toString())
        }
        .divider({ strokeWidth: '1px', color: $r('sys.color.comp_divider'), startMargin: 8, endMargin: 8 })
      }
      .width('100%')
      .layoutWeight(1)
      .padding({ top: LengthMetrics.vp(8) })
      .scrollBar(BarState.Off)
    }
    .id('screen_sort_order')
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.background_secondary'))
    // The grouped background runs under the gesture bar (no white strip at the bottom).
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
  }
}
