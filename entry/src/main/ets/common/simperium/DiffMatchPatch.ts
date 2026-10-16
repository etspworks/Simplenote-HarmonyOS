// Port of Simperium's vendored diff-match-patch (External/diffmatchpatch/DiffMatchPatch.m,
// Neil Fraser's algorithm) plus DiffMatchPatch+Simperium.m (patch_apply with error).
// Only the surface Simperium uses is exposed: diff_main, the cleanups, delta encoding,
// levenshtein, match_main and the patch_* family. Strings are UTF-16 indexed exactly like
// NSString, so offsets in deltas are wire-compatible with the other Simperium clients.

export enum Operation {
  DIFF_DELETE = -1,
  DIFF_EQUAL = 0,
  DIFF_INSERT = 1
}

export class Diff {
  operation: Operation;
  text: string;

  constructor(operation: Operation, text: string) {
    this.operation = operation;
    this.text = text;
  }
}

export class Patch {
  diffs: Diff[] = [];
  start1: number = 0;
  start2: number = 0;
  length1: number = 0;
  length2: number = 0;

  toString(): string {
    let coords1: string;
    let coords2: string;
    if (this.length1 === 0) {
      coords1 = `${this.start1},0`;
    } else if (this.length1 === 1) {
      coords1 = `${this.start1 + 1}`;
    } else {
      coords1 = `${this.start1 + 1},${this.length1}`;
    }
    if (this.length2 === 0) {
      coords2 = `${this.start2},0`;
    } else if (this.length2 === 1) {
      coords2 = `${this.start2 + 1}`;
    } else {
      coords2 = `${this.start2 + 1},${this.length2}`;
    }
    const text: string[] = [`@@ -${coords1} +${coords2} @@\n`];
    for (const d of this.diffs) {
      let op = ' ';
      if (d.operation === Operation.DIFF_INSERT) {
        op = '+';
      } else if (d.operation === Operation.DIFF_DELETE) {
        op = '-';
      }
      text.push(op + encodeUriCompatible(d.text) + '\n');
    }
    return text.join('').replace(/%20/g, ' ');
  }
}

/** Result of patch_apply: the new text and one flag per patch. */
export class PatchApplyResult {
  text: string;
  results: boolean[];

  constructor(text: string, results: boolean[]) {
    this.text = text;
    this.results = results;
  }
}

export class DiffMatchPatchError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** DiffMatchPatch+Simperium.h: DiffMatchPatchApplyError */
export const DIFF_MATCH_PATCH_APPLY_ERROR: number = 1;

class HalfMatch {
  text1A: string;
  text1B: string;
  text2A: string;
  text2B: string;
  midCommon: string;

  constructor(a: string, b: string, c: string, d: string, mid: string) {
    this.text1A = a;
    this.text1B = b;
    this.text2A = c;
    this.text2B = d;
    this.midCommon = mid;
  }
}

class LinesToChars {
  chars1: string;
  chars2: string;
  lineArray: string[];

  constructor(chars1: string, chars2: string, lineArray: string[]) {
    this.chars1 = chars1;
    this.chars2 = chars2;
    this.lineArray = lineArray;
  }
}

// NSString+UriCompatibility: escape like JavaScript's encodeURI. A lone surrogate cannot be
// encoded by encodeURI, so it is carried through untouched (diff_toDelta already re-pairs them).
function encodeUriCompatible(text: string): string {
  try {
    return encodeURI(text);
  } catch (e) {
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text.charAt(i);
      try {
        out += encodeURI(ch);
      } catch (inner) {
        out += ch;
      }
    }
    return out;
  }
}

