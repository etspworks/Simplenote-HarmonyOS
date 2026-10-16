// Port of Simperium's jsondiff layer: SPMember.h/.m and its typed subclasses
// (SPMemberText / Int / Double / Float / Date / Dictionary / JSON / JSONList / List / Base64),
// SPSchema.m and SPDiffer.m. A member knows how to read its value out of a JSON dictionary,
// write it back, diff two values, apply a diff and transform (rebase) two concurrent diffs.
import { util } from '@kit.ArkTS';
import { Diff, DiffMatchPatch, DiffMatchPatchError } from './DiffMatchPatch';
import { SPGhost } from './GhostStore';

/** A JSON-compatible value (string | number | boolean | Date | array | dictionary), or nil. */
export type SPValue = Object | null | undefined;
export type SPDict = Record<string, SPValue>;

// SPMember.m operation constants
export const OP_OP: string = 'o';
export const OP_VALUE: string = 'v';
export const OP_REPLACE: string = 'r';
export const OP_LIST_INSERT: string = '+';
export const OP_LIST_DELETE: string = '-';
export const OP_OBJECT_ADD: string = '+';
export const OP_OBJECT_REMOVE: string = '-';
export const OP_OBJECT_REPLACE: string = 'r';
export const OP_INTEGER: string = 'I';
export const OP_LIST: string = 'L';
export const OP_LIST_DMP: string = 'dL';
export const OP_OBJECT: string = 'O';
export const OP_STRING: string = 'd';

export function isNil(value: SPValue): boolean {
  return value === null || value === undefined;
}

