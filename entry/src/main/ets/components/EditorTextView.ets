// Port of SPEditorTextView (.h/.m): the note body editor. The text view is a RichEditor that renders the
// note's plain markdown (checklist markers as checkbox glyphs, like SPTextAttachment); `SPEditorTextController`
// is the UITextView surface the editor page, the InterlinkProcessor and the search highlight drive (selection,
// focus, caret geometry, scrolling). Every offset and text it exposes is in MARKDOWN units: a checkbox glyph is
// one rendered character standing for its whole `- [ ]` marker, and the mapping below converts between the two.
import { inputMethod } from '@kit.IMEKit';
import { LengthMetrics } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { image } from '@kit.ImageKit';
import { text as graphicsText } from '@kit.ArkGraphics2D';
import { pasteboard } from '@kit.BasicServicesKit';
import { ParsedUrl, ShortcutsHandler } from '../common/DeepLinkRouter';
import { InAppBrowserSheet } from './InAppBrowserSheet';
import { InterlinkPoint, InterlinkRect, InterlinkTextView } from '../common/InterlinkService';
import { TextRange as NoteRange } from '../model/Note';
import { TextRange as StringTextRange } from '../common/foundation/StringLine';

/// The editor's accessibilityIdentifier (configureTextView)
export const NOTE_EDITOR_TEXT_ID: string = 'note_editor_text';
/// MarkdownUnchecked / MarkdownChecked
export const MARKDOWN_UNCHECKED: string = '- [ ]';
export const MARKDOWN_CHECKED: string = '- [x]';
/// Approximate line height used when the caret rect is not available yet
/// Wait for the keyboard an idle-tap focus requested before closing its input session
const KEYBOARD_SETTLE_MS: number = 50;
const SILENT_FOCUS_SETTLE_MS: number = 80;
const CARET_LINE_HEIGHT: number = 22;
/// Lets the editor render a programmatic text change before the caret is placed
const CARET_AFTER_TEXT_DELAY_MS: number = 50;
/// SPEditorTextView: +8pt top inset
const TOP_INSET: number = 8;
/// SPTextAttachment sized by the headline font (checklistsFont)
const CHECKBOX_SIZE: number = 20;
/// headline font size (fp): title1 28pt * Body_L 16fp / body 17pt
const TITLE_FONT_SIZE: number = 26;
/// SPTextView TextViewHighlightCornerRadius
const SEARCH_HIGHLIGHT_RADIUS: number = 3;

// #region pure — markdown <-> rendered model. Self-contained (no ArkUI); checked by the node script
// scratchpad/richeditor/check.mjs, which strips the types of this region and asserts on it.

/// Per-markdown-character render codes. B body text; T the first line (headlineStyle); L a link, K a link in
/// the first line; u / c a character of an unchecked / checked checklist marker (the whole marker renders as
/// ONE glyph character). Newlines are always B.
export const CODE_BODY: string = 'B';
export const CODE_TITLE: string = 'T';
export const CODE_LINK: string = 'L';
export const CODE_TITLE_LINK: string = 'K';
export const CODE_UNCHECKED: string = 'u';
export const CODE_CHECKED: string = 'c';

/// NSRegularExpression.regexForChecklists `^\s*(-[ \t]+\[[xX\s]?\])`: group 2 is the marker the glyph replaces
/// (the leading whitespace stays text). Kept to one line ([ \t] instead of \s).
const CHECKLIST_PATTERN: string = '^([ \\t]*)(-[ \\t]+\\[[xX \\t]?\\])';

export function isGlyphCode(code: string): boolean {
  return code === CODE_UNCHECKED || code === CODE_CHECKED;
}

function titleEndOf(text: string): number {
  const newline: number = text.indexOf('\n');
  return newline < 0 ? text.length : newline;
}

/// Data detector stand-in: the http(s) / simplenote:// URLs, flattened [start0, end0, ...], trailing
/// punctuation trimmed.
export function linkRanges(text: string): number[] {
  const ranges: number[] = [];
  const regex: RegExp = new RegExp('(https?|simplenote)://[^\\s<>"]+', 'gi');
  const trailing: RegExp = new RegExp('[.,;:!?)]+$');
  let match: RegExpExecArray | null = regex.exec(text);
  while (match !== null) {
    ranges.push(match.index, match.index + match[0].replace(trailing, '').length);
    match = regex.exec(text);
  }
  return ranges;
}

/// SPInteractiveTextStorage (headline first line, default style after it) + link tint + processChecklists,
/// as one code per markdown character.
export function markdownCodes(text: string): string {
  const titleEnd: number = titleEndOf(text);
  const codes: string[] = new Array<string>(text.length).fill(CODE_BODY);
  codes.fill(CODE_TITLE, 0, titleEnd);
  const links: number[] = linkRanges(text);
  for (let i = 0; i < links.length; i += 2) {
    for (let k = links[i]; k < links[i + 1]; k++) {
      codes[k] = k < titleEnd ? CODE_TITLE_LINK : CODE_LINK;
    }
  }
  const checklist: RegExp = new RegExp(CHECKLIST_PATTERN, 'gm');
  const checked: RegExp = new RegExp('[xX]');
  let match: RegExpExecArray | null = checklist.exec(text);
  while (match !== null) {
    const start: number = match.index + match[1].length;
    const code: string = checked.test(match[2]) ? CODE_CHECKED : CODE_UNCHECKED;
    for (let i = start; i < start + match[2].length; i++) {
      codes[i] = code;
    }
    match = checklist.exec(text);
  }
  return codes.join('');
}

/// Markdown ranges of the glyphs, flattened [start0, end0, start1, end1, ...], ascending.
export function glyphRuns(codes: string): number[] {
  const runs: number[] = [];
  const regex: RegExp = new RegExp('u+|c+', 'g');
  let match: RegExpExecArray | null = regex.exec(codes);
  while (match !== null) {
    runs.push(match.index, match.index + match[0].length);
    match = regex.exec(codes);
  }
  return runs;
}

