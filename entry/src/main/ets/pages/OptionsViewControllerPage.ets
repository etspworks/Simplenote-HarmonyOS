// Port of OptionsViewController (.swift + .xib) — presentation: sheet, hosted by
// SPNoteEditorViewControllerPage (.bindSheet) and reading the host's note. Structure: HarmonyOS sheet
// header ('Options' + xmark close), then four card groups:
// [Pin to Top, Markdown, Copy Internal Link, Share, History] [Publish, Copy Link] [Collaborate] [Move to Trash].
// Also ports PublishNoticePresenter (the notices shown as a publish state change lands).
import { router, LengthMetrics } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { copyInternalLink, copyPublicLink } from '../common/NotePasteboard';
import { NoteStore } from '../common/NoteStore';
import { NoticeController, NoticeFactory } from '../common/NoticeCenter';
import { Options } from '../common/OptionsStore';
import { PublishController } from '../common/PublishService';
import { SPTracker } from '../common/Tracker';
import { Note, PublishState } from '../model/Note';
import { SwitchTableViewCell } from '../components/SwitchCell';
import { Value1TableViewCell } from '../components/Value1Cell';
import { HmIconButton } from '../components/HmIconButton';

const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'NoteOptions';

/// Set by the Collaborators page when it goes back to Options; the editor re-presents the Options sheet.
export const REOPEN_NOTE_OPTIONS_KEY: string = 'reopenNoteOptions';

export class CollaboratorsRouteParams {
  noteKey: string = '';
}

/// PublishNoticePresenter.presentNotice(for:)
export function presentPublishNotice(note: Note): void {
  switch (note.publishState) {
    case PublishState.PUBLISHING:
      NoticeController.shared.present(NoticeFactory.publishing());
      break;
    case PublishState.PUBLISHED:
      NoticeController.shared.present(NoticeFactory.published((): void => {
        copyPublicLink(note.publicLink ?? undefined).then((copied: boolean): void => {
          if (copied) {
            NoticeController.shared.present(NoticeFactory.linkCopied());
          }
        });
      }));
      break;
    case PublishState.UNPUBLISHING:
      NoticeController.shared.present(NoticeFactory.unpublishing());
      break;
    default:
      NoticeController.shared.present(NoticeFactory.unpublished((): void => {
        PublishController.shared.updatePublishState(note, true);
      }));
      break;
  }
}

@Component
export struct OptionsViewController {
  /// host editor's note (sheet reads the host state)
  @Link note: Note | null;
  /// Note.pinned / .markdown / .published (systemTags) and Note.publishURL (arrives via sync)
  @State pinned: boolean = false;
  @State markdown: boolean = false;
  @State published: boolean = false;
  @State publishURL: string = '';
  private pendingUpdate: boolean = false;
  private changeListener: () => void = (): void => {
    this.entityDidChange();
  };
  /// OptionsControllerDelegate.optionsControllerDidPressHistory -> host presents the history sheet.
  onHistory: () => void = (): void => {
    hilog.info(DOMAIN, LOG_TAG, 'history requested with no host handler');
  };
  /// optionsControllerDidPressShare -> host presents the share sheet.
  onShare: () => void = (): void => {
    hilog.info(DOMAIN, LOG_TAG, 'share requested with no host handler');
  };
  /// Dismiss the sheet (Done).
  onDismiss: () => void = (): void => {
    hilog.info(DOMAIN, LOG_TAG, 'dismiss requested with no host handler');
  };
  /// optionsControllerDidPressTrash -> host trashes the note and dismisses the editor.
  onTrash: () => void = (): void => {
    hilog.info(DOMAIN, LOG_TAG, 'trash requested with no host handler');
  };

  aboutToAppear(): void {
    if (PublishController.shared.onUpdate === null) {
      PublishController.shared.onUpdate = (note: Note): void => {
        presentPublishNotice(note);
      };
    }
    NoteStore.sharedManager().addChangeListener(this.changeListener);
    this.refreshInterface();
  }

  aboutToDisappear(): void {
    NoteStore.sharedManager().removeChangeListener(this.changeListener);
  }

  /// EntityObserverDelegate: a change we caused ourselves is skipped once.
  private entityDidChange(): void {
    if (this.pendingUpdate) {
      this.pendingUpdate = false;
      return;
    }
    this.refreshInterface();
  }

