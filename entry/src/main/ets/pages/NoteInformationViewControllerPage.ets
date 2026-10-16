// Port of NoteInformationViewController.swift (+ .xib) — presentation: sheet (card), hosted by
// SPNoteEditorViewControllerPage (.bindSheet, system drag bar), reading the host's note. Structure: an
// 'Information' sheet title, then the NoteInformationController sections as HarmonyOS cards: metric rows
// (Value1 cells), and — only when another note links to this one — a 'Referenced In' header + a card
// with one subtitle row per note.
// No 'Document' title / Done: iOS shows those only inside the iPad popover's navigation controller
// (presentInformationController); the phone card closes by swipe down or tap outside (bindSheet).
import { LengthMetrics } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { ShortcutsHandler } from '../common/DeepLinkRouter';
import {
  NoteInformationController,
  NoteInformationRow,
  NoteInformationRowKind,
  NoteInformationSection
} from '../common/NoteInformationService';
import { Note } from '../model/Note';
import { Value1TableViewCell } from '../components/Value1Cell';
import { SubtitleTableViewCell } from '../components/SubtitleCell';
import { TableHeaderViewCell } from '../components/TableHeaderCell';

const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'NoteInformation';

@Component
export struct NoteInformationViewController {
  /// The host editor's note
  @Link note: Note | null;
  /// metricSection() rows
  @State metrics: NoteInformationRow[] = [];
  /// referenceSections(): the header row + one row per referencing note (empty when none)
  @State references: NoteInformationRow[] = [];
  /// note.plainInternalLink — the key the referencesController fetches by (null: no references controller)
  @State plainInternalLink: string | null = null;
  private controller: NoteInformationController | null = null;
  /// handleTapOnDismissButton -> onDismissCallback
  onDismiss: () => void = (): void => {
    hilog.info(DOMAIN, LOG_TAG, 'dismiss requested with no host handler');
  };

  aboutToAppear(): void {
    if (this.note === null) {
      return;
    }
    this.plainInternalLink = (this.note as Note).plainInternalLink;
    const controller: NoteInformationController = new NoteInformationController(this.note as Note);
    this.controller = controller;
    // startListeningForControllerChanges
    controller.observer = (sections: NoteInformationSection[]): void => {
      this.update(sections);
    };
  }

  aboutToDisappear(): void {
    if (this.controller !== null) {
      this.controller.observer = null;
    }
  }

  private update(sections: NoteInformationSection[]): void {
    this.metrics = sections.length > 0 ? sections[0].rows : [];
    const refs: NoteInformationRow[] = [];
    for (let i: number = 1; i < sections.length; i++) {
      for (const row of sections[i].rows) {
        refs.push(row);
      }
    }
    this.references = refs;
  }

  /// tableView(_:didSelectRowAt:): a reference row opens the linking note's interlink URL.
  private didSelectReference(row: NoteInformationRow): void {
    if (row.interLink === null) {
      return;
    }
    ShortcutsHandler.shared.handleOpenURL(row.interLink as string);
  }

  /// A rounded HarmonyOS list card on the sheet background (same look as Settings).
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

  @Builder
  cardContent() {
    Column() {
      // HarmonyOS sheet header: left-aligned title (the system drag bar sits above it; no close button,
      // the card closes by swipe down, tap outside or back, as before).
      Row() {
        Text('Information')
          .fontSize($r('sys.float.Title_S'))
          .fontWeight(FontWeight.Bold)
          .fontColor($r('sys.color.font_primary'))
          .maxLines(1)
      }
      .width('100%')
      .height(56)
      .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16) })

      Scroll() {
        Column({ space: 12 }) {
          Column() {
            ForEach(this.metrics, (row: NoteInformationRow, index: number) => {
              if (index > 0) {
                this.rowDivider()
              }
              Value1TableViewCell({
                title: row.title,
                value: row.value ?? '',
                selectable: true,
                hasClearBackground: true,
                onTap: (): void => {
                  hilog.info(DOMAIN, LOG_TAG, 'metric row is not selectable');
                }
              })
            }, (row: NoteInformationRow, index: number): string => `metric|${index}|${row.title}|${row.value ?? ''}`)
          }
          .card()

          // hasReferences: other notes link to this note's plainInternalLink -> 'Referenced In' section;
          // noReferences (no link, or referencesController.fetchedObjects empty): metrics section only.
          if (this.plainInternalLink !== null && this.references.length > 0) {
            Column() {
              ForEach(this.references, (row: NoteInformationRow) => {
                if (row.kind === NoteInformationRowKind.HEADER) {
                  TableHeaderViewCell({ title: row.title })
                }
              }, (row: NoteInformationRow): string => `${row.kind}|${row.title}`)
              Column() {
                ForEach(this.referenceRows(), (row: NoteInformationRow, index: number) => {
                  if (index > 0) {
                    this.rowDivider()
                  }
                  SubtitleTableViewCell({ title: row.title, value: row.value ?? '' })
                    // The source reference cell carries no accessibilityIdentifier; replay matches it by text.
                    .stateStyles({
                      normal: {
                        .backgroundColor(Color.Transparent)
                      },
                      pressed: {
                        .backgroundColor($r('sys.color.interactive_pressed'))
                      }
                    })
                    .onClick((): void => {
                      this.didSelectReference(row);
                    })
                }, (row: NoteInformationRow, index: number): string =>
                  `${index}|${row.interLink ?? ''}|${row.title}|${row.value ?? ''}`)
              }
              .card()
            }
            .width('100%')
          }
        }
        .width('100%')
        .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16), bottom: LengthMetrics.vp(16) })
      }
      .width('100%')
      .scrollBar(BarState.Off)
    }
    .width('100%')
  }

  /// The reference rows of the 'Referenced In' section (its header row is drawn above the card).
  private referenceRows(): NoteInformationRow[] {
    return this.references.filter((row: NoteInformationRow): boolean => row.kind === NoteInformationRowKind.REFERENCE);
  }

  build() {
    Column() {
      this.cardContent()
    }
    .id('screen_note_information')
    .width('100%')
    // grouped sheet background so the cards read as cards (the sheet itself does the rounding)
    .backgroundColor($r('sys.color.background_secondary'))
  }
}