/// Markdown offset -> rendered offset. An offset inside a marker lands just after its glyph.
export function toRendered(runs: number[], md: number): number {
  let shrink: number = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const start: number = runs[i];
    const end: number = runs[i + 1];
    if (md <= start) {
      break;
    }
    if (md < end) {
      return start - shrink + 1;
    }
    shrink += end - start - 1;
  }
  return md - shrink;
}

/// Rendered offset -> markdown offset. Before a glyph is the marker's start, after it the marker's end.
export function toMarkdown(runs: number[], rendered: number): number {
  let grow: number = 0;
  for (let i = 0; i < runs.length; i += 2) {
    if (rendered <= runs[i] - grow) {
      break;
    }
    grow += runs[i + 1] - runs[i] - 1;
  }
  return rendered + grow;
}

/// The code text typed at markdown `offset` takes: that of the character before it (a glyph stands for its
/// line's style); the title's at the very start.
export function typingCodeAt(codes: string, text: string, offset: number): string {
  if (offset <= 0 || offset > codes.length) {
    return offset <= 0 ? CODE_TITLE : CODE_BODY;
  }
  const previous: string = codes.charAt(offset - 1);
  if (isGlyphCode(previous)) {
    return offset - 1 < titleEndOf(text) ? CODE_TITLE : CODE_BODY;
  }
  return previous;
}

/// Start of the line containing `index`.
export function lineStartOf(text: string, index: number): number {
  return index <= 0 ? 0 : text.lastIndexOf('\n', index - 1) + 1;
}

/// End of the line containing `index`, excluding its newline.
export function lineEndOf(text: string, index: number): number {
  const newline: number = text.indexOf('\n', index);
  return newline < 0 ? text.length : newline;
}

/// [start, oldEnd, newEnd]: the smallest range whose replacement turns `before` into `after`.
export function changedRange(before: string, after: string): number[] {
  const max: number = Math.min(before.length, after.length);
  let prefix: number = 0;
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) {
    prefix++;
  }
  let suffix: number = 0;
  while (suffix < max - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) {
    suffix++;
  }
  return [prefix, before.length - suffix, after.length - suffix];
}

/// SPTextAttachment.isChecked toggled, written back as markdown: `[ ]` <-> `[x]`.
export function toggledMarker(marker: string): string {
  const checked: RegExp = new RegExp('\\[[xX]\\]');
  return checked.test(marker) ? marker.replace(checked, '[ ]') : marker.replace(new RegExp('\\[[ \\t]?\\]'), '[x]');
}
// #endregion

/// A painted checkbox glyph: where its marker starts in the markdown. Kept current across edits so the glyph's
/// tap handler (bound when it was painted) toggles the right marker.
class GlyphRef {
  md: number = 0;
  alive: boolean = true;
}

/// Markdown read back from the editor, with the codes it is shown with.
class ShownText {
  text: string = '';
  codes: string = '';
}

export class SPEditorTextController implements InterlinkTextView {
  readonly controller: RichEditorController = new RichEditorController();
  /// The note's markdown (what the page stores and syncs)
  text: string = '';
  /// Selection in markdown offsets
  selectionStart: number = 0;
  selectionEnd: number = 0;
  isFirstResponder: boolean = false;
  isUndoingEditOP: boolean = false;
  contentOffset: InterlinkPoint = new InterlinkPoint(0, 0);
  /// The text view's frame in window coordinates (editingRectInWindow)
  frameInWindow: InterlinkRect = new InterlinkRect(0, 0, 0, 0);
  /// Glyph runs of what the editor shows (see glyphRuns); owned by SPEditorTextView
  runs: number[] = [];
  /// The RichEditor is ready and shows `text`
  isReady: boolean = false;
  /// Display density (set by SPEditorTextView)
  pxPerVp: number = 1;

  get isTextSelected(): boolean {
    return this.selectionEnd - this.selectionStart > 0;
  }

  /// Caret rect in window coordinates — the anchor the popover is laid out around.
  locationInWindowForText(range: StringTextRange): InterlinkRect {
    const caret: RectResult | undefined = this.isReady ? this.controller.getCaretRect() : undefined;
    if (caret === undefined) {
      return new InterlinkRect(this.frameInWindow.x, this.frameInWindow.y, 1, CARET_LINE_HEIGHT);
    }
    // getCaretRect is in px, the frame in vp.
    return new InterlinkRect(this.frameInWindow.x + caret.x / this.pxPerVp,
      this.frameInWindow.y + caret.y / this.pxPerVp, 1,
      caret.height > 0 ? caret.height / this.pxPerVp : CARET_LINE_HEIGHT);
  }

  editingRectInWindow(): InterlinkRect {
    return this.frameInWindow;
  }

  becomeFirstResponder(): void {
    // Deferred: a requestFocus issued inside the tapping button's own onClick is overridden by that
    // tap's focus handling, so the editor never became focused (no keyboard, nothing changed).
    setTimeout((): void => {
      if (!focusControl.requestFocus(NOTE_EDITOR_TEXT_ID)) {
        // Touch mode may refuse the first request while the tap settles; one retry.
        setTimeout((): void => {
          focusControl.requestFocus(NOTE_EDITOR_TEXT_ID);
        }, 100);
      }
    }, 0);
  }

  endEditing(): void {
    this.controller.stopEditing();
  }

  /// Scrolls the rendered offset into view without entering edit mode (set by SPEditorTextView): RichEditor
  /// has no scroll API and moves the viewport to the caret only while it is focused (T-0266 device check).
  scrollCaretIntoView: (renderedOffset: number) => void = (_renderedOffset: number): void => {
  };

  /// Re-reads contentOffset from the layout (set by SPEditorTextView). Touch sampling misses a fling's tail,
  /// so the page calls it right before it stores the scroll position (T-0266 device check).
  syncContentOffset: () => void = (): void => {
  };

