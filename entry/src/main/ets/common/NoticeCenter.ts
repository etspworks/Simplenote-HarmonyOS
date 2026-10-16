// Port of Simplenote/NoticeController.swift (+ NoticePresenter.swift, TimerFactory.swift and the
// NoticeView's data half). The presenter no longer owns a UIWindow subview: it publishes the
// NoticeView model to the one ArkUI overlay that attached itself (comp_notice_toast), and that
// overlay renders it at `bottomOffset` and reports presses back through NoticeInteractionDelegate.
import { display, window } from '@kit.ArkUI';
import { Notice, NoticeAction } from '../model/Notice';

// UIKitConstants.swift
export const ANIMATION_SHORT_DURATION: number = 0.25;
export const ANIMATION_LONG_DURATION: number = 0.5;

// NoticeController.swift: Times (seconds)
export const NOTICE_SHORT_DELAY: number = 1.5;
export const NOTICE_LONG_DELAY: number = 2.75;

// NoticePresenter.swift: Constants (vp above the bottom edge)
export const NOTICE_BOTTOM_MARGIN_CONSTANT: number = 50;

/// Port of NoticeFactory.swift: builds the app's Notice instances, including the ones that
/// carry an action (Undo / Copy link). Messages are the source's English defaults.
/// ponytail: literal strings, not $r() -- no .ets/resourceManager caller exists yet in this
/// data-layer pass; swap to the app.string resources (already migrated) when a screen reads these.
export class NoticeFactory {
  static linkCopied(): Notice {
    return new Notice('Link copied', null);
  }

  static publishing(): Notice {
    return new Notice('Publishing note...', null);
  }

  static unpublishing(): Notice {
    return new Notice('Unpublishing note...', null);
  }

  static noteTrashed(onUndo: () => void): Notice {
    const action: NoticeAction = new NoticeAction('Undo', onUndo);
    return new Notice('Note Trashed', action);
  }

  /// `count` is the source's `notes.count` (the factory only ever reads the array's length).
  static notesTrashed(count: number, onUndo: () => void): Notice {
    const action: NoticeAction = new NoticeAction('Undo', onUndo);
    const message: string = count > 1 ? `${count} Notes Trashed` : `${count} Note Trashed`;
    return new Notice(message, action);
  }

  static unpublished(onUndo: () => void): Notice {
    const action: NoticeAction = new NoticeAction('Undo', onUndo);
    return new Notice('Unpublish successful', action);
  }

  static published(onCopy: () => void): Notice {
    const action: NoticeAction = new NoticeAction('Copy link', onCopy);
    return new Notice('Publish Successful', action);
  }

  static networkError(): Notice {
    return new Notice('A network connection is required. Please, check your connection and try again.', null);
  }
}

/// NoticeView.swift: NoticeInteractionDelegate
export interface NoticeInteractionDelegate {
  noticePressBegan(): void;
  noticePressEnded(): void;
  actionWasTapped(): void;
}

/// The data a NoticeView renders.
export class NoticeView {
  message: string = '';
  actionTitle: string | null = null;
  handler: (() => void) | null = null;
  delegate: NoticeInteractionDelegate | null = null;

  /// The action button: run the notice's handler, then let the controller dismiss.
  actionWasTapped(): void {
    if (this.handler !== null) {
      this.handler();
    }
    if (this.delegate !== null) {
      this.delegate.actionWasTapped();
    }
  }

  pressBegan(): void {
    if (this.delegate !== null) {
      this.delegate.noticePressBegan();
    }
  }

  pressEnded(): void {
    if (this.delegate !== null) {
      this.delegate.noticePressEnded();
    }
  }
}

/// Timer (Foundation) analogue
export class NoticeTimer {
  private id: number;
  private repeats: boolean;

  constructor(id: number, repeats: boolean) {
    this.id = id;
    this.repeats = repeats;
  }

  invalidate(): void {
    if (this.repeats) {
      clearInterval(this.id);
    } else {
      clearTimeout(this.id);
    }
  }
}

/// TimerFactory.swift (seconds, as TimeInterval)
export class TimerFactory {
  scheduledTimer(timeInterval: number, completion: () => void): NoticeTimer {
    const id: number = setTimeout(() => {
      completion();
    }, timeInterval * 1000);
    return new NoticeTimer(id, false);
  }

  repeatingTimer(timeInterval: number, completion: (timer: NoticeTimer) => void): NoticeTimer {
    let timer: NoticeTimer | null = null;
    const id: number = setInterval(() => {
      if (timer !== null) {
        completion(timer);
      }
    }, timeInterval * 1000);
    timer = new NoticeTimer(id, true);
    return timer;
  }
}

/// What the ArkUI overlay implements. `view === null` means "remove", animated over `duration`
/// seconds; `bottomOffset` is the distance from the window bottom.
export interface NoticeContainer {
  showNotice(view: NoticeView, bottomOffset: number): void;
  hideNotice(duration: number): void;
  moveNotice(bottomOffset: number, duration: number): void;
}

export class NoticePresenter {
  private noticeView: NoticeView | null = null;
  private containerView: NoticeContainer | null = null;
  /// The attached overlay (the key window's container)
  private keyWindowContainer: NoticeContainer | null = null;
  private keyWindow: window.Window | null = null;

  private keyboardHeight: number = 0;
  private keyboardListening: boolean = false;
  private keyboardCallback: (height: number) => void = (height: number) => {
    this.keyboardDidChangeFrame(height);
  };

