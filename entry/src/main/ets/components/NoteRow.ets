// Port of SPNoteTableViewCell (+ SPNoteTableViewCell.xib): one note row of the notes list.
// Pinned (icon_pin_small) sits in a leading column that is always reserved, so titles stay aligned;
// title row = title + published (icon_shared) symbol, body = optional date
// prefix followed by the body excerpt (hidden entirely in condensed mode, as rendersInCondensedMode does).
// previewString(from:): checklist markers render as checkbox glyphs (processChecklists, multiple per
// line) and every word containing a search keyword is tinted (apply(color:toSubstringsMatching:)).
import { LengthMetrics } from '@kit.ArkUI';
import { Options } from '../common/OptionsStore';

/// One run of a rendered preview line: plain / highlighted text, or a checklist glyph.
interface PreviewPart {
  text: string;
  highlighted: boolean;
  checkbox: boolean;
  checked: boolean;
}

/// NSRegularExpression.regexForChecklistsEmbeddedAnywhere's marker group.
const CHECKLIST_PATTERN: string = '-[ \\t]+\\[[xX\\s]?\\]';
/// Words, as String.contentSlice(matching:) splits them (the same pattern Note.bodyExcerpt uses).
const WORD_PATTERN: string = '[^\\s.,;:!?"()\\[\\]{}<>\\/\\\\|@#$%^&*+=~`\\-]+';
/// HarmonyOS list row: 16vp side margin, 12vp vertical padding, 16vp status symbols, 2vp text gap.
const INSET_VERTICAL: number = 9;
/// Style.containerInsets.left / accessoryImagePaddingRight: pin column at 6vp, labels at 6 + 16 + 6.
const INSET_LEADING: number = 6;
const INSET_HORIZONTAL: number = 16;
const ACCESSORY_SIZE: number = 16;
const ACCESSORY_GAP: number = 6;
const LABEL_SPACING: number = 2;
const CHECKBOX_SIZE: number = 15;
/// UIFont.preferredFont(forTextStyle: .headline).lineHeight at the default content size, and Constants.minCellHeight.
const HEADLINE_LINE_HEIGHT: number = 20.29;
const MIN_CELL_HEIGHT: number = 48;

/// SPNoteTableViewCell.cellHeight: every note row gets the same height from the preview-line setting
/// (regular / condensed), not from its content.
// ponytail: fixed default-size line height; rows still grow past it at large font scales instead of scaling with it.
function cellHeight(): number {
  const options: Options = Options.shared;
  const spacing: number = options.condensedNotesList ? 0 : LABEL_SPACING;
  const height: number = INSET_VERTICAL + spacing + options.numberOfPreviewLines * HEADLINE_LINE_HEIGHT + INSET_VERTICAL;
  return Math.max(Math.ceil(height), MIN_CELL_HEIGHT);
}

function makePart(text: string, highlighted: boolean, checkbox: boolean, checked: boolean): PreviewPart {
  const part: PreviewPart = { text: text, highlighted: highlighted, checkbox: checkbox, checked: checked };
  return part;
}

function fold(text: string): string {
  return text.normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toLowerCase();
}

/// Splits `text` so that each word containing a (folded) keyword is its own highlighted run.
function appendText(parts: PreviewPart[], text: string, keywords: string[]): void {
  if (text.length === 0) {
    return;
  }
  if (keywords.length === 0) {
    parts.push(makePart(text, false, false, false));
    return;
  }
  const words: RegExp = new RegExp(WORD_PATTERN, 'g');
  let last: number = 0;
  let match: RegExpExecArray | null = words.exec(text);
  while (match !== null) {
    const word: string = match[0];
    const folded: string = fold(word);
    if (keywords.some((keyword: string): boolean => folded.indexOf(keyword) !== -1)) {
      if (match.index > last) {
        parts.push(makePart(text.substring(last, match.index), false, false, false));
      }
      parts.push(makePart(word, true, false, false));
      last = match.index + word.length;
    }
    match = words.exec(text);
  }
  if (last < text.length) {
    parts.push(makePart(text.substring(last), false, false, false));
  }
}

/// previewString(from:highlighing:): checklists first, then keyword highlight over the text runs.
function previewParts(text: string, keywords: string[]): PreviewPart[] {
  const folded: string[] = keywords.filter((k: string): boolean => k.length > 0).map((k: string): string => fold(k));
  const parts: PreviewPart[] = [];
  const checklists: RegExp = new RegExp(CHECKLIST_PATTERN, 'g');
  let last: number = 0;
  let match: RegExpExecArray | null = checklists.exec(text);
  while (match !== null) {
    appendText(parts, text.substring(last, match.index), folded);
    // allowsMultiplePerLine: a marker that is not at the start gets a leading space.
    if (match.index !== 0) {
      parts.push(makePart(' ', false, false, false));
    }
    parts.push(makePart('', false, true, match[0].toLowerCase().indexOf('x') !== -1));
    last = match.index + match[0].length;
    match = checklists.exec(text);
  }
  appendText(parts, text.substring(last), folded);
  return parts;
}