  /// Markdown range; shown once the editor is ready (onReady applies a pending one).
  setSelectedRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
    if (this.isReady) {
      if (start === end) {
        // RichEditor ignores a collapsed setSelection; only setCaretOffset moves the caret (T-0111 device review).
        this.controller.setCaretOffset(toRendered(this.runs, start));
      } else {
        this.controller.setSelection(toRendered(this.runs, start), toRendered(this.runs, end));
      }
    }
  }

  /// Caret for a programmatic text change. The editor applies the new text on its next render, so the caret
  /// is placed after that render (T-0265 device review), unless the user has edited the text in between.
  setCaretAfterTextChange(caret: number): void {
    this.selectionStart = caret;
    this.selectionEnd = caret;
    const text: string = this.text;
    setTimeout((): void => {
      if (this.text === text) {
        this.setSelectedRange(caret, caret);
      }
    }, CARET_AFTER_TEXT_DELAY_MS);
  }

  /// Search mode matches (markdown ranges) and the highlighted one (-1: none); shown by SPEditorTextView.
  searchRanges: NoteRange[] = [];
  searchIndex: number = -1;
  /// Paints searchRanges / searchIndex and scrolls the highlighted match into view (set by SPEditorTextView).
  refreshSearchHighlights: () => void = (): void => {
  };

  /// applyBackgroundColor:toRanges: (every match) + highlightRange:animated:withBlock: (the current one,
  /// scrolled into view).
  highlightSearchResults(ranges: NoteRange[], index: number): void {
    this.searchRanges = ranges;
    this.searchIndex = index;
    this.refreshSearchHighlights();
  }

  clearHighlights(): void {
    this.highlightSearchResults([], -1);
  }
}

/// Result of an edit that rewrites the text and moves the caret.
export class EditorTextEdit {
  text: string = '';
  caret: number = 0;
}

/// NSString lineRangeForRange: — [start, end) of the lines touched by the selection (incl. newline).
function lineRange(text: string, start: number, end: number): NoteRange {
  const lineStart: number = text.lastIndexOf('\n', start - 1) + 1;
  const newline: number = text.indexOf('\n', Math.max(end, start));
  const lineEnd: number = newline < 0 ? text.length : newline + 1;
  return new NoteRange(lineStart, lineEnd);
}

function leadingWhitespace(line: string): string {
  const match: RegExpMatchArray | null = line.match(new RegExp('^[ \\t]*'));
  return match === null ? '' : match[0];
}

/// SPEditorTextView.insertOrRemoveChecklist — toggles the checklist marker on every selected line.
export function insertOrRemoveChecklist(text: string, start: number, end: number): EditorTextEdit {
  const range: NoteRange = lineRange(text, start, end);
  const lineString: string = text.substring(range.lower, range.upper);
  const checkboxRegex: RegExp = new RegExp('- \\[( |x|X)\\] ', 'g');
  let resultString: string = '';
  let caret: number = end;

  if (checkboxRegex.test(lineString)) {
    resultString = lineString.replace(new RegExp('- \\[( |x|X)\\] ', 'g'), '');
    caret = Math.max(range.lower, end - (lineString.length - resultString.length));
  } else {
    const checkboxString: string = MARKDOWN_UNCHECKED + ' ';
    const lines: string[] = lineString.split('\n');
    let added: number = 0;
    for (let i = 0; i < lines.length; i++) {
      let line: string = lines[i];
      if (i !== 0 && i === lines.length - 1 && line.length === 0) {
        continue;
      }
      const prefix: string = leadingWhitespace(line);
      line = line.substring(prefix.length);
      resultString = resultString + prefix + checkboxString + line;
      if (i !== lines.length - 1) {
        resultString = resultString + '\n';
      }
      added++;
    }
    caret = end + checkboxString.length * added;
  }

  const edit: EditorTextEdit = new EditorTextEdit();
  edit.text = text.substring(0, range.lower) + resultString + text.substring(range.upper);
  edit.caret = Math.min(caret, edit.text.length);
  return edit;
}

/// UITextView+Simplenote applyAutoBulletsWithReplacementText: (Return only) — Return on a checklist
/// or `* + - •` bullet line continues the list; Return on an empty item removes the marker. Null when
/// the insert is not a newline or the line has no bullet (the editor inserts normally).
// ponytail: the Tab-indents-bullet branch is not ported (decision D5); add it here if needed.
// Check: scratch autobullets-check.js (node) asserts the five T-0108 traces.
export function applyAutoBullets(text: string, offset: number, inserted: string): EditorTextEdit | null {
  if (inserted !== '\n') {
    return null;
  }
  const range: NoteRange = lineRange(text, offset, offset);
  const line: string = text.substring(range.lower, range.upper);
  const clean: string = line.trim();
  const ws: string = leadingWhitespace(line);
  // Checklist first: the markdown holds the raw `- [ ]` text (the glyph is only its rendering), so the
  // `-` bullet must not catch it.
  const isChecklist: boolean = new RegExp('^- \\[( |x|X)\\]( |$)').test(clean);
  let prefix: string = '';
  let isEmpty: boolean = false;
  if (isChecklist) {
    prefix = ws + MARKDOWN_UNCHECKED + ' ';
    isEmpty = clean.length === MARKDOWN_UNCHECKED.length;
  } else {
    const bullet: string | undefined = ['*', '+', '-', '•'].find((b: string): boolean => clean.startsWith(b));
    if (bullet === undefined) {
      return null;
    }
    const trailing: string = line.charAt(ws.length + 1);
    prefix = ws + bullet + (trailing === ' ' || trailing === '\t' ? trailing : '');
    isEmpty = clean.length === 1;
  }
  const edit: EditorTextEdit = new EditorTextEdit();
  if (isEmpty) {
    edit.text = text.substring(0, range.lower) + '\n' + text.substring(range.upper);
    edit.caret = range.lower + 1;
  } else {
    edit.text = text.substring(0, offset) + '\n' + prefix + text.substring(offset);
    edit.caret = offset + 1 + prefix.length;
  }
  return edit;
}

