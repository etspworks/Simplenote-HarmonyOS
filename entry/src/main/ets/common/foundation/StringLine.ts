// Port of SimplenoteFoundation-Swift: Extensions/String+Line.swift + String+RangeConversion.swift
// Indexes are UTF-16 offsets (the unit TextArea / RichEditor caret positions use), so the
// Swift String.Index <-> NSRange conversions collapse to plain numbers.

export class TextRange {
  start: number;
  end: number;

  constructor(start: number, end: number) {
    this.start = start;
    this.end = end;
  }

  get length(): number {
    return this.end - this.start;
  }
}

export class StringLine {
  range: TextRange;
  text: string;

  constructor(range: TextRange, text: string) {
    this.range = range;
    this.text = text;
  }
}

export class StringSplit {
  lhs: string;
  rhs: string;

  constructor(lhs: string, rhs: string) {
    this.lhs = lhs;
    this.rhs = rhs;
  }
}

function isLineTerminator(ch: string): boolean {
  return ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029' || ch === '\u0085';
}

/// Returns the range of the line at the specified index, terminator included
/// (Foundation `lineRange(for: index ..< index)` semantics).
export function rangeOfLine(text: string, index: number): TextRange {
  let start: number = Math.max(0, Math.min(index, text.length));
  while (start > 0 && !isLineTerminator(text.charAt(start - 1))) {
    start--;
  }
  let end: number = Math.max(0, Math.min(index, text.length));
  while (end < text.length && !isLineTerminator(text.charAt(end))) {
    end++;
  }
  if (end < text.length) {
    // \r\n counts as a single terminator
    if (text.charAt(end) === '\r' && end + 1 < text.length && text.charAt(end + 1) === '\n') {
      end += 2;
    } else {
      end += 1;
    }
  }
  return new TextRange(start, end);
}

/// Returns `(Range, Text)` of the Line at the specified location
export function lineAt(text: string, index: number): StringLine {
  const range: TextRange = rangeOfLine(text, index);
  return new StringLine(range, text.substring(range.start, range.end));
}

/// Splits the receiver at the specified location
export function splitAt(text: string, location: number): StringSplit {
  return new StringSplit(text.substring(0, location), text.substring(location));
}

/// Maps an index in the receiver's coordinates into coordinates valid for `substring`, located at `range`
export function transportIndex(index: number, range: TextRange, substring: string): number | null {
  const location: number = index - range.start;
  if (location < 0 || location > substring.length) {
    return null;
  }
  return location;
}
