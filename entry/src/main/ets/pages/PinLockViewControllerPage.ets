// Port of PinLockViewController (.swift + .xib) driven by one of PinLockSetupController /
// PinLockRemoveController / PinLockVerifyController. verify: presented over the note list on
// launch/foreground; setup/remove: presented from Settings.
import { router, LengthMetrics, curves } from '@kit.ArkUI';
import { vibrator } from '@kit.SensorServiceKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { KeyCode } from '@kit.InputKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { PinLockRouteParams, runActionAfterUnlock } from './SPNoteListViewControllerPage';
import {
  PinLockBaseController,
  PinLockRemoveController,
  PinLockRemoveControllerDelegate,
  PinLockSetupController,
  PinLockSetupControllerDelegate,
  PinLockVerifyController,
  PinLockVerifyControllerDelegate,
  SPPinLockManager
} from '../common/PinLockManager';
import { SPTracker } from '../common/Tracker';
import { PinLockControllerConfiguration, PinLockReloadAnimation } from '../model/PinLockControllerConfiguration';
import { PinLockProgressView } from '../components/PinProgress';

const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'PinLock';
/// Constants.pinLength
const PIN_LENGTH: number = 4;
/// Keypad key diameter (vp)
const KEY_SIDE: number = 76;
/// Keypad digits in xib order (1-9, then 0)
const KEYPAD_ROWS: number[][] = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
/// Source slug per keypad digit (index = digit), literal so the slugs stay greppable
const KEYPAD_DIGIT_IDS: string[] = [
  'pin_lock_digit_0', 'pin_lock_digit_1', 'pin_lock_digit_2', 'pin_lock_digit_3', 'pin_lock_digit_4',
  'pin_lock_digit_5', 'pin_lock_digit_6', 'pin_lock_digit_7', 'pin_lock_digit_8', 'pin_lock_digit_9'
];

/// Settings' PinLockSetupControllerDelegate / PinLockRemoveControllerDelegate and the app delegate's
/// PinLockVerifyControllerDelegate, all ending in dismissing this page.
class PinLockDelegates implements PinLockSetupControllerDelegate, PinLockRemoveControllerDelegate,
  PinLockVerifyControllerDelegate {
  private readonly dismiss: () => void;

  constructor(dismiss: () => void) {
    this.dismiss = dismiss;
  }

  pinLockSetupControllerDidComplete(controller: PinLockSetupController): void {
    SPTracker.trackSettingsPinlockEnabled(true);
    this.dismiss();
    SPPinLockManager.shared.shouldUseBiometry = true;
  }

  pinLockSetupControllerDidCancel(controller: PinLockSetupController): void {
    SPPinLockManager.shared.shouldUseBiometry = false;
    this.dismiss();
  }

  pinLockRemoveControllerDidComplete(controller: PinLockRemoveController): void {
    SPTracker.trackSettingsPinlockEnabled(false);
    this.dismiss();
  }

  pinLockRemoveControllerDidCancel(controller: PinLockRemoveController): void {
    this.dismiss();
  }

  pinLockVerifyControllerDidComplete(controller: PinLockVerifyController): void {
    this.dismiss();
  }
}

@Entry
@Component
struct PinLockViewControllerPage {
  /// setup | remove | verify (router param / launch)
  @State mode: string = 'verify';
  /// PinLockControllerConfiguration.title / .message
  @State title: string = '';
  @State message: string = '';
  /// entered digits (0..4)
  @State inputValues: number[] = [];
  /// verify-mode failures (PinLockControllerConfiguration.message carries the count)
  @State failedAttempts: number = 0;
  @State shakeOffset: number = 0;
  /// PinLockSetupController | PinLockRemoveController | PinLockVerifyController (per mode)
  private pinLockController: PinLockBaseController | null = null;
  private pageVisible: boolean = false;
  private dismissed: boolean = false;

  aboutToAppear(): void {
    const params: PinLockRouteParams | undefined = router.getParams() as PinLockRouteParams | undefined;
    if (params !== undefined && params !== null && params.mode !== undefined) {
      this.mode = params.mode;
    } else {
      // No mode (a targetPage deep link): the Settings entry point, which picks remove vs setup
      // exactly as SPSettingsViewController.showPinLockViewController does. The launch verify path
      // always passes mode 'verify' explicitly.
      this.mode = SPPinLockManager.shared.isEnabled ? 'remove' : 'setup';
    }
    const delegates: PinLockDelegates = new PinLockDelegates((): void => {
      this.dismiss();
    });
    if (this.mode === 'setup') {
      this.pinLockController = new PinLockSetupController(delegates);
    } else if (this.mode === 'remove') {
      this.pinLockController = new PinLockRemoveController(delegates);
    } else {
      this.pinLockController = new PinLockVerifyController(delegates, (): boolean => this.pageVisible);
    }
  }

