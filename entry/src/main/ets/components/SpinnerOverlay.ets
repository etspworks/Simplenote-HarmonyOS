// Port of SpinnerViewController.swift: an overFullScreen dimmed layer with a centred
// rounded box holding a large activity indicator. Presented by Settings while
// an account-deletion request is in flight (and by the auth screen while signing in).
// HarmonyOS look: system LoadingProgress on a 16vp-radius primary surface over the system mask.
@Component
export struct SpinnerViewController {
  build() {
    Stack() {
      Column() {
        LoadingProgress()
          .width(48)
          .height(48)
      }
      .width(120)
      .height(120)
      .borderRadius($r('sys.float.corner_radius_level8'))
      .backgroundColor($r('sys.color.comp_background_primary'))
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.mask_secondary'))
    .alignContent(Alignment.Center)
  }
}
