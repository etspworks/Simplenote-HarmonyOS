// Port of TagTextFieldInputValidator.swift. A text field only reports its new text, so the edit
// (range + replacement) is recovered by diffing the previous text against the new one.

const DISALLOWED: RegExp = /[\s,]/;
const DISALLOWED_EDGES: RegExp = /^[\s,]+|[\s,]+$/g;
/// Constants.maximumTagLength
const MAXIMUM_TAG_LENGTH: number = 256;

/// .valid / .invalid / .endingWithDisallowedCharacter(trimmedTag): the field takes `tag` and ends editing
export type TagInputResult = 'valid' | 'invalid' | 'endingWithDisallowedCharacter';

export interface TagInputValidation {
  result: TagInputResult;
  tag: string;
}

/// validateInput(originalText:range:replacement:). `encodedLength` is the byEncodingAsTagHash length
/// (Tag.name is the simperiumKey, the backend limits the encoded form).
export function validateTagInput(originalText: string, newText: string,
  encodedLength: (tag: string) => number): TagInputValidation {
  let prefix: number = 0;
  while (prefix < originalText.length && prefix < newText.length && originalText[prefix] === newText[prefix]) {
    prefix++;
  }
  let suffix: number = 0;
  while (suffix < originalText.length - prefix && suffix < newText.length - prefix &&
    originalText[originalText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) {
    suffix++;
  }
  const replacement: string = newText.substring(prefix, newText.length - suffix);

  // rangeOfCharacter(from:) finds the first disallowed character; only one that ends the replacement,
  // typed at the end of the text, is accepted
  let endingWithDisallowed: boolean = false;
  const match: RegExpExecArray | null = DISALLOWED.exec(replacement);
  if (match !== null) {
    if (match.index === replacement.length - 1 && suffix === 0) {
      endingWithDisallowed = true;
    } else {
      return { result: 'invalid', tag: originalText };
    }
  }

  const tag: string = endingWithDisallowed ? newText.replace(DISALLOWED_EDGES, '') : newText;
  if (encodedLength(tag) > MAXIMUM_TAG_LENGTH) {
    return { result: 'invalid', tag: originalText };
  }
  return {
    result: endingWithDisallowed ? 'endingWithDisallowedCharacter' : 'valid',
    tag: tag
  };
}
