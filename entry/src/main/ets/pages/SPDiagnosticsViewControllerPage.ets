// Port of SPDiagnosticsViewController.swift (+ .xib) — presentation: sheet (formSheet nav), hosted by
// SPAuthViewControllerPage (.bindSheet). Structure: nav bar with Share (left) and Done (right), title label
// 'Diagnostics', read-only scrolling text of the failed auth request (NSAttributedString.stringFromNetworkError).
import { common } from '@kit.AbilityKit';
import { LengthMetrics, EditableTitleBar, EditableLeftIconType } from '@kit.ArkUI';
import { pasteboard } from '@kit.BasicServicesKit';
import { uniformTypeDescriptor } from '@kit.ArkData';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { systemShare } from '@kit.ShareKit';
import { HmIconButton } from '../components/HmIconButton';

const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'Diagnostics';

@Component
export struct SPDiagnosticsViewController {
  /// attributedText: the failed auth request details, set by the host.
  @Prop @Watch('attributedTextDidChange') attributedText: string = '';
  /// detailsTextView.attributedText
  @State details: string = '';
  /// Done -> dismiss.
  onDismiss: () => void = (): void => {
    hilog.info(DOMAIN, LOG_TAG, 'dismiss requested with no host handler');
  };

  aboutToAppear(): void {
    this.details = this.attributedText;
  }

  attributedTextDidChange(): void {
    this.details = this.attributedText;
  }

  /// shareWasPressed: system share sheet with the diagnostics text; clipboard + toast on failure.
  private shareWasPressed(): void {
    const record: systemShare.SharedRecord = {
      utd: uniformTypeDescriptor.UniformDataType.PLAIN_TEXT,
      content: this.details
    };
    const controller: systemShare.ShareController = new systemShare.ShareController(new systemShare.SharedData(record));
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    controller.show(context, {
      previewMode: systemShare.SharePreviewMode.DEFAULT,
      selectionMode: systemShare.SelectionMode.SINGLE
    }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'share failed: %{public}s', e.message);
      this.copyDetailsFallback();
    });
  }

  private copyDetailsFallback(): void {
    const data: pasteboard.PasteData = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, this.details);
    pasteboard.getSystemPasteboard().setData(data).then((): void => {
      this.getUIContext().getPromptAction().showToast({ message: 'Sharing is unavailable; diagnostics copied instead' });
    }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'copy failed: %{public}s', e.message);
    });
  }

  build() {
    Column() {
      // HarmonyOS sheet title bar: close (X) = Done, titled Diagnostics, with a share symbol menu item.
      // Share is an HmIconButton beside the bar so diagnostics_share stays on its tappable node; the
      // wrapper carries diagnostics_done (EditableTitleBar does not expose its close button).
      Row() {
        Column() {
          EditableTitleBar({
            leftIconStyle: EditableLeftIconType.Cancel,
            title: 'Diagnostics',
            isSaveIconRequired: false,
            onCancel: (): void => {
              this.onDismiss();
            }
          })
        }
        .id('diagnostics_done')
        .layoutWeight(1)
        HmIconButton({
          symbol: $r('sys.symbol.share'),
          label: 'Share',
          buttonId: 'diagnostics_share',
          action: (): void => {
            this.shareWasPressed();
          }
        })
          .margin({ end: LengthMetrics.vp(16) })
      }
      .width('100%')

      // detailsTextView (editable = NO)
      Scroll() {
        Text(this.details)
          .fontSize($r('sys.float.Body_M'))
          .fontColor($r('sys.color.font_primary'))
          .copyOption(CopyOptions.LocalDevice)
          .width('100%')
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.TopStart)
      .scrollBar(BarState.Auto)
      .margin({ top: LengthMetrics.vp(8), bottom: LengthMetrics.vp(20) })
      .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16) })
    }
    .id('screen_diagnostics')
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.background_primary'))
  }
}
