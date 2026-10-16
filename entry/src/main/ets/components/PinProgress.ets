// Port of PinLockProgressView.swift: a row of `length` round indicators; the first `progress` are
// filled (highlighted). Not interactive.

/// Constants.buttonSideSize. HarmonyOS look: solid dots, brand when filled.
const INDICATOR_SIDE: number = 14;

@Component
export struct PinLockProgressView {
  @Prop length: number = 0;
  @Prop progress: number = 0;

  private indices(): number[] {
    const result: number[] = [];
    for (let i = 0; i < this.length; i++) {
      result.push(i);
    }
    return result;
  }

  build() {
    // PinLockProgressView: stack spacing 24
    Row({ space: 24 }) {
      ForEach(this.indices(), (index: number) => {
        Column()
          .width(INDICATOR_SIDE)
          .height(INDICATOR_SIDE)
          .borderRadius(INDICATOR_SIDE / 2)
          .backgroundColor(index < Math.min(this.progress, this.length) ?
            $r('sys.color.brand') : $r('sys.color.comp_background_secondary'))
      }, (index: number): string => index.toString())
    }
    .hitTestBehavior(HitTestMode.None)
  }
}