/// The checklist glyph image tinted with `argb` (iOS checklistsTintColor); the untinted media when the
/// SVG cannot be decoded. RichEditor image spans have no colorFilter, so the pixels are tinted here.
function tintedGlyph(context: common.Context, media: Resource, argb: number, sizePx: number): PixelMap | Resource {
  try {
    const data: Uint8Array = context.resourceManager.getMediaContentSync(media);
    const source: image.ImageSource = image.createImageSource(data.buffer.slice(data.byteOffset,
      data.byteOffset + data.byteLength) as ArrayBuffer);
    const pixelMap: image.PixelMap = source.createPixelMapSync({
      desiredSize: { width: sizePx, height: sizePx },
      desiredPixelFormat: image.PixelMapFormat.RGBA_8888,
      editable: true
    });
    source.release();
    const premultiplied: boolean = pixelMap.getImageInfoSync().alphaType === image.AlphaType.PREMUL;
    const buffer: ArrayBuffer = new ArrayBuffer(pixelMap.getPixelBytesNumber());
    pixelMap.readPixelsToBufferSync(buffer);
    const pixels: Uint8Array = new Uint8Array(buffer);
    const red: number = (argb >>> 16) & 0xFF;
    const green: number = (argb >>> 8) & 0xFF;
    const blue: number = argb & 0xFF;
    for (let i = 0; i + 3 < pixels.length; i += 4) {
      const alpha: number = pixels[i + 3];
      const scale: number = premultiplied ? alpha / 255 : 1;
      pixels[i] = Math.round(red * scale);
      pixels[i + 1] = Math.round(green * scale);
      pixels[i + 2] = Math.round(blue * scale);
    }
    pixelMap.writeBufferToPixelsSync(buffer);
    return pixelMap;
  } catch (e) {
    return media;
  }
}

@Component
export struct SPEditorTextView {
  /// The note's markdown, two-way with the page. A change the page makes is diffed into the editor.
  @Link @Watch('onTextPropChanged') text: string;
  editor: SPEditorTextController = new SPEditorTextController();
  /// textViewDidChange:
  onTextDidChange: (text: string) => void = (text: string): void => {
    this.editor.text = text;
  };
  /// textViewDidBeginEditing: / textViewDidEndEditing:
  onEditingChange: (isEditing: boolean) => void = (isEditing: boolean): void => {
    this.editor.isFirstResponder = isEditing;
  };
  /// textViewDidChangeSelection:
  onSelectionDidChange: () => void = (): void => {
    this.editor.isUndoingEditOP = false;
  };
  /// scrollViewDidScroll:
  onContentOffsetChange: (offsetY: number) => void = (offsetY: number): void => {
    this.editor.contentOffset = new InterlinkPoint(0, offsetY);
  };
  /// The current touch began while the editor was not editing (iOS read mode, editable = NO).
  private tapStartedWhileIdle: boolean = false;
  /// Set when a tap opened a link: the editing start ArkUI reports for that same tap can arrive after the
  /// link opened, so it is ended there instead of leaving the page in edit mode (T-0110 device review).
  private idleTapPressed: boolean = false;
  /// A focus taken only to scroll the caret into view: no keyboard, and the page never sees an edit start.
  private silentFocus: boolean = false;
  @State keyboardOnFocus: boolean = true;
  /// presentSafariViewControllerAtURL: the tapped http(s) link in InAppBrowserSheet
  @State showInAppBrowser: boolean = false;
  @State inAppBrowserURL: string = '';
  /// The markdown the editor shows, and its render codes as the editor shows them (after a native edit the
  /// typed text is assumed to carry the style around it until flush() repaints what differs).
  private markdown: string = '';
  private shownCodes: string = '';
  private glyphs: GlyphRef[] = [];
  /// The search matches painted with a highlight (cleared on the next refreshSearchHighlights)
  private shownSearchRanges: NoteRange[] = [];
  /// Controller edits in progress: the editor's own change / selection callbacks are ignored.
  private painting: boolean = false;
  private flushScheduled: boolean = false;
  private uncheckedGlyph: PixelMap | Resource = $r('app.media.ic_task_unchecked');
  private checkedGlyph: PixelMap | Resource = $r('app.media.ic_task_checked');
  private bodyStyle: RichEditorTextStyle = {
    fontSize: $r('sys.float.Body_L'),
    fontColor: $r('app.color.simplenote_text'),
    lineHeight: 24
  };
  /// headlineStyle: iOS title1 bold (28pt beside the 17pt body), scaled to the Body_L (16fp) body.
  private titleStyle: RichEditorTextStyle = {
    fontSize: TITLE_FONT_SIZE,
    fontWeight: FontWeight.Bold,
    fontColor: $r('app.color.simplenote_text')
  };
  private linkStyle: RichEditorTextStyle = {
    fontSize: $r('sys.float.Body_L'),
    fontColor: $r('app.color.simplenote_tint'),
    lineHeight: 24
  };
  private titleLinkStyle: RichEditorTextStyle = {
    fontSize: TITLE_FONT_SIZE,
    fontWeight: FontWeight.Bold,
    fontColor: $r('app.color.simplenote_tint')
  };

