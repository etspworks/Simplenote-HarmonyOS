// Node self-check for NoteMetrics.wordCount against iOS NSString.wordCount (enumerateSubstrings .byWords).
// Run: node entry/src/test/NoteMetrics.check.mjs   (Node >= 23: strips the TS types)
import assert from 'node:assert/strict';
import { wordCount, charCount } from '../main/ets/model/NoteMetrics.ts';

const t0272 = 'RD1 md test\nGo to [Simplenote site](https://simplenote.com) now';
assert.equal(wordCount(t0272), 10); // iOS 4.55 Note Information, T-0272 evidence
assert.equal(charCount(t0272), 62);
assert.equal(wordCount(''), 0);
assert.equal(wordCount('  \n\n '), 0);
assert.equal(wordCount("don't stop"), 2);
assert.equal(wordCount('1,000.50 dollars'), 2);
assert.equal(wordCount('a - b -- c!'), 3);
assert.equal(wordCount('e-mail'), 2);
assert.equal(wordCount('#tag @user'), 2);
assert.equal(wordCount('中文字 hello'), 4);
assert.equal(wordCount('ひらがな'), 4);
assert.equal(wordCount('café naïve'), 2);
console.log('NoteMetrics.check: ok');