  private refreshInterface(): void {
    const note: Note | null = this.note;
    if (note === null) {
      return;
    }
    this.pinned = note.pinned;
    this.markdown = note.markdown;
    this.published = note.published;
    this.publishURL = note.publishURL ?? '';
  }

  /// canCopyLink(to:)
  private canCopyLink(): boolean {
    return this.published && this.publishURL.length > 0;
  }

  // MARK: - Actions

  private pinnedWasPressed(newState: boolean): void {
    const note: Note | null = this.note;
    if (note === null) {
      return;
    }
    SPTracker.trackEditorNotePinEnabled(newState);
    NoteStore.sharedManager().updatePinnedState(newState, note);
    this.pinned = newState;
    this.pendingUpdate = true;
  }

  private markdownWasPressed(newState: boolean): void {
    const note: Note | null = this.note;
    if (note === null) {
      return;
    }
    SPTracker.trackEditorNoteMarkdownEnabled(newState);
    Options.shared.markdown = newState;
    NoteStore.sharedManager().updateMarkdownState(newState, note);
    this.markdown = newState;
    this.pendingUpdate = true;
  }

  private copyInterlinkWasPressed(): void {
    const note: Note | null = this.note;
    if (note === null) {
      return;
    }
    SPTracker.trackEditorCopiedInternalLink();
    copyInternalLink(note.markdownInternalLink ?? undefined).then((copied: boolean): void => {
      hilog.info(DOMAIN, LOG_TAG, 'internal link copied to pasteboard: %{public}s', String(copied));
    }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'copy internal link failed: %{public}s', e.message);
    });
    // Source presents the notice unconditionally, right after the pasteboard write.
    NoticeController.shared.present(NoticeFactory.linkCopied());
    this.onDismiss();
  }

  private shareWasPressed(): void {
    this.onShare();
  }

  private historyWasPressed(): void {
    this.onHistory();
  }

  private publishWasPressed(newState: boolean): void {
    const note: Note | null = this.note;
    if (note === null) {
      return;
    }
    SPTracker.trackEditorNotePublishEnabled(newState);
    PublishController.shared.updatePublishState(note, newState);
    this.published = newState;
    this.pendingUpdate = true;
  }

  private copyLinkWasPressed(): void {
    const note: Note | null = this.note;
    if (note === null || !this.canCopyLink()) {
      return;
    }
    SPTracker.trackEditorCopiedPublicLink();
    copyPublicLink(note.publicLink ?? undefined).then((copied: boolean): void => {
      hilog.info(DOMAIN, LOG_TAG, 'public link copied to pasteboard: %{public}s', String(copied));
    }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'copy public link failed: %{public}s', e.message);
    });
    NoticeController.shared.present(NoticeFactory.linkCopied());
    this.onDismiss();
  }

  /// collaborateWasPressed -> push SPAddCollaboratorsViewController.
  collaborateWasPressed(): void {
    const note: Note | null = this.note;
    SPTracker.trackEditorCollaboratorsAccessed();
    const params: CollaboratorsRouteParams = new CollaboratorsRouteParams();
    params.noteKey = note === null ? '' : note.simperiumKey;
    this.onDismiss();
    router.pushUrl({ url: 'pages/SPAddCollaboratorsViewControllerPage', params: params }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'collaborators failed: %{public}s', e.message);
    });
  }

  private trashWasPressed(): void {
    this.onTrash();
  }

  private doneWasPressed(): void {
    this.onDismiss();
  }

  /// A rounded HarmonyOS list card on the grouped sheet background (same look as Settings).
  @Styles
  card() {
    .width('100%')
    .backgroundColor($r('sys.color.comp_background_list_card'))
    .borderRadius($r('sys.float.corner_radius_level8'))
    .clip(true)
  }

  /// Inset divider between two rows of one card.
  @Builder
  rowDivider() {
    Divider()
      .strokeWidth('1px')
      .color($r('sys.color.comp_divider'))
      .margin({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16) })
  }

  build() {
    Column() {
      // HarmonyOS sheet header: left-aligned title and an xmark close (same handler and id as Done).
      Row() {
        Text($r('app.string.options'))
          .fontSize($r('sys.float.Title_S'))
          .fontWeight(FontWeight.Bold)
          .fontColor($r('sys.color.font_primary'))
          .maxLines(1)
          .layoutWeight(1)
        HmIconButton({
          symbol: $r('sys.symbol.xmark'),
          label: 'Done',
          buttonId: 'note_options_done',
          action: (): void => {
            this.doneWasPressed();
          }
        })
      }
      .width('100%')
      .height(56)
      .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16) })

      Scroll() {
        Column({ space: 12 }) {
          Column() {
            SwitchTableViewCell({
              cellId: 'note_options_pin_to_top',
              symbol: $r('sys.symbol.pin'),
              title: $r('app.string.pin_to_top'),
              isOn: this.pinned,
              pressEffect: true,
              onChange: (isOn: boolean): void => {
                this.pinnedWasPressed(isOn);
              }
            })
            this.rowDivider()
            SwitchTableViewCell({
              cellId: 'note_options_markdown',
              symbol: $r('sys.symbol.textformat'),
              title: 'Markdown',
              isOn: this.markdown,
              pressEffect: true,
              onChange: (isOn: boolean): void => {
                this.markdownWasPressed(isOn);
              }
            })
            this.rowDivider()
            Value1TableViewCell({
              cellId: 'note_options_copy_internal_link',
              symbol: $r('sys.symbol.link'),
              title: $r('app.string.copy_internal_link'),
              pressEffect: true,
              onTap: (): void => {
                this.copyInterlinkWasPressed();
              }
            })
            this.rowDivider()
            Value1TableViewCell({
              cellId: 'note_options_share',
              symbol: $r('sys.symbol.share'),
              title: 'Share',
              pressEffect: true,
              onTap: (): void => {
                this.shareWasPressed();
              }
            })
            this.rowDivider()
            Value1TableViewCell({
              cellId: 'note_options_history',
              symbol: $r('sys.symbol.clock'),
              title: 'History',
              pressEffect: true,
              onTap: (): void => {
                this.historyWasPressed();
              }
            })
          }
          .card()

          Column() {
            SwitchTableViewCell({
              cellId: 'note_options_publish',
              symbol: $r('sys.symbol.doc_text_badge_arrow_up'),
              title: 'Publish',
              isOn: this.published,
              pressEffect: true,
              onChange: (isOn: boolean): void => {
                this.publishWasPressed(isOn);
              }
            })
            this.rowDivider()
            // copyLinkText(for:) / canCopyLink(to:)
            if (this.published && this.publishURL.length === 0) {
              Value1TableViewCell({
                cellId: 'note_options_copy_public_link',
                symbol: $r('sys.symbol.doc_text_on_doc_text'),
                title: $r('app.string.publishing'),
                selectable: false,
                pressEffect: true,
                onTap: (): void => {
                  this.copyLinkWasPressed();
                }
              })
            } else if (!this.published && this.publishURL.length > 0) {
              Value1TableViewCell({
                cellId: 'note_options_copy_public_link',
                symbol: $r('sys.symbol.doc_text_on_doc_text'),
                title: $r('app.string.unpublishing'),
                selectable: false,
                pressEffect: true,
                onTap: (): void => {
                  this.copyLinkWasPressed();
                }
              })
            } else {
              Value1TableViewCell({
                cellId: 'note_options_copy_public_link',
                symbol: $r('sys.symbol.doc_text_on_doc_text'),
                title: $r('app.string.copy_link_2'),
                selectable: this.canCopyLink(),
                pressEffect: true,
                onTap: (): void => {
                  this.copyLinkWasPressed();
                }
              })
            }
          }
          .card()

          Column() {
            Value1TableViewCell({
              cellId: 'note_options_collaborate',
              symbol: $r('sys.symbol.person_2'),
              title: 'Collaborate',
              showsDisclosure: true,
              pressEffect: true,
              onTap: (): void => {
                this.collaborateWasPressed();
              }
            })
          }
          .card()

          Column() {
            Value1TableViewCell({
              cellId: 'note_options_move_to_trash',
              symbol: $r('sys.symbol.trash'),
              title: $r('app.string.move_to_trash'),
              titleColor: $r('sys.color.warning'),
              imageTintColor: $r('sys.color.warning'),
              pressEffect: true,
              onTap: (): void => {
                this.trashWasPressed();
              }
            })
          }
          .card()
        }
        .width('100%')
        .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16), top: LengthMetrics.vp(4), bottom: LengthMetrics.vp(16) })
      }
      .width('100%')
      .layoutWeight(1)
      .align(Alignment.Top)
      .scrollBar(BarState.Off)
    }
    .id('screen_note_options')
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.background_secondary'))
  }
}
