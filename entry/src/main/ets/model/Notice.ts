// Port of Notice.swift and NoticeAction.swift: a toast message with an optional action (Undo).

export class NoticeAction {
  title: string;
  handler: () => void;

  constructor(title: string, handler: () => void) {
    this.title = title;
    this.handler = handler;
  }
}

export class Notice {
  message: string;
  action: NoticeAction | null;

  constructor(message: string, action: NoticeAction | null = null) {
    this.message = message;
    this.action = action;
  }

  get hasAction(): boolean {
    return this.action !== null;
  }

  /** Equatable: two notices are equal when their messages are */
  equals(other: Notice): boolean {
    return this.message === other.message;
  }
}