@Component
export struct SPNoteTableViewCell {
  @Prop titleText: string = '';
  @Prop bodyText: string = '';
  /// Date prefix, only set while searching with a date-based sort mode.
  @Prop prefixText: string = '';
  @Prop pinned: boolean = false;
  @Prop published: boolean = false;
  @Prop condensed: boolean = false;
  /// Search keywords to highlight (empty when not searching).
  @Prop keywords: string[] = [];
  build() {
    // The label container is centred vertically, keeping >= 12 above and below, inside a cellHeight row.
    Column() {
      Row() {
        // Left accessory (note.pinned), centred on the title's first line.
        Column() {
          if (this.pinned) {
            Image($r('app.media.ic_pin_small'))
              .width(ACCESSORY_SIZE)
              .height(ACCESSORY_SIZE)
              .fillColor($r('app.color.simplenote_note_pin_status_image'))
              .accessibilityText('Pinned')
          }
        }
        .width(ACCESSORY_SIZE)
        .height(HEADLINE_LINE_HEIGHT)
        .justifyContent(FlexAlign.Center)
        .margin({ end: LengthMetrics.vp(ACCESSORY_GAP) })
        Column() {
          Row() {
            // Span children take precedence over the Text content; the content is the plain-title fallback.
            Text(this.titleText) {
              ForEach(previewParts(this.titleText, this.keywords), (part: PreviewPart) => {
                if (part.checkbox) {
                  // System symbol checkbox: its colour is a theme resource, so it follows dark mode.
                  SymbolSpan(part.checked ? $r('sys.symbol.checkmark_square_fill') : $r('sys.symbol.square'))
                    .fontSize(CHECKBOX_SIZE + 2)
                    .fontColor([$r('app.color.simplenote_text')])
                } else {
                  Span(part.text)
                    .fontColor(part.highlighted ? $r('app.color.simplenote_tint') : $r('app.color.simplenote_text'))
                }
              }, (part: PreviewPart, index: number): string =>
                index.toString() + (part.checkbox ? (part.checked ? 'X' : 'O') : (part.highlighted ? 'H' : 'T')) + part.text)
            }
            .fontSize($r('sys.float.Body_L'))
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.simplenote_text'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            // Style.paragraphStyle .byTruncatingTail: cut at the last fitting character, not a word break.
            .wordBreak(WordBreak.BREAK_ALL)
            .layoutWeight(1)
            // Right accessory (note.published).
            if (this.published) {
              Image($r('app.media.ic_shared'))
                .width(ACCESSORY_SIZE)
                .height(ACCESSORY_SIZE)
                .fillColor($r('app.color.simplenote_note_share_status_image'))
                .margin({ start: LengthMetrics.vp(ACCESSORY_GAP) })
                .accessibilityText('Published')
            }
          }
          .width('100%')
          .alignItems(VerticalAlign.Center)
          if (!this.condensed) {
            Text(this.bodyText) {
              // prefixText (the date): Body_S in the secondary text colour, followed by a space.
              if (this.prefixText.length > 0) {
                Span(this.prefixText + ' ')
                  .fontSize($r('sys.float.Body_S'))
                  .fontColor($r('sys.color.font_secondary'))
              }
              ForEach(previewParts(this.bodyText, this.keywords), (part: PreviewPart) => {
                if (part.checkbox) {
                  SymbolSpan(part.checked ? $r('sys.symbol.checkmark_square_fill') : $r('sys.symbol.square'))
                    .fontSize(CHECKBOX_SIZE)
                    .fontColor([$r('app.color.simplenote_note_body_preview')])
                } else {
                  Span(part.text)
                    .fontColor(part.highlighted ? $r('app.color.simplenote_tint') : $r('app.color.simplenote_note_body_preview'))
                }
              }, (part: PreviewPart, index: number): string =>
                index.toString() + (part.checkbox ? (part.checked ? 'X' : 'O') : (part.highlighted ? 'H' : 'T')) + part.text)
            }
            .fontSize($r('sys.float.Body_M'))
            .fontColor($r('app.color.simplenote_note_body_preview'))
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
            .margin({ top: LABEL_SPACING })
          }
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')
      .alignItems(VerticalAlign.Top)
    }
    .width('100%')
    .constraintSize({ minHeight: cellHeight() })
    .justifyContent(FlexAlign.Center)
    .padding({
      top: LengthMetrics.vp(INSET_VERTICAL),
      bottom: LengthMetrics.vp(INSET_VERTICAL),
      start: LengthMetrics.vp(INSET_LEADING),
      end: LengthMetrics.vp(INSET_HORIZONTAL)
    })
  }
}
