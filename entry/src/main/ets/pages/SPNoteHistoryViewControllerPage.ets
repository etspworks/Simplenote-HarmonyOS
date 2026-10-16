// Port of SPNoteHistoryViewController (.swift + .xib) + SPNoteHistoryController — presentation: sheet
// (card), hosted by SPNoteEditorViewControllerPage and reading its note. Structure: dismiss cross,
// date label / spinner, snapping version slider, 'Restore Note'; or the error message alone.
import { hilog } from '@kit.PerformanceAnalysisKit';
import {
  NoteHistoryState,
  NoteHistoryStateKind,
  SPNoteHistoryController,
  SPNoteHistoryControllerDelegate,
  VersionRange
} from '../common/VersionsService';
import { SPTracker } from '../common/Tracker';
import { Note } from '../model/Note';
import { SPCardPresentationController } from '../components/CardPresentation';
import { SPSnappingSlider } from '../components/SnappingSlider';
import { HmIconButton } from '../components/HmIconButton';

const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'NoteHistory';
// ponytail: fixed re-request cadence; replace with a channel-authenticated signal if the data layer grows one.
const VERSIONS_RETRY_MS: number = 3000;
const VERSIONS_MAX_RETRIES: number = 10;

/// SPNoteHistoryControllerDelegate -> the host editor's callbacks
class HistoryDelegate implements SPNoteHistoryControllerDelegate {
  private readonly didCancel: () => void;
  private readonly didFinish: () => void;
  private readonly didSelect: (content: string) => void;

  constructor(didCancel: () => void, didFinish: () => void, didSelect: (content: string) => void) {
    this.didCancel = didCancel;
    this.didFinish = didFinish;
    this.didSelect = didSelect;
  }

  noteHistoryControllerDidCancel(): void {
    this.didCancel();
  }

  noteHistoryControllerDidFinish(): void {
    this.didFinish();
  }

  noteHistoryControllerDidSelectVersion(content: string): void {
    this.didSelect(content);
  }
}

@Component
export struct SPNoteHistoryViewController {
  /// host editor's note
  @Link note: Note | null;
  /// VersionsController.range(currentVersion) (max 30)
  @State versionRange: VersionRange = new VersionRange(1, 1);
  /// slider value
  @State selectedVersion: number = 1;
  /// version | loadingVersion | error
  @State historyState: NoteHistoryStateKind = NoteHistoryStateKind.LOADING_VERSION;
  /// SPHistoryVersion.modificationDate (formatted)
  @State versionDate: string = '';
  @State isRestorable: boolean = false;
  @State errorMessage: string = '';
  private controller: SPNoteHistoryController | null = null;
  /// true once any version arrived (stops the re-request timer)
  private receivedVersion: boolean = false;
  private retryTimer: number = -1;
  private retries: number = 0;
  /// noteHistoryControllerDidCancel: dismiss + restore the original content
  onCancel: () => void = (): void => {
    hilog.info(DOMAIN, LOG_TAG, 'cancel with no host handler');
  };
  /// noteHistoryControllerDidFinish: dismiss + save the previewed version
  onFinish: () => void = (): void => {
    hilog.info(DOMAIN, LOG_TAG, 'finish with no host handler');
  };
  /// noteHistoryControllerDidSelectVersion(withContent:): the editor previews that version
  onSelectVersion: (content: string) => void = (content: string): void => {
    hilog.info(DOMAIN, LOG_TAG, 'version selected with no host handler (%{public}d chars)', content.length);
  };

  /// viewDidLoad
  aboutToAppear(): void {
    const note: Note | null = this.note;
    if (note === null) {
      this.historyState = NoteHistoryStateKind.ERROR;
      return;
    }
    const controller: SPNoteHistoryController = new SPNoteHistoryController(note);
    controller.delegate = new HistoryDelegate(
      (): void => {
        this.onCancel();
      },
      (): void => {
        this.onFinish();
      },
      (content: string): void => {
        this.onSelectVersion(content);
      });
    this.controller = controller;
    this.versionRange = controller.versionRange;
    controller.observer = (state: NoteHistoryState): void => {
      this.update(state);
    };
    controller.onViewLoad();
    this.scheduleVersionsRetry();
    SPTracker.trackEditorVersionsAccessed();
  }

  /// The e:<key>.<version> requests are dropped when sent before the Simperium socket is open and
  /// the channel authenticated (cold deep-link launch); the channel clears retrievingObjectHistory on
  /// auth, so re-issue the load while nothing has arrived yet.
  private scheduleVersionsRetry(): void {
    this.retryTimer = setTimeout((): void => {
      this.retryTimer = -1;
      if (this.controller === null || this.receivedVersion ||
        this.historyState !== NoteHistoryStateKind.LOADING_VERSION || this.retries >= VERSIONS_MAX_RETRIES) {
        return;
      }
      this.retries++;
      hilog.info(DOMAIN, LOG_TAG, 'no version yet, re-requesting (%{public}d)', this.retries);
      this.controller.onViewLoad();
      this.scheduleVersionsRetry();
    }, VERSIONS_RETRY_MS);
  }