  aboutToAppear(): void {
    this.editor.pxPerVp = this.getUIContext().vp2px(1);
    this.editor.refreshSearchHighlights = (): void => {
      this.refreshSearchHighlights();
    };
    this.editor.syncContentOffset = (): void => {
      this.refreshContentOffset();
    };
    this.editor.scrollCaretIntoView = (renderedOffset: number): void => {
      this.silentFocus = true;
      this.keyboardOnFocus = false;
      // Caret first: focus scrolls to the caret it finds, a later setCaretOffset does not scroll.
      this.editor.controller.setCaretOffset(renderedOffset);
      focusControl.requestFocus(NOTE_EDITOR_TEXT_ID);
      setTimeout((): void => {
        this.editor.controller.stopEditing();
        setTimeout((): void => {
          this.silentFocus = false;
          this.keyboardOnFocus = true;
        }, SILENT_FOCUS_SETTLE_MS);
      }, SILENT_FOCUS_SETTLE_MS);
    };
    try {
      const context: common.Context = getContext(this);
      const tint: number = context.resourceManager.getColorSync($r('app.color.simplenote_note_body_preview'));
      const sizePx: number = Math.round(this.getUIContext().vp2px(CHECKBOX_SIZE));
      this.uncheckedGlyph = tintedGlyph(context, $r('app.media.ic_task_unchecked'), tint, sizePx);
      this.checkedGlyph = tintedGlyph(context, $r('app.media.ic_task_checked'), tint, sizePx);
    } catch (e) {
      // Keep the untinted media.
    }
  }

  // MARK: - Model

  private onTextPropChanged(): void {
    if (this.editor.isReady && this.text !== this.markdown) {
      this.applyText(this.text);
    }
  }

  /// Shows `text` by repainting only the lines that changed (remote updates, interlinks, list edits).
  private applyText(text: string): void {
    const range: number[] = changedRange(this.markdown, text);
    this.replace(range[0], range[1], text.substring(range[0], range[2]));
    this.editor.text = this.markdown;
    if (this.editor.isFirstResponder) {
      this.editor.setSelectedRange(Math.min(this.editor.selectionStart, text.length),
        Math.min(this.editor.selectionEnd, text.length));
    }
  }

  /// An edit made here (not typed): show it and report it like textViewDidChange.
  private commitEdit(text: string, caret: number): void {
    this.editor.selectionStart = caret;
    this.editor.selectionEnd = caret;
    this.applyText(text);
    this.text = this.markdown;
    this.onTextDidChange(this.markdown);
    this.editor.setCaretAfterTextChange(caret);
  }

  /// Replaces markdown [start, end) with `inserted` and repaints the touched lines.
  private replace(start: number, end: number, inserted: string): void {
    const before: string = this.markdown;
    const lineStart: number = lineStartOf(before, start);
    const oldLineEnd: number = lineEndOf(before, end);
    const renderedStart: number = toRendered(this.editor.runs, lineStart);
    const renderedEnd: number = toRendered(this.editor.runs, oldLineEnd);
    this.markdown = before.substring(0, start) + inserted + before.substring(end);
    this.shiftGlyphs(start, end, inserted.length);
    const newLineEnd: number = oldLineEnd + inserted.length - (end - start);
    const desired: string = markdownCodes(this.markdown);
    this.paint(lineStart, renderedStart, renderedEnd, newLineEnd, desired);
    this.shownCodes = this.shownCodes.substring(0, lineStart) + desired.substring(lineStart, newLineEnd) +
      this.shownCodes.substring(oldLineEnd);
    this.editor.runs = glyphRuns(this.shownCodes);
    this.flush();
    this.updateTypingStyle();
  }

  /// Repaints the lines whose shown codes differ from the markdown's (a typed marker becoming a glyph, a
  /// deleted bracket turning a glyph back into text). Typing inside a line usually changes nothing here.
  // ponytail: markdownCodes rescans the whole note per edit (O(n)); only the differing lines are repainted.
  private flush(): void {
    this.flushScheduled = false;
    const desired: string = markdownCodes(this.markdown);
    if (desired === this.shownCodes) {
      return;
    }
    let first: number = 0;
    while (first < desired.length && desired.charAt(first) === this.shownCodes.charAt(first)) {
      first++;
    }
    let last: number = desired.length - 1;
    while (last > first && desired.charAt(last) === this.shownCodes.charAt(last)) {
      last--;
    }
    const lineStart: number = lineStartOf(this.markdown, first);
    const lineEnd: number = lineEndOf(this.markdown, Math.min(last + 1, this.markdown.length));
    this.paint(lineStart, toRendered(this.editor.runs, lineStart), toRendered(this.editor.runs, lineEnd), lineEnd,
      desired);
    this.shownCodes = desired;
    this.editor.runs = glyphRuns(desired);
    if (this.editor.isFirstResponder) {
      this.editor.setSelectedRange(this.editor.selectionStart, this.editor.selectionEnd);
    }
    this.updateTypingStyle();
  }

