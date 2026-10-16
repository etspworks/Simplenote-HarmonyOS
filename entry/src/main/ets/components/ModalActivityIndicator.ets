// Port of SPModalActivityIndicator (showInWindow:): a full-window overlay with a centred
// activity indicator, shown while the account is being signed out. It swallows
// touches underneath (userInteractionEnabled = YES) until dismissed.
// HarmonyOS look: system LoadingProgress on a 16vp-radius primary surface over the system mask.
@Component
export struct SPModalActivityIndicator {
  build() {
    Stack() {
      Column() {
        LoadingProgress()
          .width(32)
          .height(32)
      }
      .width(80)
      .height(80)
      .borderRadius($r('sys.float.corner_radius_level8'))
      .backgroundColor($r('sys.color.comp_background_primary'))
      .justifyContent(FlexAlign.Center)
    }
    .width('100%')
    .backgroundColor($r('sys.color.mask_secondary'))
    .height('100%')
    .alignContent(Alignment.Center)
  }
}