  /// viewWillAppear: configurationObserver; viewDidAppear: controller.viewDidAppear()
  onPageShow(): void {
    this.pageVisible = true;
    const controller: PinLockBaseController | null = this.pinLockController;
    if (controller === null) {
      return;
    }
    controller.setConfigurationObserver((configuration: PinLockControllerConfiguration,
      animation: PinLockReloadAnimation | null): void => {
      this.update(configuration, animation);
    });
    controller.viewDidAppear();
  }

  /// viewDidDisappear: configurationObserver = nil
  onPageHide(): void {
    this.pageVisible = false;
    if (this.pinLockController !== null) {
      this.pinLockController.setConfigurationObserver(null);
    }
  }

  /// accessibilityPerformEscape / Back -> controller.handleCancellation (verify ignores it).
  onBackPress(): boolean | void {
    if (this.pinLockController !== null && this.pinLockController.isCancellable) {
      this.pinLockController.handleCancellation();
      return true;
    }
    return true;
  }

  /// verify success -> dismissPasscodeLock; setup/remove complete or cancel -> dismissPresentedViewController.
  dismiss(): void {
    if (this.dismissed) {
      return;
    }
    this.dismissed = true;
    router.back();
    if (this.mode === 'verify') {
      runActionAfterUnlock();
    }
  }

  // MARK: - Configuration

  private update(configuration: PinLockControllerConfiguration, animation: PinLockReloadAnimation | null): void {
    this.inputValues = [];
    this.title = configuration.title;
    this.message = configuration.message ?? ' ';
    if (animation === PinLockReloadAnimation.SHAKE) {
      this.failedAttempts += 1;
      this.shake();
      this.vibrateError();
    }
  }

  /// headerStackView.reload(with: .shake)
  private shake(): void {
    this.shakeOffset = 12;
    // HarmonyOS standard Bezier, 250ms.
    animateTo({ duration: 250, curve: curves.cubicBezierCurve(0.4, 0, 0.2, 1) }, (): void => {
      this.shakeOffset = 0;
    });
  }

  /// feedbackGenerator.notificationOccurred(.error)
  private vibrateError(): void {
    try {
      vibrator.startVibration({ type: 'time', duration: 50 }, { id: 0, usage: 'notification' })
        .catch((error: BusinessError): void => {
          hilog.warn(DOMAIN, LOG_TAG, 'vibration failed: %{public}s', error.message);
        });
    } catch (e) {
      hilog.warn(DOMAIN, LOG_TAG, 'vibration unavailable');
    }
  }

  // MARK: - Pincode

  private addDigit(digit: number): void {
    if (this.inputValues.length >= PIN_LENGTH) {
      return;
    }
    const values: number[] = this.inputValues.slice();
    values.push(digit);
    this.inputValues = values;
    if (values.length === PIN_LENGTH && this.pinLockController !== null) {
      const pin: string = values.map((value: number): string => value.toString()).join('');
      this.pinLockController.handlePin(pin);
    }
  }

  private removeLastDigit(): boolean {
    if (this.inputValues.length === 0) {
      return false;
    }
    this.inputValues = this.inputValues.slice(0, this.inputValues.length - 1);
    return true;
  }

  // MARK: - Buttons

  private handleTapOnKeypadButton(digit: number): void {
    this.addDigit(digit);
  }

  private handleTapOnCancelButton(): void {
    if (!this.removeLastDigit() && this.pinLockController !== null) {
      this.pinLockController.handleCancellation();
    }
  }

  // MARK: - External keyboard

  /// keyCommands: digits 0-9 (top row or numpad) -> addDigit, backspace -> removeLastDigit.
  /// Returns true when the key was handled.
  private handleKey(event: KeyEvent): boolean {
    if (event.type !== KeyType.Down) {
      return false;
    }
    if (event.keyCode >= KeyCode.KEYCODE_0 && event.keyCode <= KeyCode.KEYCODE_9) {
      this.addDigit(event.keyCode - KeyCode.KEYCODE_0);
      return true;
    }
    if (event.keyCode >= KeyCode.KEYCODE_NUMPAD_0 && event.keyCode <= KeyCode.KEYCODE_NUMPAD_9) {
      this.addDigit(event.keyCode - KeyCode.KEYCODE_NUMPAD_0);
      return true;
    }
    if (event.keyCode === KeyCode.KEYCODE_DEL) {
      this.removeLastDigit();
      return true;
    }
    return false;
  }