  private scheduleFlush(): void {
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setTimeout((): void => {
        this.flush();
      }, 0);
    }
  }

  /// Replaces rendered [renderedStart, renderedEnd) with markdown [start, end) painted per `codes`.
  private paint(start: number, renderedStart: number, renderedEnd: number, end: number, codes: string): void {
    const controller: RichEditorController = this.editor.controller;
    this.painting = true;
    try {
      if (renderedEnd > renderedStart) {
        controller.deleteSpans({ start: renderedStart, end: renderedEnd });
      }
      this.glyphs = this.glyphs.filter((glyph: GlyphRef): boolean => {
        glyph.alive = glyph.md < start || glyph.md >= end;
        return glyph.alive;
      });
      let rendered: number = renderedStart;
      let i: number = start;
      while (i < end) {
        const code: string = codes.charAt(i);
        let j: number = i + 1;
        while (j < end && codes.charAt(j) === code) {
          j++;
        }
        if (isGlyphCode(code)) {
          this.addGlyph(i, code === CODE_CHECKED, rendered);
          rendered += 1;
        } else if (code === CODE_LINK || code === CODE_TITLE_LINK) {
          // A run of link codes is exactly the URL's characters (whitespace ends a link), so the span carries it.
          const url: string = this.markdown.substring(i, j);
          controller.addTextSpan(url, {
            offset: rendered,
            style: this.styleFor(code),
            gesture: {
              onClick: (): void => {
                this.openPressedLink(url);
              }
            }
          });
          rendered += j - i;
        } else {
          controller.addTextSpan(this.markdown.substring(i, j), { offset: rendered, style: this.styleFor(code) });
          rendered += j - i;
        }
        i = j;
      }
    } finally {
      this.painting = false;
    }
  }

  private styleFor(code: string): RichEditorTextStyle {
    // SPEditorTextView turns data detectors off while editable, so links are tinted only while not editing.
    const tintLinks: boolean = !this.editor.isFirstResponder;
    if (code === CODE_TITLE || (code === CODE_TITLE_LINK && !tintLinks)) {
      return this.titleStyle;
    }
    if (code === CODE_LINK) {
      return tintLinks ? this.linkStyle : this.bodyStyle;
    }
    return code === CODE_TITLE_LINK ? this.titleLinkStyle : this.bodyStyle;
  }

  /// Re-applies link styling after editing starts or ends (see styleFor).
  private restyleLinks(): void {
    const codes: string = this.shownCodes;
    let i: number = 0;
    while (i < codes.length) {
      const code: string = codes.charAt(i);
      let j: number = i + 1;
      while (j < codes.length && codes.charAt(j) === code) {
        j++;
      }
      if (code === CODE_LINK || code === CODE_TITLE_LINK) {
        this.editor.controller.updateSpanStyle({
          start: toRendered(this.editor.runs, i),
          end: toRendered(this.editor.runs, j),
          textStyle: this.styleFor(code)
        });
      }
      i = j;
    }
  }

  /// SPNoteEditorViewController search mode: every match on the search highlight background, the current one
  /// as SPTextView's highlight label (white on blue), scrolled into view without bringing up the keyboard.
  private refreshSearchHighlights(): void {
    if (!this.editor.isReady) {
      return; // onReady paints them
    }
    const ranges: NoteRange[] = this.editor.searchRanges;
    const index: number = this.editor.searchIndex;
    this.painting = true;
    try {
      for (const range of this.shownSearchRanges) {
        this.styleSearchRange(range, 0);
      }
      ranges.forEach((range: NoteRange, i: number): void => {
        this.styleSearchRange(range, i === index ? 2 : 1);
      });
    } finally {
      this.painting = false;
    }
    this.shownSearchRanges = ranges;
    if (index >= 0 && index < ranges.length) {
      this.editor.scrollCaretIntoView(toRendered(this.editor.runs, Math.min(ranges[index].lower,
        this.markdown.length)));
    }
  }

  /// Restyles a markdown range: 0 plain, 1 a search match, 2 the highlighted match. Glyphs are left alone.
  private styleSearchRange(range: NoteRange, level: number): void {
    const codes: string = this.shownCodes;
    const end: number = Math.min(range.upper, codes.length);
    let i: number = Math.min(range.lower, end);
    while (i < end) {
      const code: string = codes.charAt(i);
      let j: number = i + 1;
      while (j < end && codes.charAt(j) === code) {
        j++;
      }
      if (!isGlyphCode(code)) {
        const base: RichEditorTextStyle = this.styleFor(code);
        const style: RichEditorTextStyle = {
          fontSize: base.fontSize,
          fontWeight: base.fontWeight,
          lineHeight: base.lineHeight,
          fontColor: level === 2 ? $r('app.color.simplenote_editor_search_highlight_text') : base.fontColor,
          textBackgroundStyle: {
            color: level === 2 ? $r('app.color.simplenote_editor_search_highlight_selected') :
              (level === 1 ? $r('app.color.simplenote_editor_search_highlight') : Color.Transparent),
            radius: level === 2 ? SEARCH_HIGHLIGHT_RADIUS : 0
          }
        };
        this.editor.controller.updateSpanStyle({
          start: toRendered(this.editor.runs, i),
          end: toRendered(this.editor.runs, j),
          textStyle: style
        });
      }
      i = j;
    }
  }

  /// The code text typed at markdown `offset` is shown with.
  private typingCode(offset: number): string {
    return typingCodeAt(this.shownCodes, this.markdown, offset);
  }

  /// Typed text takes the style before the caret, so a new note's first line types as the title.
  private updateTypingStyle(): void {
    this.editor.controller.setTypingStyle(this.styleFor(this.typingCode(this.editor.selectionStart)));
  }

  private addGlyph(md: number, checked: boolean, rendered: number): void {
    const glyph: GlyphRef = new GlyphRef();
    glyph.md = md;
    this.glyphs.push(glyph);
    this.editor.controller.addImageSpan(checked ? this.checkedGlyph : this.uncheckedGlyph, {
      offset: rendered,
      imageStyle: {
        size: [CHECKBOX_SIZE, CHECKBOX_SIZE],
        verticalAlign: ImageSpanAlignment.CENTER
      },
      gesture: {
        onClick: (): void => {
          this.toggleGlyph(glyph);
        }
      }
    });
  }

  /// Keeps each painted glyph's marker offset current across a markdown edit.
  private shiftGlyphs(start: number, end: number, insertedLength: number): void {
    this.glyphs = this.glyphs.filter((glyph: GlyphRef): boolean => {
      if (glyph.md >= end) {
        glyph.md += insertedLength - (end - start);
      } else if (glyph.md >= start) {
        glyph.alive = false;
      }
      return glyph.alive;
    });
  }

  /// handlePressedAttachmentAtIndex: — toggles the marker in the markdown; while editing the caret moves to the
  /// end of the line (selectEndOfLineForRange).
  private toggleGlyph(glyph: GlyphRef): void {
    if (!glyph.alive) {
      return;
    }
    const runs: number[] = this.editor.runs;
    for (let i = 0; i < runs.length; i += 2) {
      if (runs[i] === glyph.md) {
        const marker: string = this.markdown.substring(runs[i], runs[i + 1]);
        const text: string = this.markdown.substring(0, runs[i]) + toggledMarker(marker) +
          this.markdown.substring(runs[i + 1]);
        // A tap that started while idle is a read-mode toggle even if the editor already reports editing: the
        // focus from that same tap can arrive before the glyph's onClick.
        const wasEditing: boolean = this.editor.isFirstResponder && !this.tapStartedWhileIdle;
        this.commitEdit(text, wasEditing ? lineEndOf(text, runs[i]) : this.editor.selectionStart);
        if (!wasEditing) {
          // iOS toggles in read mode without bringing up the keyboard. ArkUI reports editing=true only after
          // the glyph's onClick, so an endEditing() here alone runs too early (T-0259): suppress it, as a link.
          this.suppressEditingAfterIdleTap();
        }
        return;
      }
    }
  }

  /// The markdown for rendered [start, end) of the editor as it is now, and its codes as shown (text in
  /// `textCode`); null when it cannot be read.
  private readMarkdown(start: number, end: number, textCode: string): ShownText | null {
    const result: ShownText = new ShownText();
    if (end <= start) {
      return result;
    }
    let length: number = 0;
    const spans: Array<RichEditorImageSpanResult | RichEditorTextSpanResult> =
      this.editor.controller.getSpans({ start: start, end: end });
    for (const span of spans) {
      const imageSpan: RichEditorImageSpanResult = span as RichEditorImageSpanResult;
      if (imageSpan.imageStyle !== undefined) {
        // ponytail: a glyph re-inserted by the editor itself (undo, rich paste) comes back unchecked; its
        // image carries no state. Track the image identity if that matters.
        result.text += MARKDOWN_UNCHECKED;
        result.codes += CODE_UNCHECKED.repeat(MARKDOWN_UNCHECKED.length);
        length += 1;
        continue;
      }
      // spanRange is the span's absolute rendered range; value is its whole text.
      const textSpan: RichEditorTextSpanResult = span as RichEditorTextSpanResult;
      const spanStart: number = textSpan.spanPosition.spanRange[0];
      const part: string = textSpan.value.substring(Math.max(start, spanStart) - spanStart,
        Math.min(end, textSpan.spanPosition.spanRange[1]) - spanStart);
      result.text += part;
      result.codes += textCode.repeat(part.length);
      length += part.length;
    }
    return length === end - start ? result : null;
  }

  /// Last resort when an edit cannot be read back: rebuild the markdown from the whole editor.
  private resync(): void {
    let text: string = '';
    for (const span of this.editor.controller.getSpans()) {
      const imageSpan: RichEditorImageSpanResult = span as RichEditorImageSpanResult;
      text += imageSpan.imageStyle !== undefined ? MARKDOWN_UNCHECKED : (span as RichEditorTextSpanResult).value;
    }
    this.painting = true;
    try {
      this.editor.controller.deleteSpans();
    } finally {
      this.painting = false;
    }
    this.markdown = '';
    this.shownCodes = '';
    this.editor.runs = [];
    this.glyphs = [];
    this.replace(0, 0, text);
  }

  // MARK: - Editor events

  /// textViewDidChange: for an edit the editor made itself (typing, delete, paste, drag, undo).
  private handleDidChange(before: TextRange, after: TextRange): void {
    const beforeStart: number = before.start ?? 0;
    const afterStart: number = after.start ?? beforeStart;
    const start: number = toMarkdown(this.editor.runs, beforeStart);
    const end: number = toMarkdown(this.editor.runs, before.end ?? beforeStart);
    // The typed text takes the style before it, which is also the typing style.
    const inserted: ShownText | null = this.readMarkdown(afterStart, after.end ?? afterStart,
      this.typingCode(start));
    if (inserted === null) {
      this.resync();
    } else {
      this.markdown = this.markdown.substring(0, start) + inserted.text + this.markdown.substring(end);
      this.shownCodes = this.shownCodes.substring(0, start) + inserted.codes + this.shownCodes.substring(end);
      this.shiftGlyphs(start, end, inserted.text.length);
      this.editor.runs = glyphRuns(this.shownCodes);
      this.editor.selectionStart = start + inserted.text.length;
      this.editor.selectionEnd = start + inserted.text.length;
      // The editor reports the moved caret before this change, so the typing style it got there was read from
      // the old text (a new note's second character typed as body, T-0311): set it again from the new one.
      this.updateTypingStyle();
      this.scheduleFlush();
    }
    this.editor.text = this.markdown;
    this.text = this.markdown;
    this.onTextDidChange(this.markdown);
  }

  /// textView:shouldChangeTextInRange: -> applyAutoBullets (Return at a collapsed caret).
  private handleWillInsert(value: RichEditorInsertValue): boolean {
    if (this.painting || this.editor.isTextSelected) {
      return true;
    }
    const offset: number = toMarkdown(this.editor.runs, value.insertOffset);
    const edit: EditorTextEdit | null = applyAutoBullets(this.markdown, offset, value.insertValue);
    if (edit === null) {
      return true;
    }
    // Applied after the editor finishes this input event.
    setTimeout((): void => {
      this.commitEdit(edit.text, edit.caret);
    }, 0);
    return false;
  }

  /// copy: / cut: put the selection's markdown (raw `- [ ]` markers) on the pasteboard, as iOS does.
  private copySelection(cut: boolean, preventDefault: (() => void) | undefined): void {
    const start: number = this.editor.selectionStart;
    const end: number = this.editor.selectionEnd;
    if (preventDefault === undefined || end <= start) {
      return;
    }
    preventDefault();
    const data: pasteboard.PasteData = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN,
      this.markdown.substring(start, end));
    pasteboard.getSystemPasteboard().setData(data).catch((): void => {
    });
    if (cut) {
      setTimeout((): void => {
        this.commitEdit(this.markdown.substring(0, start) + this.markdown.substring(end), start);
      }, 0);
    }
  }

  /// onTextTapped: / handlePressedLinkAtIndex: — a tap on a link while not editing opens it instead of
  /// starting an edit; while editing the tap only places the caret, as on iOS. Driven by the link span's own
  /// onClick (T-0110): inferring the link from the caret the tap places also fired for taps on the blank
  /// space below a note that ends with a URL, because that caret lands on the URL's end.
  /// A tap on a link or checkbox while idle must not start editing: the RichEditor reports editing=true after
  /// the span's onClick, so onEditingChange ends any editing that starts within the next 300 ms.
  private suppressEditingAfterIdleTap(): void {
    this.tapStartedWhileIdle = false;
    this.editor.endEditing();
    this.idleTapPressed = true;
    setTimeout((): void => {
      this.idleTapPressed = false;
    }, 300);
  }

  // http(s) opens in the in-app browser sheet (iOS: SFSafariViewController).
  private openPressedLink(url: string): void {
    if (!this.tapStartedWhileIdle) {
      return;
    }
    this.suppressEditingAfterIdleTap();
    if (ParsedUrl.parse(url).isSimplenoteURL) {
      ShortcutsHandler.shared.handleOpenURL(url);
    } else {
      this.inAppBrowserURL = url;
      this.showInAppBrowser = true;
    }
  }

  @Builder
  inAppBrowserSheet() {
    InAppBrowserSheet({
      src: this.inAppBrowserURL,
      onDismiss: (): void => {
        this.showInAppBrowser = false;
      }
    })
  }

  /// scrollViewDidScroll: — RichEditor reports no scroll offset, so it is read from where the first
  /// character is laid out.
  // ponytail: sampled on touch move / up only; a fling's tail is not followed.
  private refreshContentOffset(): void {
    if (!this.editor.isReady || this.markdown.length === 0) {
      return;
    }
    const boxes: Array<graphicsText.TextBox> = this.editor.controller.getLayoutManager().getRectsForRange(
      { start: 0, end: 1 }, graphicsText.RectWidthStyle.TIGHT, graphicsText.RectHeightStyle.TIGHT);
    if (boxes.length === 0) {
      return;
    }
    const offsetY: number = Math.max(0, TOP_INSET - this.getUIContext().px2vp(boxes[0].rect.top));
    if (offsetY !== this.editor.contentOffset.y) {
      this.editor.contentOffset = new InterlinkPoint(0, offsetY);
      this.onContentOffsetChange(offsetY);
    }
  }

  build() {
    RichEditor({ controller: this.editor.controller })
      .id(NOTE_EDITOR_TEXT_ID)
      .width('100%')
      .height('100%')
      // SPEditorTextView: 20pt horizontal line-fragment padding, +8pt top inset (body font: bodyStyle)
      .caretColor($r('app.color.simplenote_tint'))
      .selectedBackgroundColor($r('app.color.simplenote_light_blue'))
      .backgroundColor(Color.Transparent)
      .borderRadius(0)
      .padding({ start: LengthMetrics.vp(20), end: LengthMetrics.vp(20), top: LengthMetrics.vp(TOP_INSET),
        bottom: LengthMetrics.vp(8) })
      .enablePreviewText(false)
      .enableKeyboardOnFocus(this.keyboardOnFocus)
      .undoStyle(UndoStyle.KEEP_STYLE)
      .onReady((): void => {
        this.editor.isReady = true;
        const selectionStart: number = this.editor.selectionStart;
        const selectionEnd: number = this.editor.selectionEnd;
        this.replace(0, 0, this.text);
        this.editor.text = this.markdown;
        if (selectionStart !== 0 || selectionEnd !== 0) {
          // A selection asked for before the editor was ready (search highlight).
          this.editor.setSelectedRange(selectionStart, selectionEnd);
        }
        this.refreshSearchHighlights();
      })
      .onDidChange((before: TextRange, after: TextRange): void => {
        if (!this.painting) {
          this.handleDidChange(before, after);
        }
      })
      .aboutToIMEInput((value: RichEditorInsertValue): boolean => this.handleWillInsert(value))
      .onCopy((event: CopyEvent): void => {
        this.copySelection(false, event.preventDefault);
      })
      .onCut((event: CutEvent): void => {
        this.copySelection(true, event.preventDefault);
      })
      .onEditingChange((isEditing: boolean): void => {
        if (this.silentFocus) {
          return;
        }
        if (isEditing && this.idleTapPressed) {
          this.idleTapPressed = false;
          this.editor.endEditing();
          // stopEditing alone leaves the keyboard the same tap requested on screen (T-0259 device check).
          setTimeout((): void => {
            inputMethod.getController().stopInputSession().catch((): void => {
            });
          }, KEYBOARD_SETTLE_MS);
          return;
        }
        this.editor.isFirstResponder = isEditing;
        this.restyleLinks();
        this.onEditingChange(isEditing);
      })
      .onTouch((event: TouchEvent): void => {
        if (event.type === TouchType.Down) {
          this.tapStartedWhileIdle = !this.editor.isFirstResponder;
        } else if (event.type === TouchType.Cancel) {
          this.tapStartedWhileIdle = false;
        } else if (event.type === TouchType.Move) {
          this.refreshContentOffset();
        } else if (event.type === TouchType.Up) {
          this.refreshContentOffset();
          // The caret lands just after the tap ends; a later programmatic selection must not count.
          setTimeout((): void => {
            this.tapStartedWhileIdle = false;
          }, 300);
        }
      })
      .onSelectionChange((range: RichEditorRange): void => {
        if (this.painting) {
          return;
        }
        const selectionStart: number = toMarkdown(this.editor.runs, range.start ?? 0);
        const selectionEnd: number = toMarkdown(this.editor.runs, range.end ?? range.start ?? 0);
        this.editor.selectionStart = selectionStart;
        this.editor.selectionEnd = selectionEnd;
        this.updateTypingStyle();
        this.onSelectionDidChange();
      })
      .onAreaChange((oldValue: Area, newValue: Area): void => {
        this.editor.frameInWindow = new InterlinkRect(Number(newValue.globalPosition.x ?? 0),
          Number(newValue.globalPosition.y ?? 0), Number(newValue.width), Number(newValue.height));
      })
      .bindSheet($$this.showInAppBrowser, this.inAppBrowserSheet(), {
        showClose: false,
        height: SheetSize.LARGE,
        dragBar: false,
        backgroundColor: $r('sys.color.background_primary')
      })
  }
}
