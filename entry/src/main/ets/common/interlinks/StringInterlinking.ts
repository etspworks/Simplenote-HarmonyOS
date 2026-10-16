// Port of SimplenoteInterlinks-Swift: Extensions/String+Interlinking.swift
// Indexes are UTF-16 offsets (TextArea caret units).
import { lineAt, splitAt, transportIndex, StringLine, StringSplit, TextRange } from '../foundation/StringLine';

export const INTERLINK_OPENING: string = '[';
export const INTERLINK_CLOSING: string = ']';

/// (Markdown Range, Visual Range, Keyword Text)
export class InterlinkKeyword {
  /// Contains the opening brace
  markdownRange: TextRange;
  /// Keyword text range
  keywordRange: TextRange;
  keyword: string;

  constructor(markdownRange: TextRange, keywordRange: TextRange, keyword: string) {
    this.markdownRange = markdownRange;
    this.keywordRange = keywordRange;
    this.keyword = keyword;
  }
}

/// (Keyword start index, Keyword text)
export class TrailingKeyword {
  index: number;
  text: string;

  constructor(index: number, text: string) {
    this.index = index;
    this.text = text;
  }
}

/// Returns the Interlink Keyword (shape `[keyword`) at `index`, if any.
/// If an unbalanced closing character is found on the right hand side, returns null.
export function interlinkKeyword(text: string, index: number, opening: string = INTERLINK_OPENING,
  closing: string = INTERLINK_CLOSING): InterlinkKeyword | null {
  // Step #0: Determine the Line where we're standing
  const line: StringLine = lineAt(text, index);
  if (line.text.length === 0) {
    return null;
  }

  // Step #1: Determine the relative index, with regards of the line of text we're analyzing
  const indexInLine: number | null = transportIndex(index, line.range, line.text);
  if (indexInLine === null) {
    return null;
  }

  // Step #2: Split the Line exactly at the position we're analyzing for Keywords
  const split: StringSplit = splitAt(line.text, indexInLine);

  // Step #3: If the RHS contains an unbalanced `]`, we should not proceed
  if (containsUnbalancedClosingCharacter(split.rhs, opening, closing)) {
    return null;
  }

  // Step #4: Extract any keywords on the LHS of the cursor's Index
  const trailing: TrailingKeyword | null = trailingLookupKeyword(split.lhs, opening, closing);
  if (trailing === null) {
    return null;
  }

  // Step #5: keywordStartIndex = Line Start + Keyword Start
  const keywordIndex: number = line.range.start + trailing.index;
  const keywordRange: TextRange = rangeFor(trailing.text, keywordIndex);

  // Step #6: markdown
  const markdownRange: TextRange = new TextRange(keywordIndex - opening.length, keywordRange.end);
  return new InterlinkKeyword(markdownRange, keywordRange, trailing.text);
}

/// Returns the Range for the specified Substring at a given Index
export function rangeFor(substring: string, substringIndex: number): TextRange {
  return new TextRange(substringIndex, substringIndex + substring.length);
}

/// Returns true whenever the receiver contains an unbalanced Closing Character
export function containsUnbalancedClosingCharacter(text: string, opening: string, closing: string): boolean {
  let stack: number = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch: string = text.charAt(i);
    if (ch === closing) {
      stack++;
    } else if (ch === opening) {
      // We *don't care* about unbalanced opening characters!
      if (stack > 0) {
        stack--;
      }
    }
  }
  return stack > 0;
}

/// Looks up the last `opening` occurrence and returns the substring succeeding it,
/// only if such does not contain `closing` and is not empty. `Text [keyword` -> `keyword`
export function trailingLookupKeyword(text: string, opening: string = INTERLINK_OPENING,
  closing: string = INTERLINK_CLOSING): TrailingKeyword | null {
  const openingTailIndex: number = text.lastIndexOf(opening);
  if (openingTailIndex < 0) {
    return null;
  }
  const keywordIndex: number = openingTailIndex + opening.length;
  const keywordString: string = text.substring(keywordIndex);
  if (keywordString.includes(closing) || keywordString.length === 0) {
    return null;
  }
  return new TrailingKeyword(keywordIndex, keywordString);
}