export function isDict(value: SPValue): boolean {
  return !isNil(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

/** JSONKit+Simperium: sp_JSONString */
export function jsonString(value: SPValue): string {
  return JSON.stringify(value === undefined ? null : value);
}

/** JSONKit+Simperium: sp_objectFromJSONString (nil on malformed input) */
export function objectFromJSONString(text: string | null | undefined): SPValue {
  if (text === null || text === undefined || text.length === 0) {
    return null;
  }
  try {
    const parsed: Object | null = JSON.parse(text) as Object | null;
    return parsed;
  } catch (e) {
    return null;
  }
}

export function dictFromJSONString(text: string | null | undefined): SPDict | null {
  const parsed = objectFromJSONString(text);
  return isDict(parsed) ? parsed as SPDict : null;
}

export function copyDict(dict: SPDict | null | undefined): SPDict {
  const out: SPDict = {};
  if (dict === null || dict === undefined) {
    return out;
  }
  for (const key of Object.keys(dict)) {
    const value = dict[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/** NSDictionary+Simperium sp_isValidJsonObject */
export function isValidJsonObject(dict: SPDict): boolean {
  try {
    JSON.stringify(dict);
    return true;
  } catch (e) {
    return false;
  }
}

function deepEqual(a: SPValue, b: SPValue): boolean {
  return jsonString(a) === jsonString(b);
}

/** NSString+Simperium sp_makeUUID: lowercase UUID without dashes */
export function makeUUID(): string {
  return util.generateRandomUUID(false).replace(/-/g, '').toLowerCase();
}

/** What SPDiffer needs from an entity (SPDiffable.h). */
export interface SPDiffable {
  ghost: SPGhost | null;
  ghostData: string | null;
  simperiumKey: string;
  simperiumSetValue(value: SPValue, key: string): void;
  simperiumValueForKey(key: string): SPValue;
  loadMemberData(data: SPDict): void;
  dictionary(): SPDict;
  version(): string | null;
  willBeRead(): void;
}

export class SPMemberDefinition {
  name: string;
  type: string;
  defaultValue?: SPValue;
  valueTransformerName?: string;

  constructor(name: string, type: string, defaultValue?: SPValue) {
    this.name = name;
    this.type = type;
    this.defaultValue = defaultValue;
  }
}

// MARK: - SPMember

export class SPMember {
  keyName: string;
  type: string;
  valueTransformerName: string | undefined;
  modelDefaultValue: SPValue;

  constructor(definition: SPMemberDefinition) {
    this.keyName = definition.name;
    this.type = definition.type;
    this.valueTransformerName = definition.valueTransformerName;
    this.modelDefaultValue = definition.defaultValue;
  }

  defaultValue(): SPValue {
    return null;
  }

  diffForAddition(data: SPValue): SPDict {
    const diff: SPDict = {};
    diff[OP_OP] = OP_OBJECT_ADD;
    this.setValueForKeyInDictionary(data, OP_VALUE, diff);
    return diff;
  }

  diffForReplacement(data: SPValue): SPDict {
    const diff: SPDict = {};
    diff[OP_OP] = OP_REPLACE;
    this.setValueForKeyInDictionary(data, OP_VALUE, diff);
    return diff;
  }

  diffForRemoval(): SPDict {
    const diff: SPDict = {};
    diff[OP_OP] = OP_OBJECT_REMOVE;
    return diff;
  }

  getValueFromDictionary(dict: SPDict | null | undefined, key: string): SPValue {
    if (dict === null || dict === undefined) {
      return null;
    }
    return dict[key];
  }

  setValueForKeyInDictionary(value: SPValue, key: string, dict: SPDict): void {
    if (isNil(value)) {
      dict[key] = undefined;
      return;
    }
    dict[key] = value;
  }

  diff(thisValue: SPValue, otherValue: SPValue): SPDict | null {
    return null;
  }

  /** Throws on failure (the ObjC NSError** out-parameter). */
  applyDiff(thisValue: SPValue, otherValue: SPValue): SPValue {
    return otherValue;
  }

  /** null = no transformation required. */
  transform(thisValue: SPValue, otherValue: SPValue, oldValue: SPValue): SPDict | null {
    return null;
  }
}

function replaceDiff(value: SPValue): SPDict {
  const out: SPDict = {};
  out[OP_OP] = OP_REPLACE;
  out[OP_VALUE] = value;
  return out;
}

export class SPMemberText extends SPMember {
  private dmp: DiffMatchPatch = new DiffMatchPatch();

  defaultValue(): SPValue {
    return '';
  }

  diff(thisValue: SPValue, otherValue: SPValue): SPDict | null {
    if (typeof thisValue !== 'string' || typeof otherValue !== 'string') {
      console.error('Simperium error: couldn\'t diff strings because their classes weren\'t NSString');
      return {};
    }
    const diffList: Diff[] = this.dmp.diff_main(thisValue as string, otherValue as string);
    if (diffList.length > 2) {
      this.dmp.diff_cleanupSemantic(diffList);
      this.dmp.diff_cleanupEfficiency(diffList);
    }
    if (diffList.length > 0 && this.dmp.diff_levenshtein(diffList) !== 0) {
      const out: SPDict = {};
      out[OP_OP] = OP_STRING;
      out[OP_VALUE] = this.dmp.diff_toDelta(diffList);
      return out;
    }
    return {};
  }

  applyDiff(thisValue: SPValue, otherValue: SPValue): SPValue {
    const source = typeof thisValue === 'string' ? thisValue as string : '';
    const delta = typeof otherValue === 'string' ? otherValue as string : '';
    const diffs = this.dmp.diff_fromDelta(source, delta);
    const patches = this.dmp.patch_make(source, diffs);
    return this.dmp.patch_apply(patches, source).text;
  }

  transform(thisValue: SPValue, otherValue: SPValue, oldValue: SPValue): SPDict | null {
    const oldText = typeof oldValue === 'string' ? oldValue as string : '';
    if (typeof thisValue !== 'string' || typeof otherValue !== 'string') {
      // ObjC: diff_fromDelta on a nil delta reports an error, which the caller treats as fatal
      throw new DiffMatchPatchError(103, 'Simperium error: text transform is missing a delta');
    }
    const thisDiffs = this.dmp.diff_fromDelta(oldText, thisValue as string);
    const otherDiffs = this.dmp.diff_fromDelta(oldText, otherValue as string);

    const thisPatches = this.dmp.patch_make(oldText, thisDiffs);
    const otherPatches = this.dmp.patch_make(oldText, otherDiffs);

    const otherResult = this.dmp.patch_apply(otherPatches, oldText);
    const otherString = otherResult.text;
    let combinedString: string;
    let failed = otherResult.results.indexOf(false) !== -1;
    const combined = this.dmp.patch_apply(thisPatches, otherString);
    combinedString = combined.text;
    failed = failed || combined.results.indexOf(false) !== -1;

    // If the rebase fails, fallback to the Local State
    if (failed) {
      combinedString = this.dmp.patch_applyOrThrow(thisPatches, oldText).text;
    }

    const finalDiffs = this.dmp.diff_main(otherString, combinedString);
    if (finalDiffs.length > 2) {
      this.dmp.diff_cleanupEfficiency(finalDiffs);
    }
    if (finalDiffs.length > 0) {
      const out: SPDict = {};
      out[OP_OP] = OP_STRING;
      out[OP_VALUE] = this.dmp.diff_toDelta(finalDiffs);
      return out;
    }
    return {};
  }
}

function numberValue(value: SPValue): number | null {
  if (typeof value === 'number') {
    return value as number;
  }
  if (typeof value === 'boolean') {
    return (value as boolean) ? 1 : 0;
  }
  return null;
}

export class SPMemberInt extends SPMember {
  defaultValue(): SPValue {
    return 0;
  }

  diff(thisValue: SPValue, otherValue: SPValue): SPDict | null {
    const a = numberValue(thisValue);
    const b = numberValue(otherValue);
    if (a === null || b === null) {
      console.error('Simperium error: couldn\'t diff ints because their classes weren\'t NSNumber');
      return {};
    }
    if (a === b) {
      return {};
    }
    return replaceDiff(otherValue);
  }

  getValueFromDictionary(dict: SPDict | null | undefined, key: string): SPValue {
    const value = super.getValueFromDictionary(dict, key);
    // Failsafe: Attempt to parse the int value
    if (typeof value === 'string') {
      const parsed = parseInt(value as string, 10);
      return isNaN(parsed) ? 0 : parsed;
    }
    return value;
  }

  applyDiff(thisValue: SPValue, otherValue: SPValue): SPValue {
    return otherValue;
  }

  transform(thisValue: SPValue, otherValue: SPValue, oldValue: SPValue): SPDict | null {
    // By default, don't transform anything, and take the local pending value
    return replaceDiff(thisValue);
  }
}

export class SPMemberDouble extends SPMember {
  defaultValue(): SPValue {
    return 0;
  }

  diff(thisValue: SPValue, otherValue: SPValue): SPDict | null {
    const a = numberValue(thisValue);
    const b = numberValue(otherValue);
    if (a === null || b === null) {
      console.error('Simperium error: couldn\'t diff doubles because their classes weren\'t NSNumber');
      return {};
    }
    const delta = a - b;
    const equal = (delta >= 0 && delta < 0.00001) || (delta < 0 && delta > -0.00001);
    if (equal) {
      return {};
    }
    return replaceDiff(otherValue);
  }

  applyDiff(thisValue: SPValue, otherValue: SPValue): SPValue {
    return otherValue;
  }

  transform(thisValue: SPValue, otherValue: SPValue, oldValue: SPValue): SPDict | null {
    return replaceDiff(thisValue);
  }
}

export class SPMemberFloat extends SPMemberDouble {
}

/** Dates live as Date in the entity and as seconds-since-1970 numbers on the wire. */
export class SPMemberDate extends SPMember {
  defaultValue(): SPValue {
    return new Date();
  }

  private dateValueFromNumber(value: SPValue): SPValue {
    if (isNil(value)) {
      return null;
    }
    if (typeof value === 'number') {
      return value;
    }
    if (value instanceof Date) {
      return (value as Date).getTime() / 1000;
    }
    return null;
  }

  getValueFromDictionary(dict: SPDict | null | undefined, key: string): SPValue {
    const value = super.getValueFromDictionary(dict, key);
    if (isNil(value)) {
      return null;
    }
    if (value instanceof Date) {
      return value;
    }
    const seconds = typeof value === 'number' ? value as number : parseFloat(String(value));
    return new Date(seconds * 1000);
  }

  setValueForKeyInDictionary(value: SPValue, key: string, dict: SPDict): void {
    if (isNil(value)) {
      return;
    }
    dict[key] = this.dateValueFromNumber(value);
  }

  diff(thisValue: SPValue, otherValue: SPValue): SPDict | null {
    if (!(thisValue instanceof Date) || !(otherValue instanceof Date)) {
      console.error('Simperium error: couldn\'t diff dates because their classes weren\'t NSDate');
      return {};
    }
    // Reduce granularity of timing for now due to rounding errors
    const delta = ((thisValue as Date).getTime() - (otherValue as Date).getTime()) / 1000;
    if (delta > -0.1 && delta < 0.1) {
      return {};
    }
    return replaceDiff(this.dateValueFromNumber(otherValue));
  }

  applyDiff(thisValue: SPValue, otherValue: SPValue): SPValue {
    return otherValue;
  }
}

export class SPMemberDictionary extends SPMember {
  defaultValue(): SPValue {
    const empty: SPDict = {};
    return empty;
  }

  diff(thisValue: SPValue, otherValue: SPValue): SPDict | null {
    if (!isDict(thisValue) || !isDict(otherValue)) {
      console.error('Simperium error: couldn\'t diff dictionaries because their classes weren\'t NSDictionary');
      return {};
    }
    if (deepEqual(thisValue, otherValue)) {
      return {};
    }
    return replaceDiff(otherValue);
  }

  getValueFromDictionary(dict: SPDict | null | undefined, key: string): SPValue {
    const value = super.getValueFromDictionary(dict, key);
    return isDict(value) ? value : null;
  }

  applyDiff(thisValue: SPValue, otherValue: SPValue): SPValue {
    return otherValue;
  }

  transform(thisValue: SPValue, otherValue: SPValue, oldValue: SPValue): SPDict | null {
    return replaceDiff(thisValue);
  }
}

/** SPMemberJSON: arbitrary JSON; applies nested +, -, r, O dictionary operations. */
export class SPMemberJSON extends SPMember {
  diff(thisValue: SPValue, otherValue: SPValue): SPDict | null {
    if (deepEqual(thisValue, otherValue)) {
      return {};
    }
    return replaceDiff(otherValue);
  }

  applyDiff(thisValue: SPValue, otherValue: SPValue): SPValue {
    if (isDict(thisValue) && isDict(otherValue)) {
      return this.applyDiffOnDictionary(otherValue as SPDict, thisValue as SPDict);
    }
    return otherValue;
  }

  private applyDiffOnDictionary(diffDict: SPDict, thisDict: SPDict): SPDict {
    const updated = copyDict(thisDict);
    for (const key of Object.keys(diffDict)) {
      const payload = diffDict[key];
      if (!isDict(payload)) {
        continue;
      }
      const op = (payload as SPDict)[OP_OP];
      const value = (payload as SPDict)[OP_VALUE];
      if (op === OP_REPLACE || op === OP_LIST_INSERT) {
        if (!isNil(value)) {
          updated[key] = value;
        }
      } else if (op === OP_LIST_DELETE) {
        updated[key] = undefined;
      } else if (op === OP_OBJECT) {
        const target = updated[key];
        if (isDict(value) && isDict(target)) {
          updated[key] = this.applyDiffOnDictionary(value as SPDict, target as SPDict);
        }
      }
    }
    return updated;
  }
}

/** SPMemberJSONList: a JSON-encoded array held as a string in the entity (Note.tags, Tag.share). */
export class SPMemberJSONList extends SPMember {
  defaultValue(): SPValue {
    return '[]';
  }

  private arrayFromString(value: SPValue): SPValue {
    if (typeof value !== 'string' || (value as string).length === 0) {
      return objectFromJSONString(this.defaultValue() as string);
    }
    return objectFromJSONString(value as string);
  }

  getValueFromDictionary(dict: SPDict | null | undefined, key: string): SPValue {
    const value = super.getValueFromDictionary(dict, key);
    if (isNil(value)) {
      return null;
    }
    return typeof value === 'string' ? value : jsonString(value);
  }

  setValueForKeyInDictionary(value: SPValue, key: string, dict: SPDict): void {
    dict[key] = this.arrayFromString(value);
  }

  diff(thisValue: SPValue, otherValue: SPValue): SPDict | null {
    if (typeof thisValue !== 'string' || typeof otherValue !== 'string') {
      console.error('Simperium error: couldn\'t diff JSON lists because their classes weren\'t NSString');
      return {};
    }
    if (thisValue === otherValue) {
      return {};
    }
    return replaceDiff(this.arrayFromString(otherValue));
  }

  applyDiff(thisValue: SPValue, otherValue: SPValue): SPValue {
    return otherValue;
  }
}

/** SPMemberList: a native array diffed as a dmp delta over its JSON lines (OP_LIST_DMP). */
export class SPMemberList extends SPMember {
  private dmp: DiffMatchPatch = new DiffMatchPatch();

  defaultValue(): SPValue {
    return '[]';
  }

  getValueFromDictionary(dict: SPDict | null | undefined, key: string): SPValue {
    const value = super.getValueFromDictionary(dict, key);
    return isNil(value) ? null : (typeof value === 'string' ? value : jsonString(value));
  }

  setValueForKeyInDictionary(value: SPValue, key: string, dict: SPDict): void {
    const text = typeof value === 'string' && (value as string).length > 0 ? value as string : '[]';
    dict[key] = objectFromJSONString(text);
  }

  // NSArray+Simperium: each element is serialised on its own line; the delta is a dmp delta
  private linesOf(list: SPValue): string {
    const arr: Object[] = Array.isArray(list) ? list as Object[] : [];
    const lines: string[] = [];
    for (const item of arr) {
      lines.push(jsonString(item) + '\n');
    }
    return lines.join('');
  }

  private listOf(text: string): SPValue {
    const out: Object[] = [];
    for (const line of text.split('\n')) {
      if (line.length > 0) {
        const parsed = objectFromJSONString(line);
        out.push(parsed === null || parsed === undefined ? 'null' : parsed);
      }
    }
    return out;
  }

  diff(thisValue: SPValue, otherValue: SPValue): SPDict | null {
    const a = this.linesOf(objectFromJSONString(thisValue as string));
    const b = this.linesOf(objectFromJSONString(otherValue as string));
    if (a === b) {
      return {};
    }
    const diffs = this.dmp.diff_main(a, b);
    const out: SPDict = {};
    out[OP_OP] = OP_LIST_DMP;
    out[OP_VALUE] = this.dmp.diff_toDelta(diffs);
    return out;
  }

  applyDiff(thisValue: SPValue, otherValue: SPValue): SPValue {
    const source = this.linesOf(objectFromJSONString(thisValue as string));
    const diffs = this.dmp.diff_fromDelta(source, otherValue as string);
    const patches = this.dmp.patch_make(source, diffs);
    return jsonString(this.listOf(this.dmp.patch_apply(patches, source).text));
  }

  transform(thisValue: SPValue, otherValue: SPValue, oldValue: SPValue): SPDict | null {
    const source = this.linesOf(objectFromJSONString(oldValue as string));
    const thisPatches = this.dmp.patch_make(source, this.dmp.diff_fromDelta(source, thisValue as string));
    const otherText = this.dmp.patch_apply(
      this.dmp.patch_make(source, this.dmp.diff_fromDelta(source, otherValue as string)), source).text;
    const combined = this.dmp.patch_apply(thisPatches, otherText).text;
    const out: SPDict = {};
    out[OP_OP] = OP_LIST_DMP;
    out[OP_VALUE] = this.dmp.diff_toDelta(this.dmp.diff_main(otherText, combined));
    return out;
  }
}

/**
 * SPMemberBase64: a Transformable attribute (Preferences.recent_searches). The ObjC side archives
 * with NSKeyedArchiver, which has no ArkTS reader.
 * ponytail: payload is base64(JSON) instead of base64(NSKeyedArchiver plist); an archive written
 * by an Apple client decodes to nil here. Add a binary-plist reader if that data must round-trip.
 */
export class SPMemberBase64 extends SPMember {
  private stringValueFromTransformable(value: SPValue): string {
    if (isNil(value)) {
      return '';
    }
    const bytes = util.TextEncoder.create('utf-8').encodeInto(jsonString(value));
    return new util.Base64Helper().encodeToStringSync(bytes);
  }

  getValueFromDictionary(dict: SPDict | null | undefined, key: string): SPValue {
    const value = super.getValueFromDictionary(dict, key);
    if (typeof value !== 'string') {
      return value;
    }
    if ((value as string).length === 0) {
      return null;
    }
    try {
      const bytes = new util.Base64Helper().decodeSync(value as string);
      const text = util.TextDecoder.create('utf-8').decodeToString(bytes);
      const obj = objectFromJSONString(text);
      if (isNil(obj) || (typeof obj === 'string' && (obj as string).length === 0)) {
        return null;
      }
      return obj;
    } catch (e) {
      return null;
    }
  }

  setValueForKeyInDictionary(value: SPValue, key: string, dict: SPDict): void {
    dict[key] = this.stringValueFromTransformable(value);
  }

  diff(thisValue: SPValue, otherValue: SPValue): SPDict | null {
    if (deepEqual(thisValue, otherValue)) {
      return {};
    }
    return replaceDiff(this.stringValueFromTransformable(otherValue));
  }

  applyDiff(thisValue: SPValue, otherValue: SPValue): SPValue {
    return otherValue;
  }
}

// MARK: - SPSchema

export class SPSchema {
  bucketName: string;
  members: Map<string, SPMember> = new Map<string, SPMember>();
  dynamic: boolean = false;

  constructor(bucketName: string, definitions: SPMemberDefinition[] | null) {
    this.bucketName = bucketName;
    if (definitions !== null) {
      for (const definition of definitions) {
        const member = SPSchema.memberForType(definition);
        if (member !== null) {
          this.members.set(member.keyName, member);
        }
      }
    }
  }

  static memberForType(definition: SPMemberDefinition): SPMember | null {
    switch (definition.type) {
      case 'text':
        return new SPMemberText(definition);
      case 'int':
      case 'bool':
        return new SPMemberInt(definition);
      case 'date':
        return new SPMemberDate(definition);
      case 'dictionary':
        return new SPMemberDictionary(definition);
      case 'double':
        return new SPMemberDouble(definition);
      case 'list':
        return new SPMemberList(definition);
      case 'json':
        return new SPMemberJSON(definition);
      case 'jsonlist':
        return new SPMemberJSONList(definition);
      case 'base64':
        return new SPMemberBase64(definition);
      default:
        return null;
    }
  }

  ensureDynamicMemberExistsForObject(object: SPValue, key: string): void {
    if (!this.dynamic || this.memberForKey(key) !== undefined) {
      return;
    }
    let type = 'unsupported';
    if (typeof object === 'string') {
      type = 'text';
    } else if (typeof object === 'number' || typeof object === 'boolean') {
      type = 'double';
    } else if (isDict(object)) {
      type = 'dictionary';
    }
    const member = SPSchema.memberForType(new SPMemberDefinition(key, type));
    if (member !== null) {
      this.members.set(member.keyName, member);
    }
  }

  memberForKey(memberName: string): SPMember | undefined {
    return this.members.get(memberName);
  }
}

// MARK: - SPDiffer

export class SPDiffer {
  schema: SPSchema;

  constructor(schema: SPSchema) {
    this.schema = schema;
  }

  diffForAddition(object: SPDiffable): SPDict {
    const diff: SPDict = {};
    this.schema.members.forEach((member: SPMember, key: string) => {
      const data = object.simperiumValueForKey(key);
      if (!isNil(data)) {
        diff[key] = member.diffForAddition(data);
      }
    });
    return diff;
  }

  diffFromDictionary(dict: SPDict | null | undefined, object: SPDiffable): SPDict {
    const changes: SPDict = {};
    this.schema.members.forEach((member: SPMember, key: string) => {
      const currentValue = object.simperiumValueForKey(key);
      const dictValue = member.getValueFromDictionary(dict, key);
      if (isNil(currentValue) && isNil(dictValue)) {
        return;
      }
      // An absent member and its type default are the same value: no phantom +/- for it. Rows saved by
      // older builds carry owner == '' while the server's note has no owner; diffing that as an addition
      // made every remote change fail to rebase (and get dropped) and every local save resend it.
      if ((isNil(currentValue) || isNil(dictValue)) &&
        jsonString(isNil(currentValue) ? dictValue : currentValue) === jsonString(member.defaultValue())) {
        return;
      }
      let currentDiff: SPDict | null;
      if (isNil(dictValue)) {
        currentDiff = member.diffForAddition(currentValue);
      } else if (isNil(currentValue)) {
        currentDiff = member.diffForRemoval();
      } else {
        currentDiff = member.diff(dictValue, currentValue);
      }
      if (currentDiff === null || Object.keys(currentDiff).length === 0) {
        return;
      }
      changes[member.keyName] = currentDiff;
    });
    return changes;
  }

  /** Throws when a member cannot apply its diff. */
  applyDiffFromDictionary(diff: SPDict, object: SPDiffable): void {
    for (const key of Object.keys(diff)) {
      const change = diff[key];
      if (!isDict(change)) {
        continue;
      }
      const changeDict = change as SPDict;
      const operation = String(changeDict[OP_OP]).toLowerCase();
      this.schema.ensureDynamicMemberExistsForObject(changeDict[OP_VALUE], key);
      const member = this.schema.memberForKey(key);
      if (member === undefined) {
        console.warn(`Simperium warning: applyDiff for a member that doesn't exist (${key})`);
        continue;
      }
      if (operation === OP_OBJECT_ADD || operation === OP_OBJECT_REPLACE) {
        object.simperiumSetValue(member.getValueFromDictionary(changeDict, OP_VALUE), key);
      } else if (operation === OP_OBJECT_REMOVE) {
        object.simperiumSetValue(null, key);
      } else {
        let thisValue = object.simperiumValueForKey(member.keyName);
        const otherValue = member.getValueFromDictionary(changeDict, OP_VALUE);
        if (isNil(thisValue)) {
          thisValue = member.defaultValue();
        }
        object.simperiumSetValue(member.applyDiff(thisValue, otherValue), key);
      }
    }
  }

  /** Throws when a member cannot apply its diff. */
  applyGhostDiffFromDictionary(diff: SPDict, object: SPDiffable): void {
    const ghost = object.ghost;
    const ghostMemberData: SPDict | null = ghost !== null ? ghost.memberData : null;
    const newMemberData: SPDict = copyDict(ghostMemberData);
    for (const key of Object.keys(diff)) {
      const change = diff[key];
      if (!isDict(change)) {
        continue;
      }
      const changeDict = change as SPDict;
      const operation = String(changeDict[OP_OP]).toLowerCase();
      this.schema.ensureDynamicMemberExistsForObject(changeDict[OP_VALUE], key);
      const member = this.schema.memberForKey(key);
      if (member === undefined) {
        console.warn(`Simperium warning: applyGhostDiff for a member that doesn't exist (${key})`);
        continue;
      }
      if (operation === OP_OBJECT_ADD || operation === OP_REPLACE) {
        newMemberData[key] = changeDict[OP_VALUE];
      } else if (operation === OP_OBJECT_REMOVE) {
        newMemberData[key] = undefined;
      } else {
        let thisValue = member.getValueFromDictionary(ghostMemberData, key);
        const otherValue = member.getValueFromDictionary(changeDict, OP_VALUE);
        if (isNil(thisValue)) {
          thisValue = member.defaultValue();
        } else if (isNil(otherValue)) {
          console.error(`Simperium error: member ${key} from diff wasn't in change`);
          continue;
        }
        member.setValueForKeyInDictionary(member.applyDiff(thisValue, otherValue), key, newMemberData);
      }
    }
    if (ghost !== null) {
      ghost.setMemberData(newMemberData);
    }
  }

  /** Throws when a member cannot transform. */
  transform(object: SPDiffable, diff: SPDict, oldDiff: SPDict, oldGhost: SPGhost): SPDict {
    const newDiff: SPDict = {};
    for (const key of Object.keys(diff)) {
      const change = diff[key] as SPDict;
      const oldChange = oldDiff[key] as SPDict;
      const member = this.schema.memberForKey(key);
      if (member === undefined) {
        console.error(`Simperium error: transform diff for a member that doesn't exist (${key})`);
        continue;
      }
      const ghostValue = member.getValueFromDictionary(oldGhost.memberData, key);
      if (isNil(ghostValue)) {
        console.error(`Simperium error: transform diff for a ghost member that doesn't exist (${key})`);
        continue;
      }
      const thisValue = member.getValueFromDictionary(change, OP_VALUE);
      const otherValue = member.getValueFromDictionary(oldChange, OP_VALUE);
      const newChange = member.transform(thisValue, otherValue, ghostValue);
      newDiff[key] = newChange !== null ? newChange : copyDict(change);
    }
    return newDiff;
  }
}