  /// The ArkUI overlay registers itself (and its window, for keyboard tracking).
  attachContainer(container: NoticeContainer | null, win: window.Window | null): void {
    this.keyWindowContainer = container;
    if (this.keyWindow !== win) {
      this.stopListeningToKeyboardNotifications();
      this.keyWindow = win;
    }
  }

  get bottomConstraintConstant(): number {
    if (this.keyboardHeight === 0) {
      return NOTICE_BOTTOM_MARGIN_CONSTANT;
    }
    return NOTICE_BOTTOM_MARGIN_CONSTANT + this.keyboardHeight;
  }

  // MARK: Lifecycle

  startListeningToKeyboardNotifications(): void {
    if (this.keyWindow === null || this.keyboardListening) {
      return;
    }
    this.keyWindow.on('keyboardHeightChange', this.keyboardCallback);
    this.keyboardListening = true;
  }

  stopListeningToKeyboardNotifications(): void {
    if (this.keyWindow === null || !this.keyboardListening) {
      return;
    }
    this.keyWindow.off('keyboardHeightChange', this.keyboardCallback);
    this.keyboardListening = false;
  }

  // MARK: Presenting Methods

  presentNoticeView(noticeView: NoticeView, completion: () => void): void {
    const containerView: NoticeContainer | null = this.prepareContainerView();
    if (containerView === null) {
      return;
    }
    this.noticeView = noticeView;
    containerView.showNotice(noticeView, this.bottomConstraintConstant);
    // display(view:in:): the slide-in animation runs for animationShortDuration
    setTimeout(() => {
      completion();
    }, ANIMATION_SHORT_DURATION * 1000);
  }

  private prepareContainerView(): NoticeContainer | null {
    if (this.keyWindowContainer === null) {
      return null;
    }
    this.containerView = this.keyWindowContainer;
    return this.containerView;
  }

  // MARK: Dismissing Methods

  dismissNotification(duration: number, completion: () => void): void {
    const containerView: NoticeContainer | null = this.containerView;
    if (containerView === null || this.noticeView === null) {
      return;
    }
    containerView.hideNotice(duration);
    setTimeout(() => {
      completion();
    }, duration * 1000);
    this.noticeView = null;
    this.containerView = null;
  }

  // MARK: Keyboard Observable

  private keyboardDidChangeFrame(height: number): void {
    // window reports px; the overlay lays out in vp
    let density: number = 1;
    try {
      density = display.getDefaultDisplaySync().densityPixels;
    } catch (e) {
      density = 1;
    }
    this.keyboardHeight = density > 0 ? height / density : height;
    this.animateNoticeToNewKeyboardLocation();
  }

  private animateNoticeToNewKeyboardLocation(): void {
    if (this.containerView === null) {
      return;
    }
    this.containerView.moveNotice(this.bottomConstraintConstant, ANIMATION_SHORT_DURATION);
  }
}

export class NoticeController implements NoticeInteractionDelegate {
  static readonly shared: NoticeController = new NoticeController();

  private current: Notice | null = null;
  private readonly noticePresenter: NoticePresenter;
  private readonly timerFactory: TimerFactory;
  private timerValue: NoticeTimer | null = null;

  constructor(presenter: NoticePresenter = new NoticePresenter(), timerFactory: TimerFactory = new TimerFactory()) {
    this.timerFactory = timerFactory;
    this.noticePresenter = presenter;
  }

  /// didSet { oldValue?.invalidate() }
  private get timer(): NoticeTimer | null {
    return this.timerValue;
  }

  private set timer(newValue: NoticeTimer | null) {
    const oldValue: NoticeTimer | null = this.timerValue;
    this.timerValue = newValue;
    if (oldValue !== null) {
      oldValue.invalidate();
    }
  }

  private get presenting(): boolean {
    return this.current !== null;
  }

  get presenter(): NoticePresenter {
    return this.noticePresenter;
  }

  setupNoticeController(): void {
    this.noticePresenter.startListeningToKeyboardNotifications();
  }

  // MARK: Presenting

  present(notice: Notice): void {
    if (this.presenting) {
      this.dismiss(0, () => {
        this.present(notice);
      });
      return;
    }

    this.current = notice;
    const noticeView: NoticeView = this.makeNoticeView(notice);

    this.noticePresenter.presentNoticeView(noticeView, () => {
      const delay: number = (this.current === null || this.current.action === null) ? NOTICE_SHORT_DELAY :
        NOTICE_LONG_DELAY;
      this.timer = this.timerFactory.scheduledTimer(delay, () => {
        this.dismiss();
      });
    });
  }

  private makeNoticeView(notice: Notice): NoticeView {
    const noticeView: NoticeView = new NoticeView();
    noticeView.message = notice.message;
    noticeView.actionTitle = notice.action === null ? null : notice.action.title;
    noticeView.handler = notice.action === null ? null : notice.action.handler;
    noticeView.delegate = this;
    return noticeView;
  }

  // MARK: Dismissing

  private dismiss(duration: number = ANIMATION_LONG_DURATION, completion: (() => void) | null = null): void {
    this.timer = null;
    this.current = null;

    this.noticePresenter.dismissNotification(duration, () => {
      if (completion !== null) {
        completion();
      }
    });
  }

  // MARK: NoticeInteractionDelegate

  noticePressBegan(): void {
    this.timer = null;
  }

  noticePressEnded(): void {
    this.timer = this.timerFactory.scheduledTimer(NOTICE_SHORT_DELAY, () => {
      this.dismiss();
    });
  }

  actionWasTapped(): void {
    this.dismiss();
  }
}

export { NoticeController as NoticeCenter };
