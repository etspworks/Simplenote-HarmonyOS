// Port of SPSnappingSlider.swift: a slider whose value snaps to multiples of `step`; each change of
// the snapped value is reported through onSnappedValueChange.

@Component
export struct SPSnappingSlider {
  /// The SOURCE control's accessibility identifier (Rule 12)
  @Prop sliderId: string = '';
  @Prop minimumValue: number = 0;
  @Prop maximumValue: number = 1;
  @Prop step: number = 1;
  /// slider.value, set by the owner (updateSlider(withVersionNumber:))
  @Prop @Watch('valueDidChange') value: number = 0;
  @State private snappedValue: number = 0;
  onSnappedValueChange: (value: number) => void = (value: number): void => {
    this.snappedValue = value;
  };

  aboutToAppear(): void {
    this.snappedValue = this.snap(this.value);
  }

  valueDidChange(): void {
    this.snappedValue = this.snap(this.value);
  }

  /// setValue(_:animated:) clamping + rounding
  private snap(value: number): number {
    const clamped: number = Math.min(Math.max(value, this.minimumValue), this.maximumValue);
    return Math.round(clamped / this.step) * this.step;
  }

  build() {
    Slider({
      value: this.snappedValue,
      min: this.minimumValue,
      max: this.maximumValue,
      step: this.step,
      style: SliderStyle.OutSet
    })
      .id(this.sliderId)
      .width('100%')
      // HarmonyOS default slider look: system track, selected and block colours and sizes.
      .accessibilityText($r('app.string.select_a_version'))
      .onChange((value: number, mode: SliderChangeMode): void => {
        const snapped: number = this.snap(value);
        if (snapped === this.snappedValue) {
          return;
        }
        this.snappedValue = snapped;
        this.onSnappedValueChange(snapped);
      })
  }
}
