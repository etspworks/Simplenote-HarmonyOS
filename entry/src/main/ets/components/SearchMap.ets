// Port of SearchMapView.swift: a thin strip on the editor's trailing edge with one bar per search
// match (position = match midY / text height). Touching a bar (tap or drag) selects that match.

/// Metrics.barHeight
const BAR_HEIGHT: number = 4;
/// Metrics.extraVerticalTouchMargin
const EXTRA_VERTICAL_TOUCH_MARGIN: number = 10;

@Component
export struct SearchMapView {
  /// Relative positions (0...1) of each match — update(with:)
  @Prop positions: number[] = [];
  @State private mapHeight: number = 0;
  private lastSelectedIndex: number = -1;
  onSelectionChange: (index: number) => void = (index: number): void => {
    this.lastSelectedIndex = index;
  };

  /// barView(with:) — nearest bar whose (inset) frame contains `y`.
  private barIndexAt(y: number): number {
    let best: number = -1;
    let bestDistance: number = Number.MAX_VALUE;
    for (let i = 0; i < this.positions.length; i++) {
      const midY: number = this.barMidY(this.positions[i]);
      const distance: number = Math.abs(midY - y);
      if (distance <= BAR_HEIGHT / 2 + EXTRA_VERTICAL_TOUCH_MARGIN && distance < bestDistance) {
        best = i;
        bestDistance = distance;
      }
    }
    return best;
  }

  private barMidY(position: number): number {
    const midY: number = position * this.mapHeight;
    return Math.min(Math.max(midY, BAR_HEIGHT / 2), Math.max(this.mapHeight - BAR_HEIGHT / 2, BAR_HEIGHT / 2));
  }

  /// handleGesture(_:) — began/changed select the bar under the finger, ended resets.
  private handleTouch(event: TouchEvent): void {
    if (event.touches.length === 0) {
      return;
    }
    if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
      this.lastSelectedIndex = -1;
      return;
    }
    const index: number = this.barIndexAt(event.touches[0].y);
    if (index < 0 || index === this.lastSelectedIndex) {
      if (index < 0) {
        this.lastSelectedIndex = -1;
      }
      return;
    }
    this.lastSelectedIndex = index;
    this.onSelectionChange(index);
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      ForEach(this.positions, (position: number, index: number) => {
        Column()
          .width('100%')
          .height(BAR_HEIGHT)
          .backgroundColor($r('app.color.simplenote_blue50'))
          .position({ x: 0, y: this.barMidY(position) - BAR_HEIGHT / 2 })
      }, (position: number, index: number): string => index.toString() + ':' + position.toString())
    }
    .width('100%')
    .height('100%')
    .onAreaChange((oldValue: Area, newValue: Area): void => {
      this.mapHeight = Number(newValue.height);
    })
    .onTouch((event: TouchEvent): void => {
      this.handleTouch(event);
    })
  }
}