function decodeUriCompatible(text: string): string | null {
  try {
    return decodeURI(text);
  } catch (e) {
    return null;
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF;
}

const NON_ALPHA_NUMERIC_REGEX: RegExp = /[^a-zA-Z0-9]/;
const WHITESPACE_REGEX: RegExp = /\s/;
const LINEBREAK_REGEX: RegExp = /[\r\n]/;
const BLANKLINE_END_REGEX: RegExp = /\n\r?\n$/;
const BLANKLINE_START_REGEX: RegExp = /^\r?\n\r?\n/;

export class DiffMatchPatch {
  // Defaults, as set by DiffMatchPatch.m -init
  Diff_Timeout: number = 1.0;
  Diff_EditCost: number = 4;
  Match_Threshold: number = 0.5;
  Match_Distance: number = 1000;
  Patch_DeleteThreshold: number = 0.5;
  Patch_Margin: number = 4;
  Match_MaxBits: number = 32;

  // MARK: - Diff

  diff_main(text1: string, text2: string, checklines: boolean = true, deadlineIn?: number): Diff[] {
    let deadline: number;
    if (deadlineIn !== undefined) {
      deadline = deadlineIn;
    } else if (this.Diff_Timeout <= 0) {
      deadline = Number.MAX_VALUE;
    } else {
      deadline = Date.now() + this.Diff_Timeout * 1000;
    }

    if (text1 === text2) {
      const same: Diff[] = [];
      if (text1.length > 0) {
        same.push(new Diff(Operation.DIFF_EQUAL, text1));
      }
      return same;
    }

    let commonlength = this.diff_commonPrefix(text1, text2);
    const commonprefix = text1.substring(0, commonlength);
    text1 = text1.substring(commonlength);
    text2 = text2.substring(commonlength);

    commonlength = this.diff_commonSuffix(text1, text2);
    const commonsuffix = text1.substring(text1.length - commonlength);
    text1 = text1.substring(0, text1.length - commonlength);
    text2 = text2.substring(0, text2.length - commonlength);

    const diffs = this.diff_compute(text1, text2, checklines, deadline);

    if (commonprefix.length > 0) {
      diffs.unshift(new Diff(Operation.DIFF_EQUAL, commonprefix));
    }
    if (commonsuffix.length > 0) {
      diffs.push(new Diff(Operation.DIFF_EQUAL, commonsuffix));
    }
    this.diff_cleanupMerge(diffs);
    return diffs;
  }

  /** ObjC name kept for readers of the source: -diff_mainOfOldString:andNewString: */
  diff_mainOfOldString(text1: string, text2: string): Diff[] {
    return this.diff_main(text1, text2, true);
  }

  private diff_compute(text1: string, text2: string, checklines: boolean, deadline: number): Diff[] {
    if (text1.length === 0) {
      return [new Diff(Operation.DIFF_INSERT, text2)];
    }
    if (text2.length === 0) {
      return [new Diff(Operation.DIFF_DELETE, text1)];
    }

    const longtext = text1.length > text2.length ? text1 : text2;
    const shorttext = text1.length > text2.length ? text2 : text1;
    const i = longtext.indexOf(shorttext);
    if (i !== -1) {
      const op = text1.length > text2.length ? Operation.DIFF_DELETE : Operation.DIFF_INSERT;
      return [
        new Diff(op, longtext.substring(0, i)),
        new Diff(Operation.DIFF_EQUAL, shorttext),
        new Diff(op, longtext.substring(i + shorttext.length))
      ];
    }

    if (shorttext.length === 1) {
      return [new Diff(Operation.DIFF_DELETE, text1), new Diff(Operation.DIFF_INSERT, text2)];
    }

    const hm = this.diff_halfMatch(text1, text2);
    if (hm !== null) {
      const diffsA = this.diff_main(hm.text1A, hm.text2A, checklines, deadline);
      const diffsB = this.diff_main(hm.text1B, hm.text2B, checklines, deadline);
      const merged: Diff[] = diffsA.concat([new Diff(Operation.DIFF_EQUAL, hm.midCommon)]);
      return merged.concat(diffsB);
    }

    if (checklines && text1.length > 100 && text2.length > 100) {
      return this.diff_lineMode(text1, text2, deadline);
    }

    return this.diff_bisect(text1, text2, deadline);
  }

  private diff_lineMode(text1: string, text2: string, deadline: number): Diff[] {
    const a = this.diff_linesToChars(text1, text2);
    const diffs = this.diff_main(a.chars1, a.chars2, false, deadline);
    this.diff_charsToLines(diffs, a.lineArray);
    this.diff_cleanupSemantic(diffs);

    diffs.push(new Diff(Operation.DIFF_EQUAL, ''));
    let pointer = 0;
    let countDelete = 0;
    let countInsert = 0;
    let textDelete = '';
    let textInsert = '';
    while (pointer < diffs.length) {
      switch (diffs[pointer].operation) {
        case Operation.DIFF_INSERT:
          countInsert++;
          textInsert += diffs[pointer].text;
          break;
        case Operation.DIFF_DELETE:
          countDelete++;
          textDelete += diffs[pointer].text;
          break;
        case Operation.DIFF_EQUAL:
          if (countDelete >= 1 && countInsert >= 1) {
            diffs.splice(pointer - countDelete - countInsert, countDelete + countInsert);
            pointer = pointer - countDelete - countInsert;
            const sub = this.diff_main(textDelete, textInsert, false, deadline);
            for (let j = sub.length - 1; j >= 0; j--) {
              diffs.splice(pointer, 0, sub[j]);
            }
            pointer = pointer + sub.length;
          }
          countInsert = 0;
          countDelete = 0;
          textDelete = '';
          textInsert = '';
          break;
      }
      pointer++;
    }
    diffs.pop();
    return diffs;
  }

  diff_bisect(text1: string, text2: string, deadline: number): Diff[] {
    const text1Length = text1.length;
    const text2Length = text2.length;
    const maxD = Math.ceil((text1Length + text2Length) / 2);
    const vOffset = maxD;
    const vLength = 2 * maxD;
    const v1: number[] = new Array<number>(vLength);
    const v2: number[] = new Array<number>(vLength);
    for (let x = 0; x < vLength; x++) {
      v1[x] = -1;
      v2[x] = -1;
    }
    v1[vOffset + 1] = 0;
    v2[vOffset + 1] = 0;
    const delta = text1Length - text2Length;
    const front = (delta % 2 !== 0);
    let k1start = 0;
    let k1end = 0;
    let k2start = 0;
    let k2end = 0;
    for (let d = 0; d < maxD; d++) {
      if (Date.now() > deadline) {
        break;
      }
      for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
        const k1Offset = vOffset + k1;
        let x1: number;
        if (k1 === -d || (k1 !== d && v1[k1Offset - 1] < v1[k1Offset + 1])) {
          x1 = v1[k1Offset + 1];
        } else {
          x1 = v1[k1Offset - 1] + 1;
        }
        let y1 = x1 - k1;
        while (x1 < text1Length && y1 < text2Length && text1.charAt(x1) === text2.charAt(y1)) {
          x1++;
          y1++;
        }
        v1[k1Offset] = x1;
        if (x1 > text1Length) {
          k1end += 2;
        } else if (y1 > text2Length) {
          k1start += 2;
        } else if (front) {
          const k2Offset = vOffset + delta - k1;
          if (k2Offset >= 0 && k2Offset < vLength && v2[k2Offset] !== -1) {
            const x2 = text1Length - v2[k2Offset];
            if (x1 >= x2) {
              return this.diff_bisectSplit(text1, text2, x1, y1, deadline);
            }
          }
        }
      }

      for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
        const k2Offset = vOffset + k2;
        let x2: number;
        if (k2 === -d || (k2 !== d && v2[k2Offset - 1] < v2[k2Offset + 1])) {
          x2 = v2[k2Offset + 1];
        } else {
          x2 = v2[k2Offset - 1] + 1;
        }
        let y2 = x2 - k2;
        while (x2 < text1Length && y2 < text2Length &&
          text1.charAt(text1Length - x2 - 1) === text2.charAt(text2Length - y2 - 1)) {
          x2++;
          y2++;
        }
        v2[k2Offset] = x2;
        if (x2 > text1Length) {
          k2end += 2;
        } else if (y2 > text2Length) {
          k2start += 2;
        } else if (!front) {
          const k1Offset = vOffset + delta - k2;
          if (k1Offset >= 0 && k1Offset < vLength && v1[k1Offset] !== -1) {
            const x1 = v1[k1Offset];
            const y1 = vOffset + x1 - k1Offset;
            x2 = text1Length - x2;
            if (x1 >= x2) {
              return this.diff_bisectSplit(text1, text2, x1, y1, deadline);
            }
          }
        }
      }
    }
    return [new Diff(Operation.DIFF_DELETE, text1), new Diff(Operation.DIFF_INSERT, text2)];
  }

  private diff_bisectSplit(text1: string, text2: string, x: number, y: number, deadline: number): Diff[] {
    const text1a = text1.substring(0, x);
    const text2a = text2.substring(0, y);
    const text1b = text1.substring(x);
    const text2b = text2.substring(y);
    const diffs = this.diff_main(text1a, text2a, false, deadline);
    const diffsb = this.diff_main(text1b, text2b, false, deadline);
    return diffs.concat(diffsb);
  }

  private diff_linesToChars(text1: string, text2: string): LinesToChars {
    const lineArray: string[] = [''];
    const lineHash: Map<string, number> = new Map<string, number>();
    const chars1 = this.diff_linesToCharsMunge(text1, lineArray, lineHash, 40000);
    const chars2 = this.diff_linesToCharsMunge(text2, lineArray, lineHash, 65535);
    return new LinesToChars(chars1, chars2, lineArray);
  }

  private diff_linesToCharsMunge(text: string, lineArray: string[], lineHash: Map<string, number>,
    maxLines: number): string {
    let chars = '';
    let lineStart = 0;
    let lineEnd = -1;
    while (lineEnd < text.length - 1) {
      lineEnd = text.indexOf('\n', lineStart);
      if (lineEnd === -1) {
        lineEnd = text.length - 1;
      }
      let line = text.substring(lineStart, lineEnd + 1);
      const known = lineHash.get(line);
      if (known !== undefined) {
        chars += String.fromCharCode(known);
      } else {
        if (lineArray.length === maxLines) {
          line = text.substring(lineStart);
          lineEnd = text.length;
        }
        chars += String.fromCharCode(lineArray.length);
        lineHash.set(line, lineArray.length);
        lineArray.push(line);
      }
      lineStart = lineEnd + 1;
    }
    return chars;
  }

  private diff_charsToLines(diffs: Diff[], lineArray: string[]): void {
    for (const d of diffs) {
      const chars = d.text;
      const text: string[] = [];
      for (let j = 0; j < chars.length; j++) {
        text.push(lineArray[chars.charCodeAt(j)]);
      }
      d.text = text.join('');
    }
  }

  diff_commonPrefix(text1: string, text2: string): number {
    if (text1.length === 0 || text2.length === 0 || text1.charAt(0) !== text2.charAt(0)) {
      return 0;
    }
    let pointermin = 0;
    let pointermax = Math.min(text1.length, text2.length);
    let pointermid = pointermax;
    let pointerstart = 0;
    while (pointermin < pointermid) {
      if (text1.substring(pointerstart, pointermid) === text2.substring(pointerstart, pointermid)) {
        pointermin = pointermid;
        pointerstart = pointermin;
      } else {
        pointermax = pointermid;
      }
      pointermid = Math.floor((pointermax - pointermin) / 2 + pointermin);
    }
    return pointermid;
  }

  diff_commonSuffix(text1: string, text2: string): number {
    if (text1.length === 0 || text2.length === 0 ||
      text1.charAt(text1.length - 1) !== text2.charAt(text2.length - 1)) {
      return 0;
    }
    let pointermin = 0;
    let pointermax = Math.min(text1.length, text2.length);
    let pointermid = pointermax;
    let pointerend = 0;
    while (pointermin < pointermid) {
      if (text1.substring(text1.length - pointermid, text1.length - pointerend) ===
        text2.substring(text2.length - pointermid, text2.length - pointerend)) {
        pointermin = pointermid;
        pointerend = pointermin;
      } else {
        pointermax = pointermid;
      }
      pointermid = Math.floor((pointermax - pointermin) / 2 + pointermin);
    }
    return pointermid;
  }

  private diff_commonOverlap(text1: string, text2: string): number {
    const text1Length = text1.length;
    const text2Length = text2.length;
    if (text1Length === 0 || text2Length === 0) {
      return 0;
    }
    if (text1Length > text2Length) {
      text1 = text1.substring(text1Length - text2Length);
    } else if (text1Length < text2Length) {
      text2 = text2.substring(0, text1Length);
    }
    const textLength = Math.min(text1Length, text2Length);
    if (text1 === text2) {
      return textLength;
    }
    let best = 0;
    let length = 1;
    while (true) {
      const pattern = text1.substring(textLength - length);
      const found = text2.indexOf(pattern);
      if (found === -1) {
        return best;
      }
      length += found;
      if (found === 0 || text1.substring(textLength - length) === text2.substring(0, length)) {
        best = length;
        length++;
      }
    }
  }

  private diff_halfMatch(text1: string, text2: string): HalfMatch | null {
    if (this.Diff_Timeout <= 0) {
      return null;
    }
    const longtext = text1.length > text2.length ? text1 : text2;
    const shorttext = text1.length > text2.length ? text2 : text1;
    if (longtext.length < 4 || shorttext.length * 2 < longtext.length) {
      return null;
    }
    const hm1 = this.diff_halfMatchI(longtext, shorttext, Math.ceil(longtext.length / 4));
    const hm2 = this.diff_halfMatchI(longtext, shorttext, Math.ceil(longtext.length / 2));
    let hm: HalfMatch | null;
    if (hm1 === null && hm2 === null) {
      return null;
    } else if (hm2 === null) {
      hm = hm1;
    } else if (hm1 === null) {
      hm = hm2;
    } else {
      hm = hm1.midCommon.length > hm2.midCommon.length ? hm1 : hm2;
    }
    if (hm === null) {
      return null;
    }
    if (text1.length > text2.length) {
      return hm;
    }
    return new HalfMatch(hm.text2A, hm.text2B, hm.text1A, hm.text1B, hm.midCommon);
  }

  private diff_halfMatchI(longtext: string, shorttext: string, i: number): HalfMatch | null {
    const seed = longtext.substring(i, i + Math.floor(longtext.length / 4));
    let j = -1;
    let bestCommon = '';
    let bestLongtextA = '';
    let bestLongtextB = '';
    let bestShorttextA = '';
    let bestShorttextB = '';
    while ((j = shorttext.indexOf(seed, j + 1)) !== -1) {
      const prefixLength = this.diff_commonPrefix(longtext.substring(i), shorttext.substring(j));
      const suffixLength = this.diff_commonSuffix(longtext.substring(0, i), shorttext.substring(0, j));
      if (bestCommon.length < suffixLength + prefixLength) {
        bestCommon = shorttext.substring(j - suffixLength, j) + shorttext.substring(j, j + prefixLength);
        bestLongtextA = longtext.substring(0, i - suffixLength);
        bestLongtextB = longtext.substring(i + prefixLength);
        bestShorttextA = shorttext.substring(0, j - suffixLength);
        bestShorttextB = shorttext.substring(j + prefixLength);
      }
    }
    if (bestCommon.length * 2 >= longtext.length) {
      return new HalfMatch(bestLongtextA, bestLongtextB, bestShorttextA, bestShorttextB, bestCommon);
    }
    return null;
  }

  diff_cleanupSemantic(diffs: Diff[]): void {
    let changes = false;
    const equalities: number[] = [];
    let lastEquality: string | null = null;
    let pointer = 0;
    let lengthInsertions1 = 0;
    let lengthDeletions1 = 0;
    let lengthInsertions2 = 0;
    let lengthDeletions2 = 0;
    while (pointer < diffs.length) {
      if (diffs[pointer].operation === Operation.DIFF_EQUAL) {
        equalities.push(pointer);
        lengthInsertions1 = lengthInsertions2;
        lengthDeletions1 = lengthDeletions2;
        lengthInsertions2 = 0;
        lengthDeletions2 = 0;
        lastEquality = diffs[pointer].text;
      } else {
        if (diffs[pointer].operation === Operation.DIFF_INSERT) {
          lengthInsertions2 += diffs[pointer].text.length;
        } else {
          lengthDeletions2 += diffs[pointer].text.length;
        }
        if (lastEquality !== null && (lastEquality.length <= Math.max(lengthInsertions1, lengthDeletions1)) &&
          (lastEquality.length <= Math.max(lengthInsertions2, lengthDeletions2))) {
          const eqIndex = equalities[equalities.length - 1];
          diffs.splice(eqIndex, 0, new Diff(Operation.DIFF_DELETE, lastEquality));
          diffs[eqIndex + 1].operation = Operation.DIFF_INSERT;
          equalities.pop();
          equalities.pop();
          pointer = equalities.length > 0 ? equalities[equalities.length - 1] : -1;
          lengthInsertions1 = 0;
          lengthDeletions1 = 0;
          lengthInsertions2 = 0;
          lengthDeletions2 = 0;
          lastEquality = null;
          changes = true;
        }
      }
      pointer++;
    }

    if (changes) {
      this.diff_cleanupMerge(diffs);
    }
    this.diff_cleanupSemanticLossless(diffs);

    // Find any overlaps between deletions and insertions.
    pointer = 1;
    while (pointer < diffs.length) {
      if (diffs[pointer - 1].operation === Operation.DIFF_DELETE &&
        diffs[pointer].operation === Operation.DIFF_INSERT) {
        const deletion = diffs[pointer - 1].text;
        const insertion = diffs[pointer].text;
        const overlapLength1 = this.diff_commonOverlap(deletion, insertion);
        const overlapLength2 = this.diff_commonOverlap(insertion, deletion);
        if (overlapLength1 >= overlapLength2) {
          if (overlapLength1 >= deletion.length / 2 || overlapLength1 >= insertion.length / 2) {
            diffs.splice(pointer, 0, new Diff(Operation.DIFF_EQUAL, insertion.substring(0, overlapLength1)));
            diffs[pointer - 1].text = deletion.substring(0, deletion.length - overlapLength1);
            diffs[pointer + 1].text = insertion.substring(overlapLength1);
            pointer++;
          }
        } else {
          if (overlapLength2 >= deletion.length / 2 || overlapLength2 >= insertion.length / 2) {
            diffs.splice(pointer, 0, new Diff(Operation.DIFF_EQUAL, deletion.substring(0, overlapLength2)));
            diffs[pointer - 1].operation = Operation.DIFF_INSERT;
            diffs[pointer - 1].text = insertion.substring(0, insertion.length - overlapLength2);
            diffs[pointer + 1].operation = Operation.DIFF_DELETE;
            diffs[pointer + 1].text = deletion.substring(overlapLength2);
            pointer++;
          }
        }
        pointer++;
      }
      pointer++;
    }
  }

  private diff_cleanupSemanticScore(one: string, two: string): number {
    if (one.length === 0 || two.length === 0) {
      return 6;
    }
    const char1 = one.charAt(one.length - 1);
    const char2 = two.charAt(0);
    const nonAlphaNumeric1 = NON_ALPHA_NUMERIC_REGEX.test(char1);
    const nonAlphaNumeric2 = NON_ALPHA_NUMERIC_REGEX.test(char2);
    const whitespace1 = nonAlphaNumeric1 && WHITESPACE_REGEX.test(char1);
    const whitespace2 = nonAlphaNumeric2 && WHITESPACE_REGEX.test(char2);
    const lineBreak1 = whitespace1 && LINEBREAK_REGEX.test(char1);
    const lineBreak2 = whitespace2 && LINEBREAK_REGEX.test(char2);
    const blankLine1 = lineBreak1 && BLANKLINE_END_REGEX.test(one);
    const blankLine2 = lineBreak2 && BLANKLINE_START_REGEX.test(two);
    if (blankLine1 || blankLine2) {
      return 5;
    } else if (lineBreak1 || lineBreak2) {
      return 4;
    } else if (nonAlphaNumeric1 && !whitespace1 && whitespace2) {
      return 3;
    } else if (whitespace1 || whitespace2) {
      return 2;
    } else if (nonAlphaNumeric1 || nonAlphaNumeric2) {
      return 1;
    }
    return 0;
  }

  diff_cleanupSemanticLossless(diffs: Diff[]): void {
    let pointer = 1;
    while (pointer < diffs.length - 1) {
      if (diffs[pointer - 1].operation === Operation.DIFF_EQUAL &&
        diffs[pointer + 1].operation === Operation.DIFF_EQUAL) {
        let equality1 = diffs[pointer - 1].text;
        let edit = diffs[pointer].text;
        let equality2 = diffs[pointer + 1].text;

        const commonOffset = this.diff_commonSuffix(equality1, edit);
        if (commonOffset > 0) {
          const commonString = edit.substring(edit.length - commonOffset);
          equality1 = equality1.substring(0, equality1.length - commonOffset);
          edit = commonString + edit.substring(0, edit.length - commonOffset);
          equality2 = commonString + equality2;
        }

        let bestEquality1 = equality1;
        let bestEdit = edit;
        let bestEquality2 = equality2;
        let bestScore = this.diff_cleanupSemanticScore(equality1, edit) +
          this.diff_cleanupSemanticScore(edit, equality2);
        while (edit.length > 0 && equality2.length > 0 && edit.charAt(0) === equality2.charAt(0)) {
          equality1 += edit.charAt(0);
          edit = edit.substring(1) + equality2.charAt(0);
          equality2 = equality2.substring(1);
          const score = this.diff_cleanupSemanticScore(equality1, edit) +
            this.diff_cleanupSemanticScore(edit, equality2);
          if (score >= bestScore) {
            bestScore = score;
            bestEquality1 = equality1;
            bestEdit = edit;
            bestEquality2 = equality2;
          }
        }

        if (diffs[pointer - 1].text !== bestEquality1) {
          if (bestEquality1.length > 0) {
            diffs[pointer - 1].text = bestEquality1;
          } else {
            diffs.splice(pointer - 1, 1);
            pointer--;
          }
          diffs[pointer].text = bestEdit;
          if (bestEquality2.length > 0) {
            diffs[pointer + 1].text = bestEquality2;
          } else {
            diffs.splice(pointer + 1, 1);
            pointer--;
          }
        }
      }
      pointer++;
    }
  }

  diff_cleanupEfficiency(diffs: Diff[]): void {
    let changes = false;
    const equalities: number[] = [];
    let lastEquality: string | null = null;
    let pointer = 0;
    let preIns = false;
    let preDel = false;
    let postIns = false;
    let postDel = false;
    while (pointer < diffs.length) {
      if (diffs[pointer].operation === Operation.DIFF_EQUAL) {
        if (diffs[pointer].text.length < this.Diff_EditCost && (postIns || postDel)) {
          equalities.push(pointer);
          preIns = postIns;
          preDel = postDel;
          lastEquality = diffs[pointer].text;
        } else {
          equalities.length = 0;
          lastEquality = null;
        }
        postIns = false;
        postDel = false;
      } else {
        if (diffs[pointer].operation === Operation.DIFF_DELETE) {
          postDel = true;
        } else {
          postIns = true;
        }
        const count = (preIns ? 1 : 0) + (preDel ? 1 : 0) + (postIns ? 1 : 0) + (postDel ? 1 : 0);
        if (lastEquality !== null && ((preIns && preDel && postIns && postDel) ||
          ((lastEquality.length < this.Diff_EditCost / 2) && count === 3))) {
          const eqIndex = equalities[equalities.length - 1];
          diffs.splice(eqIndex, 0, new Diff(Operation.DIFF_DELETE, lastEquality));
          diffs[eqIndex + 1].operation = Operation.DIFF_INSERT;
          equalities.pop();
          lastEquality = null;
          if (preIns && preDel) {
            postIns = true;
            postDel = true;
            equalities.length = 0;
          } else {
            equalities.pop();
            pointer = equalities.length > 0 ? equalities[equalities.length - 1] : -1;
            postIns = false;
            postDel = false;
          }
          changes = true;
        }
      }
      pointer++;
    }
    if (changes) {
      this.diff_cleanupMerge(diffs);
    }
  }

  diff_cleanupMerge(diffs: Diff[]): void {
    diffs.push(new Diff(Operation.DIFF_EQUAL, ''));
    let pointer = 0;
    let countDelete = 0;
    let countInsert = 0;
    let textDelete = '';
    let textInsert = '';
    let commonlength: number;
    while (pointer < diffs.length) {
      switch (diffs[pointer].operation) {
        case Operation.DIFF_INSERT:
          countInsert++;
          textInsert += diffs[pointer].text;
          pointer++;
          break;
        case Operation.DIFF_DELETE:
          countDelete++;
          textDelete += diffs[pointer].text;
          pointer++;
          break;
        case Operation.DIFF_EQUAL:
          if (countDelete + countInsert > 1) {
            if (countDelete !== 0 && countInsert !== 0) {
              commonlength = this.diff_commonPrefix(textInsert, textDelete);
              if (commonlength !== 0) {
                const prevIndex = pointer - countDelete - countInsert - 1;
                if (prevIndex >= 0 && diffs[prevIndex].operation === Operation.DIFF_EQUAL) {
                  diffs[prevIndex].text += textInsert.substring(0, commonlength);
                } else {
                  diffs.splice(0, 0, new Diff(Operation.DIFF_EQUAL, textInsert.substring(0, commonlength)));
                  pointer++;
                }
                textInsert = textInsert.substring(commonlength);
                textDelete = textDelete.substring(commonlength);
              }
              commonlength = this.diff_commonSuffix(textInsert, textDelete);
              if (commonlength !== 0) {
                diffs[pointer].text = textInsert.substring(textInsert.length - commonlength) + diffs[pointer].text;
                textInsert = textInsert.substring(0, textInsert.length - commonlength);
                textDelete = textDelete.substring(0, textDelete.length - commonlength);
              }
            }
            pointer -= countDelete + countInsert;
            diffs.splice(pointer, countDelete + countInsert);
            if (textDelete.length > 0) {
              diffs.splice(pointer, 0, new Diff(Operation.DIFF_DELETE, textDelete));
              pointer++;
            }
            if (textInsert.length > 0) {
              diffs.splice(pointer, 0, new Diff(Operation.DIFF_INSERT, textInsert));
              pointer++;
            }
            pointer++;
          } else if (pointer !== 0 && diffs[pointer - 1].operation === Operation.DIFF_EQUAL) {
            diffs[pointer - 1].text += diffs[pointer].text;
            diffs.splice(pointer, 1);
          } else {
            pointer++;
          }
          countInsert = 0;
          countDelete = 0;
          textDelete = '';
          textInsert = '';
          break;
      }
    }
    if (diffs[diffs.length - 1].text === '') {
      diffs.pop();
    }

    let changes = false;
    pointer = 1;
    while (pointer < diffs.length - 1) {
      if (diffs[pointer - 1].operation === Operation.DIFF_EQUAL &&
        diffs[pointer + 1].operation === Operation.DIFF_EQUAL) {
        const prev = diffs[pointer - 1].text;
        const cur = diffs[pointer].text;
        const next = diffs[pointer + 1].text;
        if (cur.substring(cur.length - prev.length) === prev) {
          diffs[pointer].text = prev + cur.substring(0, cur.length - prev.length);
          diffs[pointer + 1].text = prev + next;
          diffs.splice(pointer - 1, 1);
          changes = true;
        } else if (cur.substring(0, next.length) === next) {
          diffs[pointer - 1].text += next;
          diffs[pointer].text = cur.substring(next.length) + next;
          diffs.splice(pointer + 1, 1);
          changes = true;
        }
      }
      pointer++;
    }
    if (changes) {
      this.diff_cleanupMerge(diffs);
    }
  }

  diff_xIndex(diffs: Diff[], loc: number): number {
    let chars1 = 0;
    let chars2 = 0;
    let lastChars1 = 0;
    let lastChars2 = 0;
    let x = 0;
    for (x = 0; x < diffs.length; x++) {
      if (diffs[x].operation !== Operation.DIFF_INSERT) {
        chars1 += diffs[x].text.length;
      }
      if (diffs[x].operation !== Operation.DIFF_DELETE) {
        chars2 += diffs[x].text.length;
      }
      if (chars1 > loc) {
        break;
      }
      lastChars1 = chars1;
      lastChars2 = chars2;
    }
    if (diffs.length !== x && diffs[x].operation === Operation.DIFF_DELETE) {
      return lastChars2;
    }
    return lastChars2 + (loc - lastChars1);
  }

  diff_text1(diffs: Diff[]): string {
    const text: string[] = [];
    for (const d of diffs) {
      if (d.operation !== Operation.DIFF_INSERT) {
        text.push(d.text);
      }
    }
    return text.join('');
  }

  diff_text2(diffs: Diff[]): string {
    const text: string[] = [];
    for (const d of diffs) {
      if (d.operation !== Operation.DIFF_DELETE) {
        text.push(d.text);
      }
    }
    return text.join('');
  }

  diff_levenshtein(diffs: Diff[]): number {
    let levenshtein = 0;
    let insertions = 0;
    let deletions = 0;
    for (const d of diffs) {
      switch (d.operation) {
        case Operation.DIFF_INSERT:
          insertions += d.text.length;
          break;
        case Operation.DIFF_DELETE:
          deletions += d.text.length;
          break;
        case Operation.DIFF_EQUAL:
          levenshtein += Math.max(insertions, deletions);
          insertions = 0;
          deletions = 0;
          break;
      }
    }
    levenshtein += Math.max(insertions, deletions);
    return levenshtein;
  }

  /** DiffMatchPatch.m -diff_toDelta:, including its surrogate-pair repair. */
  diff_toDelta(diffs: Diff[]): string {
    const delta: string[] = [];
    let lastEnd = 0;
    for (const d of diffs) {
      if (d.text.length === 0) {
        continue;
      }
      const thisTop = d.text.charCodeAt(0);
      const thisEnd = d.text.charCodeAt(d.text.length - 1);
      if (isHighSurrogate(thisEnd)) {
        lastEnd = thisEnd;
        d.text = d.text.substring(0, d.text.length - 1);
      }
      if (lastEnd !== 0 && isHighSurrogate(lastEnd) && isLowSurrogate(thisTop)) {
        d.text = String.fromCharCode(lastEnd) + d.text;
      }
      if (d.text.length === 0) {
        continue;
      }
      switch (d.operation) {
        case Operation.DIFF_INSERT:
          delta.push('+' + encodeUriCompatible(d.text).replace(/%20/g, ' '));
          break;
        case Operation.DIFF_DELETE:
          delta.push('-' + d.text.length);
          break;
        case Operation.DIFF_EQUAL:
          delta.push('=' + d.text.length);
          break;
      }
    }
    return delta.join('\t');
  }

  /** DiffMatchPatch.m -diff_fromDeltaWithText:andDelta:error: (throws DiffMatchPatchError). */
  diff_fromDelta(text1: string, delta: string): Diff[] {
    const diffs: Diff[] = [];
    let pointer = 0;
    const tokens = delta.split('\t');
    for (const token of tokens) {
      if (token.length === 0) {
        continue;
      }
      const param = token.substring(1);
      const opChar = token.charAt(0);
      if (opChar === '+') {
        const decoded = decodeUriCompatible(param);
        if (decoded === null) {
          throw new DiffMatchPatchError(99, `Invalid character in diff_fromDelta: ${param}`);
        }
        diffs.push(new Diff(Operation.DIFF_INSERT, decoded));
      } else if (opChar === '-' || opChar === '=') {
        const n = parseInt(param, 10);
        if (isNaN(n) || n === 0) {
          throw new DiffMatchPatchError(100, `Invalid number in diff_fromDelta: ${param}`);
        } else if (n < 0) {
          throw new DiffMatchPatchError(101, `Negative number in diff_fromDelta: ${param}`);
        }
        if (pointer + n > text1.length) {
          throw new DiffMatchPatchError(102,
            `Delta length (${pointer}) larger than source text length (${text1.length}).`);
        }
        const text = text1.substring(pointer, pointer + n);
        pointer += n;
        diffs.push(new Diff(opChar === '=' ? Operation.DIFF_EQUAL : Operation.DIFF_DELETE, text));
      } else {
        throw new DiffMatchPatchError(102, `Invalid diff operation in diff_fromDelta: ${opChar}`);
      }
    }
    if (pointer !== text1.length) {
      throw new DiffMatchPatchError(103,
        `Delta length (${pointer}) smaller than source text length (${text1.length}).`);
    }
    return diffs;
  }

  // MARK: - Match

  match_main(text: string, pattern: string, loc: number): number {
    loc = Math.max(0, Math.min(loc, text.length));
    if (text === pattern) {
      return 0;
    } else if (text.length === 0) {
      return -1;
    } else if (text.substring(loc, loc + pattern.length) === pattern) {
      return loc;
    }
    return this.match_bitap(text, pattern, loc);
  }

  private match_bitap(text: string, pattern: string, loc: number): number {
    const s = this.match_alphabet(pattern);

    let scoreThreshold = this.Match_Threshold;
    let bestLoc = text.indexOf(pattern, loc);
    if (bestLoc !== -1) {
      scoreThreshold = Math.min(this.match_bitapScore(0, bestLoc, loc, pattern), scoreThreshold);
      bestLoc = text.lastIndexOf(pattern, loc + pattern.length);
      if (bestLoc !== -1) {
        scoreThreshold = Math.min(this.match_bitapScore(0, bestLoc, loc, pattern), scoreThreshold);
      }
    }

    const matchmask = 1 << (pattern.length - 1);
    bestLoc = -1;

    let binMin: number;
    let binMid: number;
    let binMax = pattern.length + text.length;
    let lastRd: number[] = [];
    for (let d = 0; d < pattern.length; d++) {
      binMin = 0;
      binMid = binMax;
      while (binMin < binMid) {
        if (this.match_bitapScore(d, loc + binMid, loc, pattern) <= scoreThreshold) {
          binMin = binMid;
        } else {
          binMax = binMid;
        }
        binMid = binMin + Math.floor((binMax - binMin) / 2);
      }
      binMax = binMid;
      let start = Math.max(1, loc - binMid + 1);
      const finish = Math.min(loc + binMid, text.length) + pattern.length;

      const rd: number[] = new Array<number>(finish + 2);
      rd[finish + 1] = (1 << d) - 1;
      for (let j = finish; j >= start; j--) {
        const mask = s.get(text.charAt(j - 1));
        const charMatch = mask === undefined ? 0 : mask;
        if (d === 0) {
          rd[j] = ((rd[j + 1] << 1) | 1) & charMatch;
        } else {
          rd[j] = (((rd[j + 1] << 1) | 1) & charMatch) |
            (((lastRd[j + 1] | lastRd[j]) << 1) | 1) | lastRd[j + 1];
        }
        if (rd[j] & matchmask) {
          const score = this.match_bitapScore(d, j - 1, loc, pattern);
          if (score <= scoreThreshold) {
            scoreThreshold = score;
            bestLoc = j - 1;
            if (bestLoc > loc) {
              start = Math.max(1, 2 * loc - bestLoc);
            } else {
              break;
            }
          }
        }
      }
      if (this.match_bitapScore(d + 1, loc, loc, pattern) > scoreThreshold) {
        break;
      }
      lastRd = rd;
    }
    return bestLoc;
  }

  private match_bitapScore(e: number, x: number, loc: number, pattern: string): number {
    const accuracy = e / pattern.length;
    const proximity = Math.abs(loc - x);
    if (this.Match_Distance === 0) {
      return proximity !== 0 ? 1.0 : accuracy;
    }
    return accuracy + (proximity / this.Match_Distance);
  }

  private match_alphabet(pattern: string): Map<string, number> {
    const s: Map<string, number> = new Map<string, number>();
    for (let i = 0; i < pattern.length; i++) {
      s.set(pattern.charAt(i), 0);
    }
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern.charAt(i);
      const current = s.get(ch);
      s.set(ch, (current === undefined ? 0 : current) | (1 << (pattern.length - i - 1)));
    }
    return s;
  }

  // MARK: - Patch

  private patch_addContext(patch: Patch, text: string): void {
    if (text.length === 0) {
      return;
    }
    let pattern = text.substring(patch.start2, patch.start2 + patch.length1);
    let padding = 0;
    while (text.indexOf(pattern) !== text.lastIndexOf(pattern) &&
      pattern.length < this.Match_MaxBits - this.Patch_Margin - this.Patch_Margin) {
      padding += this.Patch_Margin;
      pattern = text.substring(patch.start2 - padding, patch.start2 + patch.length1 + padding);
    }
    padding += this.Patch_Margin;
    const prefix = text.substring(Math.max(0, patch.start2 - padding), patch.start2);
    if (prefix.length > 0) {
      patch.diffs.unshift(new Diff(Operation.DIFF_EQUAL, prefix));
    }
    const suffix = text.substring(patch.start2 + patch.length1, patch.start2 + patch.length1 + padding);
    if (suffix.length > 0) {
      patch.diffs.push(new Diff(Operation.DIFF_EQUAL, suffix));
    }
    patch.start1 -= prefix.length;
    patch.start2 -= prefix.length;
    patch.length1 += prefix.length + suffix.length;
    patch.length2 += prefix.length + suffix.length;
  }

  /** -patch_makeFromOldString:andDiffs: */
  patch_make(text1: string, diffs: Diff[]): Patch[] {
    const patches: Patch[] = [];
    if (diffs.length === 0) {
      return patches;
    }
    let patch = new Patch();
    let patchDiffLength = 0;
    let charCount1 = 0;
    let charCount2 = 0;
    let prepatchText = text1;
    let postpatchText = text1;
    for (let x = 0; x < diffs.length; x++) {
      const diffType = diffs[x].operation;
      const diffText = diffs[x].text;

      if (patchDiffLength === 0 && diffType !== Operation.DIFF_EQUAL) {
        patch.start1 = charCount1;
        patch.start2 = charCount2;
      }

      switch (diffType) {
        case Operation.DIFF_INSERT:
          patch.diffs[patchDiffLength++] = diffs[x];
          patch.length2 += diffText.length;
          postpatchText = postpatchText.substring(0, charCount2) + diffText + postpatchText.substring(charCount2);
          break;
        case Operation.DIFF_DELETE:
          patch.length1 += diffText.length;
          patch.diffs[patchDiffLength++] = diffs[x];
          postpatchText = postpatchText.substring(0, charCount2) +
            postpatchText.substring(charCount2 + diffText.length);
          break;
        case Operation.DIFF_EQUAL:
          if (diffText.length <= 2 * this.Patch_Margin && patchDiffLength && diffs.length !== x + 1) {
            patch.diffs[patchDiffLength++] = diffs[x];
            patch.length1 += diffText.length;
            patch.length2 += diffText.length;
          } else if (diffText.length >= 2 * this.Patch_Margin) {
            if (patchDiffLength) {
              this.patch_addContext(patch, prepatchText);
              patches.push(patch);
              patch = new Patch();
              patchDiffLength = 0;
              prepatchText = postpatchText;
              charCount1 = charCount2;
            }
          }
          break;
      }

      if (diffType !== Operation.DIFF_INSERT) {
        charCount1 += diffText.length;
      }
      if (diffType !== Operation.DIFF_DELETE) {
        charCount2 += diffText.length;
      }
    }
    if (patchDiffLength) {
      this.patch_addContext(patch, prepatchText);
      patches.push(patch);
    }
    return patches;
  }

  /** ObjC name: -patch_makeFromOldString:andDiffs: */
  patch_makeFromOldString(text1: string, diffs: Diff[]): Patch[] {
    return this.patch_make(text1, diffs);
  }

  patch_deepCopy(patches: Patch[]): Patch[] {
    const copy: Patch[] = [];
    for (const p of patches) {
      const patchCopy = new Patch();
      for (const d of p.diffs) {
        patchCopy.diffs.push(new Diff(d.operation, d.text));
      }
      patchCopy.start1 = p.start1;
      patchCopy.start2 = p.start2;
      patchCopy.length1 = p.length1;
      patchCopy.length2 = p.length2;
      copy.push(patchCopy);
    }
    return copy;
  }

  patch_apply(sourcePatches: Patch[], text: string): PatchApplyResult {
    if (sourcePatches.length === 0) {
      return new PatchApplyResult(text, []);
    }
    const patches = this.patch_deepCopy(sourcePatches);
    const nullPadding = this.patch_addPadding(patches);
    text = nullPadding + text + nullPadding;
    this.patch_splitMax(patches);

    let delta = 0;
    const results: boolean[] = [];
    for (let x = 0; x < patches.length; x++) {
      const expectedLoc = patches[x].start2 + delta;
      const text1 = this.diff_text1(patches[x].diffs);
      let startLoc: number;
      let endLoc = -1;
      if (text1.length > this.Match_MaxBits) {
        startLoc = this.match_main(text, text1.substring(0, this.Match_MaxBits), expectedLoc);
        if (startLoc !== -1) {
          endLoc = this.match_main(text, text1.substring(text1.length - this.Match_MaxBits),
            expectedLoc + text1.length - this.Match_MaxBits);
          if (endLoc === -1 || startLoc >= endLoc) {
            startLoc = -1;
          }
        }
      } else {
        startLoc = this.match_main(text, text1, expectedLoc);
      }
      if (startLoc === -1) {
        results[x] = false;
        delta -= patches[x].length2 - patches[x].length1;
      } else {
        results[x] = true;
        delta = startLoc - expectedLoc;
        let text2: string;
        if (endLoc === -1) {
          text2 = text.substring(startLoc, startLoc + text1.length);
        } else {
          text2 = text.substring(startLoc, endLoc + this.Match_MaxBits);
        }
        if (text1 === text2) {
          text = text.substring(0, startLoc) + this.diff_text2(patches[x].diffs) +
            text.substring(startLoc + text1.length);
        } else {
          const diffs = this.diff_main(text1, text2, false);
          if (text1.length > this.Match_MaxBits &&
            this.diff_levenshtein(diffs) / text1.length > this.Patch_DeleteThreshold) {
            results[x] = false;
          } else {
            this.diff_cleanupSemanticLossless(diffs);
            let index1 = 0;
            let index2 = 0;
            for (const mod of patches[x].diffs) {
              if (mod.operation !== Operation.DIFF_EQUAL) {
                index2 = this.diff_xIndex(diffs, index1);
              }
              if (mod.operation === Operation.DIFF_INSERT) {
                text = text.substring(0, startLoc + index2) + mod.text + text.substring(startLoc + index2);
              } else if (mod.operation === Operation.DIFF_DELETE) {
                text = text.substring(0, startLoc + index2) +
                  text.substring(startLoc + this.diff_xIndex(diffs, index1 + mod.text.length));
              }
              if (mod.operation !== Operation.DIFF_DELETE) {
                index1 += mod.text.length;
              }
            }
          }
        }
      }
    }
    text = text.substring(nullPadding.length, text.length - nullPadding.length);
    return new PatchApplyResult(text, results);
  }

  /** DiffMatchPatch+Simperium.m -patch_apply:toString:error: — throws when any hunk failed. */
  patch_applyOrThrow(sourcePatches: Patch[], text: string): PatchApplyResult {
    const patched = this.patch_apply(sourcePatches, text);
    for (const ok of patched.results) {
      if (!ok) {
        throw new DiffMatchPatchError(DIFF_MATCH_PATCH_APPLY_ERROR, 'Error while applying patch');
      }
    }
    return patched;
  }

  patch_addPadding(patches: Patch[]): string {
    const paddingLength = this.Patch_Margin;
    let nullPadding = '';
    for (let x = 1; x <= paddingLength; x++) {
      nullPadding += String.fromCharCode(x);
    }
    for (const p of patches) {
      p.start1 += paddingLength;
      p.start2 += paddingLength;
    }

    let patch = patches[0];
    let diffs = patch.diffs;
    if (diffs.length === 0 || diffs[0].operation !== Operation.DIFF_EQUAL) {
      diffs.unshift(new Diff(Operation.DIFF_EQUAL, nullPadding));
      patch.start1 -= paddingLength;
      patch.start2 -= paddingLength;
      patch.length1 += paddingLength;
      patch.length2 += paddingLength;
    } else if (paddingLength > diffs[0].text.length) {
      const extraLength = paddingLength - diffs[0].text.length;
      diffs[0].text = nullPadding.substring(diffs[0].text.length) + diffs[0].text;
      patch.start1 -= extraLength;
      patch.start2 -= extraLength;
      patch.length1 += extraLength;
      patch.length2 += extraLength;
    }

    patch = patches[patches.length - 1];
    diffs = patch.diffs;
    if (diffs.length === 0 || diffs[diffs.length - 1].operation !== Operation.DIFF_EQUAL) {
      diffs.push(new Diff(Operation.DIFF_EQUAL, nullPadding));
      patch.length1 += paddingLength;
      patch.length2 += paddingLength;
    } else if (paddingLength > diffs[diffs.length - 1].text.length) {
      const extraLength = paddingLength - diffs[diffs.length - 1].text.length;
      diffs[diffs.length - 1].text += nullPadding.substring(0, extraLength);
      patch.length1 += extraLength;
      patch.length2 += extraLength;
    }
    return nullPadding;
  }

  patch_splitMax(patches: Patch[]): void {
    const patchSize = this.Match_MaxBits;
    for (let x = 0; x < patches.length; x++) {
      if (patches[x].length1 <= patchSize) {
        continue;
      }
      const bigpatch = patches[x];
      patches.splice(x--, 1);
      let start1 = bigpatch.start1;
      let start2 = bigpatch.start2;
      let precontext = '';
      while (bigpatch.diffs.length !== 0) {
        const patch = new Patch();
        let empty = true;
        patch.start1 = start1 - precontext.length;
        patch.start2 = start2 - precontext.length;
        if (precontext !== '') {
          patch.length1 = precontext.length;
          patch.length2 = precontext.length;
          patch.diffs.push(new Diff(Operation.DIFF_EQUAL, precontext));
        }
        while (bigpatch.diffs.length !== 0 && patch.length1 < patchSize - this.Patch_Margin) {
          const diffType = bigpatch.diffs[0].operation;
          let diffText = bigpatch.diffs[0].text;
          if (diffType === Operation.DIFF_INSERT) {
            patch.length2 += diffText.length;
            start2 += diffText.length;
            const moved = bigpatch.diffs.shift();
            if (moved !== undefined) {
              patch.diffs.push(moved);
            }
            empty = false;
          } else if (diffType === Operation.DIFF_DELETE && patch.diffs.length === 1 &&
            patch.diffs[0].operation === Operation.DIFF_EQUAL && diffText.length > 2 * patchSize) {
            patch.length1 += diffText.length;
            start1 += diffText.length;
            empty = false;
            patch.diffs.push(new Diff(diffType, diffText));
            bigpatch.diffs.shift();
          } else {
            diffText = diffText.substring(0, patchSize - patch.length1 - this.Patch_Margin);
            patch.length1 += diffText.length;
            start1 += diffText.length;
            if (diffType === Operation.DIFF_EQUAL) {
              patch.length2 += diffText.length;
              start2 += diffText.length;
            } else {
              empty = false;
            }
            patch.diffs.push(new Diff(diffType, diffText));
            if (diffText === bigpatch.diffs[0].text) {
              bigpatch.diffs.shift();
            } else {
              bigpatch.diffs[0].text = bigpatch.diffs[0].text.substring(diffText.length);
            }
          }
        }
        precontext = this.diff_text2(patch.diffs);
        precontext = precontext.substring(precontext.length - this.Patch_Margin);
        const postcontext = this.diff_text1(bigpatch.diffs).substring(0, this.Patch_Margin);
        if (postcontext !== '') {
          patch.length1 += postcontext.length;
          patch.length2 += postcontext.length;
          if (patch.diffs.length !== 0 && patch.diffs[patch.diffs.length - 1].operation === Operation.DIFF_EQUAL) {
            patch.diffs[patch.diffs.length - 1].text += postcontext;
          } else {
            patch.diffs.push(new Diff(Operation.DIFF_EQUAL, postcontext));
          }
        }
        if (!empty) {
          patches.splice(++x, 0, patch);
        }
      }
    }
  }

  patch_toText(patches: Patch[]): string {
    const text: string[] = [];
    for (const p of patches) {
      text.push(p.toString());
    }
    return text.join('');
  }

  patch_fromText(textline: string): Patch[] {
    const patches: Patch[] = [];
    if (textline.length === 0) {
      return patches;
    }
    const text = textline.split('\n');
    let textPointer = 0;
    const patchHeader = /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@$/;
    while (textPointer < text.length) {
      const m = text[textPointer].match(patchHeader);
      if (m === null) {
        throw new DiffMatchPatchError(104, 'Invalid patch string: ' + text[textPointer]);
      }
      const patch = new Patch();
      patches.push(patch);
      patch.start1 = parseInt(m[1], 10);
      if (m[2] === '') {
        patch.start1 -= 1;
        patch.length1 = 1;
      } else if (m[2] === '0') {
        patch.length1 = 0;
      } else {
        patch.start1--;
        patch.length1 = parseInt(m[2], 10);
      }
      patch.start2 = parseInt(m[3], 10);
      if (m[4] === '') {
        patch.start2--;
        patch.length2 = 1;
      } else if (m[4] === '0') {
        patch.length2 = 0;
      } else {
        patch.start2--;
        patch.length2 = parseInt(m[4], 10);
      }
      textPointer++;

      while (textPointer < text.length) {
        const sign = text[textPointer].charAt(0);
        const decoded = decodeUriCompatible(text[textPointer].substring(1));
        if (decoded === null) {
          throw new DiffMatchPatchError(105, 'Illegal escape in patch_fromText: ' + text[textPointer]);
        }
        if (sign === '-') {
          patch.diffs.push(new Diff(Operation.DIFF_DELETE, decoded));
        } else if (sign === '+') {
          patch.diffs.push(new Diff(Operation.DIFF_INSERT, decoded));
        } else if (sign === ' ') {
          patch.diffs.push(new Diff(Operation.DIFF_EQUAL, decoded));
        } else if (sign === '@') {
          break;
        } else if (sign === '') {
          // Blank line: skip
        } else {
          throw new DiffMatchPatchError(106, 'Invalid patch mode "' + sign + '" in: ' + decoded);
        }
        textPointer++;
      }
    }
    return patches;
  }
}
