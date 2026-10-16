// Port of PopoverPresenter.swift + PopoverViewController.swift: a floating container (autocomplete
// list) laid out above or below an anchor rect inside a viewport, sized to the available slice.
// The presenter is the logic half; `Popover` is the view the host places in its root Stack.
import { InterlinkPopoverPresenter, InterlinkRect, InterlinkViewController } from '../common/InterlinkService';

/// Metrics.defaultContentInsets (top/bottom 12, left/right 20)
const CONTENT_INSET_VERTICAL: number = 12;
const CONTENT_INSET_HORIZONTAL: number = 20;
/// Metrics.defaultContentWidth
export const POPOVER_CONTENT_WIDTH: number = 300;
/// Metrics.minimumHeight
const MINIMUM_HEIGHT: number = 30;

/// Where the container sits: `top` + `maxHeight`, `above` when laid out over the anchor.
export class PopoverLayout {
  left: number = 0;
  top: number = 0;
  maxHeight: number = MINIMUM_HEIGHT;
  above: boolean = false;
}

export type PopoverLayoutChanged = (layout: PopoverLayout | null) => void;
export type PopoverViewportProvider = () => InterlinkRect;

export class PopoverPresenter implements InterlinkPopoverPresenter {
  isPresented: boolean = false;
  /// dismissOnInteractionWithPassthruView
  dismissOnInteractionWithPassthruView: boolean = false;
  /// An anchor below the viewport (a caret the keyboard covers) is laid out against the viewport's bottom edge,
  /// so the popover stays above the keyboard. Off for anchors outside the viewport by design (the tag field).
  clampsAnchorToViewport: boolean = false;
  /// centerContentRelativeToAnchor
  centerContentRelativeToAnchor: boolean = false;
  /// The container's width (containerViewController.view width)
  containerWidth: number = 0;
  private desiredHeight: number = -1;
  private layout: PopoverLayout | null = null;
  private readonly viewportProvider: PopoverViewportProvider;
  private readonly onLayoutChange: PopoverLayoutChanged;
  /// The interlink content controller handed to show(_:around:desiredHeight:)
  onShowController: ((controller: InterlinkViewController) => void) | null = null;
  /// Invoked after the popover was dismissed
  onDismiss: (() => void) | null = null;

  constructor(viewportProvider: PopoverViewportProvider, onLayoutChange: PopoverLayoutChanged) {
    this.viewportProvider = viewportProvider;
    this.onLayoutChange = onLayoutChange;
  }

  /// show(_:around:desiredHeight:) for the interlink autocomplete
  show(controller: InterlinkViewController, anchorInWindow: InterlinkRect, desiredHeight: number): void {
    if (this.onShowController !== null) {
      this.onShowController(controller);
    }
    this.showAround(anchorInWindow, desiredHeight);
  }

  /// show(_:around:) for any other content (tag suggestions)
  showAround(anchorInWindow: InterlinkRect, desiredHeight: number): void {
    this.dismiss();
    this.desiredHeight = desiredHeight;
    this.isPresented = true;
    this.relocate(anchorInWindow);
  }

  relocate(anchorInWindow: InterlinkRect): void {
    if (!this.isPresented) {
      return;
    }
    const viewport: InterlinkRect = this.viewportProvider();
    const viewportMaxY: number = this.clampsAnchorToViewport ? viewport.y + viewport.height : Number.MAX_VALUE;
    const anchorMinY: number = Math.min(anchorInWindow.y, viewportMaxY);
    const anchorMaxY: number = Math.min(anchorInWindow.y + anchorInWindow.height, viewportMaxY);
    const sliceAbove: number = Math.max(anchorMinY - viewport.y, 0);
    const sliceBelow: number = Math.max(viewport.y + viewport.height - anchorMaxY, 0);

    let above: boolean;
    if (this.desiredHeight < 0) {
      above = sliceAbove > sliceBelow;
    } else {
      const deltaAbove: number = sliceAbove - this.desiredHeight;
      const deltaBelow: number = sliceBelow - this.desiredHeight;
      above = deltaAbove >= 0 || (deltaAbove < 0 && deltaBelow < 0 && deltaAbove > deltaBelow);
    }

    const slice: number = above ? sliceAbove : sliceBelow;
    const height: number = Math.max(slice - CONTENT_INSET_VERTICAL * 2, MINIMUM_HEIGHT);
    const contentHeight: number = this.desiredHeight < 0 ? height : Math.min(height, this.desiredHeight);

    const layout: PopoverLayout = new PopoverLayout();
    layout.maxHeight = height;
    layout.above = above;
    layout.top = above ? anchorMinY - CONTENT_INSET_VERTICAL - contentHeight : anchorMaxY + CONTENT_INSET_VERTICAL;
    layout.left = this.leftLocation(anchorInWindow, viewport);
    this.layout = layout;
    this.onLayoutChange(layout);
  }

  relocateBy(deltaY: number): void {
    if (this.layout === null) {
      return;
    }
    const layout: PopoverLayout = new PopoverLayout();
    layout.left = this.layout.left;
    layout.top = this.layout.top + deltaY;
    layout.maxHeight = this.layout.maxHeight;
    layout.above = this.layout.above;
    this.layout = layout;
    this.onLayoutChange(layout);
  }

  dismiss(): void {
    if (!this.isPresented) {
      return;
    }
    this.isPresented = false;
    this.layout = null;
    this.onLayoutChange(null);
    if (this.onDismiss !== null) {
      this.onDismiss();
    }
  }

  /// PassthruView.onInteraction
  handleInteractionWithPassthruView(): void {
    if (this.dismissOnInteractionWithPassthruView) {
      this.dismiss();
    }
  }

  private leftLocation(anchor: InterlinkRect, viewport: InterlinkRect): number {
    if (this.centerContentRelativeToAnchor) {
      return anchor.x + anchor.width / 2 - POPOVER_CONTENT_WIDTH / 2;
    }
    const maximumX: number = anchor.x + POPOVER_CONTENT_WIDTH + CONTENT_INSET_HORIZONTAL;
    if (viewport.width > maximumX) {
      return Math.max(anchor.x - CONTENT_INSET_HORIZONTAL, 0);
    }
    return Math.max(anchor.x + viewport.width - maximumX, 0);
  }
}

/// PopoverViewController: the container (menu surface + system shadow) hosting the child content.
@Component
export struct Popover {
  @Prop left: number = 0;
  @Prop top: number = 0;
  @Prop maxHeight: number = MINIMUM_HEIGHT;
  @BuilderParam content: () => void = this.emptyContent;

  @Builder
  emptyContent() {
  }

  build() {
    Column() {
      this.content()
    }
    .width(POPOVER_CONTENT_WIDTH)
    .constraintSize({ maxHeight: this.maxHeight })
    .position({ x: this.left, y: this.top })
    // HarmonyOS menu surface
    .backgroundColor($r('sys.color.comp_background_primary'))
    .borderRadius($r('sys.float.corner_radius_level10'))
    .shadow(ShadowStyle.OUTER_DEFAULT_MD)
    .clip(true)
  }
}
