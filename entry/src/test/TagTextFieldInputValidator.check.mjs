// Node self-check for validateTagInput against TagTextFieldInputValidatorTests.swift.
// Run: node entry/src/test/TagTextFieldInputValidator.check.mjs   (Node >= 23: strips the TS types)
import assert from 'node:assert/strict';
import { validateTagInput } from '../main/ets/model/TagTextFieldInputValidator.ts';

const len = (s) => s.length;
const v = (a, b) => validateTagInput(a, b, len);
assert.deepEqual(v('tag', 'tagx'), { result: 'valid', tag: 'tagx' });
assert.deepEqual(v('tag', 'tag '), { result: 'endingWithDisallowedCharacter', tag: 'tag' });
assert.deepEqual(v('tag', 'tag,'), { result: 'endingWithDisallowedCharacter', tag: 'tag' });
assert.deepEqual(v('tag', 'tag\n'), { result: 'endingWithDisallowedCharacter', tag: 'tag' });
assert.equal(v('tag', 'ta g').result, 'invalid');   // space in the middle
assert.equal(v('tag', ' tag').result, 'invalid');   // space at the start
assert.equal(v('tag', 'tag a b').result, 'invalid'); // paste with an embedded space
assert.deepEqual(v('tag', 'tagab '), { result: 'endingWithDisallowedCharacter', tag: 'tagab' });
assert.deepEqual(v('tag', 'ta'), { result: 'valid', tag: 'ta' });
assert.deepEqual(v('', ''), { result: 'valid', tag: '' });
assert.equal(v('a'.repeat(256), 'a'.repeat(257)).result, 'invalid');
assert.equal(v('a'.repeat(255), 'a'.repeat(256)).result, 'valid');
assert.equal(validateTagInput('a'.repeat(85), 'a'.repeat(86), (s) => s.length * 3).result, 'invalid');
console.log('TagTextFieldInputValidator.check: ok');
