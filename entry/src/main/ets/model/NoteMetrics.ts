// Port of NoteMetrics.swift (+ NSString+Count.swift): characters, words and dates of a note.
import type { Note } from './Note';

const NEWLINE_CHARS: RegExp = /[\n\r\u2028\u2029\u0085\u000B\u000C]/;
// CharacterSet.CJKUniHan + Hiragana + Katakana (NSString+Count.swift): each character counts as one word
const CJK: string = '\\u{3040}-\\u{30FF}\\u{31F0}-\\u{31FF}\\u{3400}-\\u{4DB5}\\u{4E00}-\\u{9FBB}\\u{F900}-\\u{FAD9}' +
  '\\u{20000}-\\u{2A6D6}\\u{2F800}-\\u{2FA1D}';
const WORD_CHAR: string = `[^\\P{L}${CJK}]|[\\p{M}\\p{N}_]`;
// enumerateSubstrings(.byWords) (ICU / UAX #29 word boundaries): a run of letters, digits and '_' that
// stays one word across a single '.', apostrophe, ':' or '·' between word characters ("simplenote.com",
// "don't") and across ',' or ';' before a digit ("1,000"); a CJK run is its own segment.
// ponytail: UAX #29 subset (no lookbehind, so "a,1" joins; no Katakana/ExtendNumLet subtleties, emoji
// words); swap for Intl.Segmenter granularity 'word' if the ArkTS runtime ships it.
const WORD: RegExp = new RegExp(`[${CJK}]+|(?:${WORD_CHAR})+(?:(?:[.'\\u2018\\u2019:\\u00B7](?=${WORD_CHAR})|` +
  `[,;](?=\\p{N}))(?:${WORD_CHAR})+)*`, 'gu');
const CJK_START: RegExp = new RegExp(`^[${CJK}]`, 'u');

/** NSString.charCount: every character except newlines (grapheme-ish: code points) */
export function charCount(text: string): number {
  let result = 0;
  for (const ch of Array.from(text)) {
    if (!NEWLINE_CHARS.test(ch)) {
      result += 1;
    }
  }
  return result;
}

/** NSString.wordCount: byWords segments; a segment starting with a CJK character counts per character */
export function wordCount(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const matches = text.match(WORD);
  if (matches === null) {
    return 0;
  }
  let result = 0;
  for (const word of matches) {
    result += CJK_START.test(word) ? Array.from(word).length : 1;
  }
  return result;
}

export class NoteMetrics {
  numberOfChars: number;
  numberOfWords: number;
  creationDate: Date;
  modifiedDate: Date;
  content: string;

  /** init(note:) */
  constructor(note: Note) {
    const content = note.content ?? '';
    this.content = content;
    this.numberOfChars = charCount(content);
    this.numberOfWords = wordCount(content);
    this.creationDate = note.creationDate;
    this.modifiedDate = note.modificationDate;
  }
}
