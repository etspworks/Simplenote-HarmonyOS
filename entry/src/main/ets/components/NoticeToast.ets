// Port of NoticeView (+ NoticePresenter's container): the global toast with an optional action
// (e.g. 'Note Trashed' + Undo). NoticeController.shared publishes to whichever NoticeView attached
// last; a page passes `active` = page visible, so the visible page's toast re-attaches when it shows.
import { LengthMetrics, window } from '@kit.ArkUI';
import { NoticeContainer, NoticeController, NoticeView, NOTICE_BOTTOM_MARGIN_CONSTANT } from '../common/NoticeCenter';

/// Forwards the NoticeContainer calls to the owning component.
class NoticeToastContainer implements NoticeContainer {
  private readonly show: (view: NoticeView, bottomOffset: number) => void;
  private readonly hide: (duration: number) => void;
  private readonly move: (bottomOffset: number, duration: number) => void;

  constructor(show: (view: NoticeView, bottomOffset: number) => void, hide: (duration: number) => void,
    move: (bottomOffset: number, duration: number) => void) {
    this.show = show;
    this.hide = hide;
    this.move = move;
  }

  showNotice(view: NoticeView, bottomOffset: number): void {
    this.show(view, bottomOffset);
  }

  hideNotice(duration: number): void {
    this.hide(duration);
  }

  moveNotice(bottomOffset: number, duration: number): void {
    this.move(bottomOffset, duration);
  }
}

@Component
export struct NoticeToast {
  @Prop @Watch('activeDidChange') active: boolean = true;
  @State private visible: boolean = false;
  @State private message: string = '';
  @State private actionTitle: string = '';
  @State private actionPressed: boolean = false;
  @State private bottomOffset: number = NOTICE_BOTTOM_MARGIN_CONSTANT;
  private noticeView: NoticeView | null = null;
  private container: NoticeToastContainer | null = null;

  aboutToAppear(): void {
    this.container = new NoticeToastContainer(
      (view: NoticeView, bottomOffset: number): void => {
        this.noticeView = view;
        this.message = view.message;
        this.actionTitle = view.actionTitle === null ? '' : view.actionTitle;
        this.bottomOffset = bottomOffset;
        this.visible = true;
      },
      (duration: number): void => {
        this.visible = false;
        this.noticeView = null;
      },
      (bottomOffset: number, duration: number): void => {
        this.bottomOffset = bottomOffset;
      });
    this.attach();
  }

  activeDidChange(): void {
    if (this.active) {
      this.attach();
    }
  }

  private attach(): void {
    const container: NoticeToastContainer | null = this.container;
    if (container === null) {
      return;
    }
    NoticeController.shared.presenter.attachContainer(container, null);
    window.getLastWindow(getContext(this)).then((win: window.Window) => {
      NoticeController.shared.presenter.attachContainer(container, win);
      NoticeController.shared.setupNoticeController();
    }).catch((e: Error) => {
      // No window yet: the toast still presents, only keyboard tracking is unavailable.
      NoticeController.shared.presenter.attachContainer(container, null);
    });
  }

  build() {
    Column() {
      if (this.visible) {
        // HarmonyOS snackbar: Body_M message + emphasized action on a 20vp-rounded component surface with the
        // system shadow, 16vp from the screen edges, at most 400 wide (snackbar spec). comp_background_primary
        // rather than ..._contrary: the contrary token stays light in dark mode, where font_on_primary is unreadable.
        Row({ space: 16 }) {
          Text(this.message)
            .fontSize($r('sys.float.Body_M'))
            .fontColor($r('sys.color.font_primary'))
            .flexShrink(1)
          if (this.actionTitle.length > 0) {
            // UIButton: no background; highlighted state only changes the title colour.
            Text(this.actionTitle)
              .fontSize($r('sys.float.Body_M'))
              .fontWeight(FontWeight.Medium)
              .fontColor(this.actionPressed ? $r('app.color.simplenote_card_dismiss_button_highlighted_background') :
                $r('sys.color.font_emphasize'))
              .id('notice_action')
              .onTouch((event: TouchEvent) => {
                if (event.type === TouchType.Down) {
                  this.actionPressed = true;
                } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
                  this.actionPressed = false;
                }
              })
              .onClick(() => {
                if (this.noticeView !== null) {
                  this.noticeView.actionWasTapped();
                }
              })
          }
        }
        .constraintSize({ minHeight: 48, maxWidth: 400 })
        .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16), top: LengthMetrics.vp(12), bottom: LengthMetrics.vp(12) })
        .borderRadius($r('sys.float.corner_radius_level10'))
        .backgroundColor($r('sys.color.comp_background_primary'))
        .shadow(ShadowStyle.OUTER_DEFAULT_MD)
        .gesture(LongPressGesture({ repeat: false })
          .onAction(() => {
            if (this.noticeView !== null) {
              this.noticeView.pressBegan();
            }
          })
          .onActionEnd(() => {
            if (this.noticeView !== null) {
              this.noticeView.pressEnded();
            }
          }))
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Center)
    .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16) })
    .margin({ bottom: this.bottomOffset })
    .hitTestBehavior(HitTestMode.Transparent)
  }
}
