// Port of SPTextInputView.swift: a bordered UITextField wrapper with an optional right view and an
// error state, reporting edits / return / character changes to its delegate (here: callbacks).
// HarmonyOS field: 48vp capsule on comp_background_tertiary, no border (a warning outline marks the error state).
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'SPTextInputView';

@Component
export struct SPTextInputView {
  /// The SOURCE control's accessibility identifier (Rule 12) — set on the editable node itself.
  @Prop inputId: string = '';
  @Prop placeholder: string = '';
  @Prop text: string = '';
  @Prop isSecureTextEntry: boolean = false;
  @Prop keyboardType: InputType = InputType.Normal;
  /// -1: unlimited (textInput(_:shouldChangeCharactersIn:) caps the code field at 6).
  @Prop maxLength: number = -1;
  @Prop inErrorState: boolean = false;
  @Prop hasRightView: boolean = false;
  /// textField.returnKeyType (email: .next, password / code: .done)
  @Prop returnKeyType: EnterKeyType = EnterKeyType.Done;
  /// SPTextInputViewDelegate.textInputDidChange
  onTextChange: (text: string) => void = (text: string): void => {
    hilog.info(DOMAIN, LOG_TAG, 'change with no delegate: %{public}d', text.length);
  };
  /// SPTextInputViewDelegate.textInputShouldReturn
  onShouldReturn: () => void = (): void => {
    hilog.info(DOMAIN, LOG_TAG, 'return with no delegate');
  };
  /// rightView (e.g. the reveal-password button), shown when hasRightView.
  @BuilderParam rightView: () => void = this.defaultRightView;
  /// textField.isFirstResponder — drives the enabled/disabled border colour.
  @State isEditing: boolean = false;

  @Builder
  defaultRightView() {
    Blank()
  }

  build() {
    Row() {
      TextInput({ placeholder: this.placeholder, text: this.text })
        .id(this.inputId)
        .type(this.isSecureTextEntry ? InputType.Password : this.keyboardType)
        // The source draws its own reveal button (rightView); the framework eye would be a second one.
        .showPasswordIcon(false)
        .enterKeyType(this.returnKeyType)
        .maxLength(this.maxLength > 0 ? this.maxLength : 1000000)
        .layoutWeight(1)
        .height('100%')
        .padding(0)
        .borderRadius(0)
        .backgroundColor(Color.Transparent)
        .fontColor($r('sys.color.font_primary'))
        .fontSize($r('sys.float.Body_L'))
        .placeholderColor($r('sys.color.font_tertiary'))
        .placeholderFont({ size: $r('sys.float.Body_L') })
        .caretColor($r('sys.color.brand'))
        .onFocus((): void => {
          this.isEditing = true;
        })
        .onBlur((): void => {
          this.isEditing = false;
        })
        .onChange((value: string): void => {
          this.onTextChange(value);
        })
        .onSubmit((): void => {
          this.onShouldReturn();
        })
      if (this.hasRightView) {
        this.rightView()
      }
    }
    .width('100%')
    .height(48)
    // Defaults.insets: 16 leading; the right view carries its own inset
    .padding({ left: 16 })
    .backgroundColor($r('sys.color.comp_background_tertiary'))
    .borderRadius(20)
    .border({ width: this.inErrorState ? 1 : 0, color: $r('sys.color.warning'), radius: 20 })
  }
}
