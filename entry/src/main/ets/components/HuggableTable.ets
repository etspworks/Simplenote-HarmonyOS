// Port of HuggableTableView.swift: a table that sizes itself to its content (between minHeight and
// maxHeight) and only scrolls once the content no longer fits. `maxNumberOfVisibleRows` * rowHeight
// caps the height the way the source measures rectForRow.

@Component
export struct HuggableTableView {
  @Prop minHeight: number = 0;
  /// maxHeightConstraint.constant; < 0 means unbounded
  @Prop maxHeight: number = -1;
  /// maxNumberOfVisibleRows (fractional rows allowed); < 0 means unset
  @Prop maxNumberOfVisibleRows: number = -1;
  @Prop rowHeight: number = 44;
  /// tableView.separatorColor (also drawn as the table's top / bottom hairline)
  @Prop separatorColor: ResourceColor = $r('app.color.simplenote_divider');
  /// separatorInset.left
  @Prop separatorInset: number = 0;
  @BuilderParam rows: () => void = this.noRows;

  @Builder
  noRows() {
  }

  private effectiveMaxHeight(): number {
    if (this.maxNumberOfVisibleRows >= 0) {
      const rowsCap: number = this.maxNumberOfVisibleRows * this.rowHeight;
      return this.maxHeight < 0 ? rowsCap : Math.min(rowsCap, this.maxHeight);
    }
    return this.maxHeight < 0 ? Number.MAX_SAFE_INTEGER : this.maxHeight;
  }

  build() {
    List() {
      this.rows()
    }
    .width('100%')
    .divider({ strokeWidth: 0.5, color: this.separatorColor, startMargin: this.separatorInset })
    .border({ width: { top: 0.5, bottom: 0.5 }, color: this.separatorColor })
    .constraintSize({ minHeight: this.minHeight, maxHeight: this.effectiveMaxHeight() })
    .edgeEffect(EdgeEffect.None)
  }
}
