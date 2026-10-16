// Port of SPSidebarContainerViewController: hosts the tag sidebar (TagListViewController) over the
// main content. Visibility lives in AppStorage under SIDEBAR_VISIBLE_KEY so that the sidebar's own
// content can hide it (TagListViewController calls sidebarViewController.hideSidebar on selection):
// write AppStorage.set(SIDEBAR_VISIBLE_KEY, false).
import { SPTracker } from '../common/Tracker';

export const SIDEBAR_VISIBLE_KEY: string = 'sidebarVisible';

/// SPSidebarWidth / UIKitConstants.alpha0_5
const SIDEBAR_WIDTH: number = 300;
const MAIN_ALPHA_WITH_SIDEBAR: number = 0.5;
/// SPSidebarAnimationThreshold: a pan past 15% of the sidebar width completes the transition.
const PAN_THRESHOLD: number = SIDEBAR_WIDTH * 0.15;

@Component
export struct SPSidebarContainerViewController {
  @Link showSidebar: boolean;
  @BuilderParam sidebar: () => void;
  @BuilderParam content: () => void;
  /// SPSidebarContainerDelegate.sidebarContainerShouldDisplaySidebar
  shouldDisplaySidebar: () => boolean = (): boolean => true;

  build() {
    SideBarContainer(SideBarContainerType.Overlay) {
      Column() {
        this.sidebar()
      }
      .width('100%')
      .height('100%')
      // SPSidebarContainerViewController: the main view slides by the sidebar width and dims to 0.5.
      // ponytail: slides left-to-right only; mirror the offset for RTL if an RTL locale ships.
      Stack() {
        this.content()
        // mainViewTapGestureRecognier (attached only while the sidebar shows): a tap on the dimmed main
        // view hides the sidebar (rootViewTapped: -> hideSidebarWithAnimation:) and is swallowed, so it
        // never reaches the list, search field or top bar underneath.
        if (this.showSidebar) {
          Column()
            .width('100%')
            .height('100%')
            .id('sidebar_main_tap')
            .onClick((): void => {
              this.showSidebar = false;
            })
        }
      }
      .width('100%')
      .height('100%')
      .translate({ x: this.showSidebar ? SIDEBAR_WIDTH : 0 })
      .opacity(this.showSidebar ? MAIN_ALPHA_WITH_SIDEBAR : 1)
      .animation({ duration: 250, curve: Curve.EaseInOut })
    }
    .showSideBar($$this.showSidebar)
    // The container's default control button is not a control the source has: the Sidebar button
    // lives in the list's own top bar.
    .showControlButton(false)
    .sideBarWidth(SIDEBAR_WIDTH)
    .minSideBarWidth(SIDEBAR_WIDTH)
    .maxSideBarWidth(SIDEBAR_WIDTH)
    .divider(null)
    .width('100%')
    .height('100%')
    // panGestureRecognizer (on the container view, as the source: over the sidebar too, so a left swipe that
    // starts on a tag row closes it; T-0289) + panGestureWasRecognized: a horizontal pan
    // toward the sidebar shows it, the other way hides it. parallelGesture: the note rows (List, row
    // swipe actions) consume a plain .gesture() pan, so a right swipe over the list never reached it
    // (T-0263 device check). Row actions need a left swipe, so the two do not compete.
    // ponytail: snaps on release instead of tracking the finger.
    .parallelGesture(PanGesture({ direction: PanDirection.Horizontal })
      .onActionEnd((event: GestureEvent): void => {
        if (!this.showSidebar && event.offsetX >= PAN_THRESHOLD && this.shouldDisplaySidebar()) {
          SPTracker.trackSidebarSidebarPanned();
          this.showSidebar = true;
        } else if (this.showSidebar && event.offsetX <= -PAN_THRESHOLD) {
          SPTracker.trackSidebarSidebarPanned();
          this.showSidebar = false;
        }
      }))
  }
}