  aboutToDisappear(): void {
    if (this.retryTimer >= 0) {
      clearTimeout(this.retryTimer);
      this.retryTimer = -1;
    }
    if (this.controller !== null) {
      this.controller.observer = null;
      this.controller.dispose();
    }
  }

  /// update(with:)
  private update(state: NoteHistoryState): void {
    this.historyState = state.kind;
    if (state.kind === NoteHistoryStateKind.ERROR) {
      this.errorMessage = state.errorMessage;
      return;
    }
    if (state.versionNumber !== null) {
      this.selectedVersion = state.versionNumber;
    }
    if (state.kind === NoteHistoryStateKind.VERSION) {
      this.receivedVersion = true;
      this.versionDate = state.date;
      this.isRestorable = state.isRestorable;
    } else {
      this.isRestorable = false;
    }
  }

  private handleTapOnCloseButton(): void {
    if (this.controller !== null) {
      this.controller.handleTapOnCloseButton();
    } else {
      this.onCancel();
    }
  }

  private handleTapOnRestoreButton(): void {
    SPTracker.trackEditorNoteRestored();
    if (this.controller !== null) {
      this.controller.handleTapOnRestoreButton();
    }
  }

  @Builder
  cardContent() {
    // vertical stack (spacing 24) with the 16vp HarmonyOS side margin
    Column({ space: 24 }) {
      // header row (spacing 8): date / activity indicator / error message + dismissButton
      Row({ space: 8 }) {
        if (this.historyState === NoteHistoryStateKind.ERROR) {
          // switchToErrorMessage hides the date; the message itself is the centred overlay below.
        } else if (this.historyState === NoteHistoryStateKind.LOADING_VERSION) {
          // activityIndicator
          LoadingProgress()
            .width(24)
            .height(24)
            .color($r('app.color.simplenote_text'))
        } else {
          // dateLabel: the sheet header title
          Text(this.versionDate)
            .fontSize($r('sys.float.Title_S'))
            .fontWeight(FontWeight.Bold)
            .fontColor($r('sys.color.font_primary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
        }
        Blank()
        // dismissButton: HarmonyOS xmark close ('Dismiss History')
        HmIconButton({
          symbol: $r('sys.symbol.xmark'),
          label: 'Dismiss History',
          buttonId: 'history_dismiss',
          action: (): void => {
            this.handleTapOnCloseButton();
          }
        })
      }
      .width('100%')
      .constraintSize({ minHeight: 40 })

      // switchToErrorMessage: slider + restore button go to alpha 0 (setSliderAndActionButtonVisible),
      // they stay laid out so the card does not jump.
      Column({ space: 24 }) {
        SPSnappingSlider({
          sliderId: 'history_version_slider',
          minimumValue: this.versionRange.lowerBound,
          maximumValue: this.versionRange.upperBound,
          step: 1,
          value: this.selectedVersion,
          onSnappedValueChange: (value: number): void => {
            if (this.controller !== null) {
              this.controller.select(value);
            }
          }
        })
        Column() {
          // HarmonyOS capsule button: filled brand, dimmed to the system disabled alpha when not restorable.
          Button('Restore Note', { type: ButtonType.Capsule, stateEffect: true })
            .id('history_restore')
            .width('100%')
            .height(40)
            .fontSize($r('sys.float.Body_L'))
            .fontWeight(FontWeight.Medium)
            .fontColor($r('sys.color.font_on_primary'))
            .backgroundColor($r('sys.color.brand'))
            .opacity((this.historyState === NoteHistoryStateKind.VERSION && this.isRestorable) ?
              1 : $r('sys.float.interactive_disable'))
            .onClick((): void => {
              this.handleTapOnRestoreButton();
            })
        }
        .width('100%')
        .enabled(this.historyState === NoteHistoryStateKind.VERSION && this.isRestorable)
      }
      .width('100%')
      .opacity(this.historyState === NoteHistoryStateKind.ERROR ? 0 : 1)
      // UIKit skips hit-testing for alpha-0 views; opacity 0 alone still takes touches here.
      .enabled(this.historyState !== NoteHistoryStateKind.ERROR)
    }
    .width('100%')
    .padding(16)
    .overlay(this.errorMessageLabel(), { align: Alignment.Center })
  }

  /// errorMessageLabel: its own label, centred (textAlignment center, numberOfLines 0) and pinned to the
  /// whole vertical stack in the xib, so the message sits in the middle of the card, not in the header row.
  @Builder
  errorMessageLabel() {
    if (this.historyState === NoteHistoryStateKind.ERROR) {
      Text(this.errorMessage)
        .fontSize($r('sys.float.Body_L'))
        .fontColor($r('app.color.simplenote_text'))
        .textAlign(TextAlign.Center)
        .width('100%')
        .padding({ left: 16, right: 16 })
        .hitTestBehavior(HitTestMode.None)
    }
  }

  build() {
    Column() {
      SPCardPresentationController() {
        this.cardContent()
      }
    }
    .id('screen_note_history')
    .width('100%')
  }
}