  @Builder
  keypadButton(digit: number) {
    // HarmonyOS keypad key: 76vp tertiary-fill circle, Title_M digit in the primary font colour
    Button(digit.toString(), { type: ButtonType.Circle, stateEffect: true })
      .id(KEYPAD_DIGIT_IDS[digit])
      .width(KEY_SIDE)
      .height(KEY_SIDE)
      .fontSize($r('sys.float.Title_M'))
      .fontColor($r('sys.color.font_primary'))
      .backgroundColor($r('sys.color.comp_background_tertiary'))
      .onClick((): void => {
        this.handleTapOnKeypadButton(digit);
      })
  }

  /// cancelButton: 'Cancel' (hidden when not cancellable) with no digits, a delete-left symbol otherwise.
  @Builder
  cancelButton() {
    if (this.inputValues.length > 0) {
      Button({ type: ButtonType.Circle, stateEffect: true }) {
        SymbolGlyph($r('sys.symbol.delete_left'))
          .fontSize(24)
          .fontColor([$r('sys.color.icon_primary')])
      }
      .id('pin_lock_cancel')
      .width(KEY_SIDE)
      .height(KEY_SIDE)
      .backgroundColor(Color.Transparent)
      .accessibilityText($r('app.string.delete'))
      .onClick((): void => {
        this.handleTapOnCancelButton();
      })
    } else if (this.pinLockController !== null && this.pinLockController.isCancellable) {
      Button($r('app.string.cancel'), { type: ButtonType.Circle, stateEffect: true })
        .id('pin_lock_cancel')
        .width(KEY_SIDE)
        .height(KEY_SIDE)
        .backgroundColor(Color.Transparent)
        .fontColor($r('sys.color.font_emphasize'))
        .fontSize($r('sys.float.Body_L'))
        .onClick((): void => {
          this.handleTapOnCancelButton();
        })
    } else {
      Column()
        .width(KEY_SIDE)
        .height(KEY_SIDE)
    }
  }

  build() {
    Column() {
      Blank()

      // stack (spacing 25): header + keypad, centred in the view
      Column({ space: 25 }) {
        // headerStackView (spacing 25): title, message, progress
        Column({ space: 25 }) {
          Text(this.title)
            .fontSize($r('sys.float.Title_S'))
            .fontWeight(FontWeight.Bold)
            .fontColor($r('sys.color.font_primary'))
            .textAlign(TextAlign.Center)
          Text(this.message)
            .fontSize($r('sys.float.Body_M'))
            .fontColor($r('sys.color.font_secondary'))
            .textAlign(TextAlign.Center)
          PinLockProgressView({ length: PIN_LENGTH, progress: this.inputValues.length })
        }
        .alignItems(HorizontalAlign.Center)
        .padding({ bottom: LengthMetrics.vp(40) })
        .translate({ x: this.shakeOffset })

        // keypad rows (spacing 16), buttons (spacing 28)
        Column({ space: 16 }) {
          ForEach(KEYPAD_ROWS, (row: number[]) => {
            Row({ space: 28 }) {
              ForEach(row, (digit: number) => {
                this.keypadButton(digit)
              }, (digit: number): string => digit.toString())
            }
          }, (row: number[]): string => row.join(','))

          // bottom row: 0, then the Cancel / Delete key in the keypad's trailing slot
          Row({ space: 28 }) {
            Column()
              .width(KEY_SIDE)
              .height(KEY_SIDE)
            this.keypadButton(0)
            this.cancelButton()
          }
        }
        .alignItems(HorizontalAlign.Center)
      }
      .alignItems(HorizontalAlign.Center)

      Blank()
    }
    .padding({ bottom: LengthMetrics.vp(32) })
    .id('screen_pin_lock')
    // canBecomeFirstResponder: the screen holds focus so hardware keys reach keyCommands
    .focusable(true)
    .defaultFocus(true)
    .onKeyEvent((event: KeyEvent): void => {
      if (this.handleKey(event)) {
        event.stopPropagation();
      }
    })
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.background_primary'))
  }
}
