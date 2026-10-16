// Port of Note.h/.m (the synced note entity, an SPManagedObject) plus its Swift extensions:
// Note+Properties.swift (isBlank, date(for:), emailTags, previews, bodyExcerpt),
// Note+Links.swift (plainInternalLink, markdownInternalLink, publicLink, instancesOfReference),
// Note+Publish.swift (publishState) and NoteContentHelper.swift (title / body ranges).
// Persisted by relationalStore through the Simperium storage (table "Note", ../common/Database).
import { i18n, intl } from '@kit.LocalizationKit';
import { SPManagedObject, SPMemberDefinition } from '../common/simperium/Bucket';
import { SPDict, SPValue, jsonString, objectFromJSONString } from '../common/simperium/JsonDiff';
import { SortMode } from './SortMode';

/** NSComparisonResult */
export enum ComparisonResult {
  ORDERED_ASCENDING = -1,
  ORDERED_SAME = 0,
  ORDERED_DESCENDING = 1
}

/** Note+Publish.swift */
export enum PublishState {
  PUBLISHED = 0,
  PUBLISHING = 1,
  UNPUBLISHED = 2,
  UNPUBLISHING = 3
}

// SimplenoteConstants.swift (the values Note+Links needs)
export const SIMPLENOTE_SCHEME: string = 'simplenote';
export const SIMPLENOTE_INTERLINK_HOST: string = 'note';
export const SIMPLENOTE_INTERLINK_MAX_TITLE_LENGTH: number = 150;
export const SIMPLENOTE_PUBLISHED_BASE_URL: string = 'http://simp.ly/publish/';

// Note+Properties.swift Constants
const TITLE_MARKDOWN_PREFIX: string = '# ';
const BODY_PREVIEW_CAP: number = 500;
const EXCERPT_LEADING_LIMIT: number = 30;
const EXCERPT_TRAILING_LIMIT: number = 300;
const NEW_NOTE_PLACEHOLDER: string = 'New note...';

// System tags
const SYSTEM_TAG_PINNED: string = 'pinned';
const SYSTEM_TAG_SHARED: string = 'shared';
const SYSTEM_TAG_PUBLISHED: string = 'published';
const SYSTEM_TAG_UNREAD: string = 'unread';
const SYSTEM_TAG_MARKDOWN: string = 'markdown';

// NSPredicate+Email.swift
const EMAIL_REGEX: RegExp = /^.+@([A-Za-z0-9-]+\.)+[A-Za-z]{2}[A-Za-z]*$/;

/** String.simplenotePath(withHost:) */
export function simplenotePath(host?: string): string {
  const base = `${SIMPLENOTE_SCHEME}://`;
  return host === undefined ? base : `${base}${host}/`;
}

/** String.truncateWords(upTo:) */
export function truncateWords(text: string, maximumLength: number): string {
  let output = '';
  for (const word of text.split(/[ \t]/)) {
    if (output.length + word.length >= maximumLength) {
      break;
    }
    output += (output.length === 0 ? '' : ' ') + word;
  }
  if (output.length === 0) {
    return text.substring(0, maximumLength).trim();
  }
  return output;
}

/** String.replacingNewlinesWithSpaces() */
export function replacingNewlinesWithSpaces(text: string): string {
  if (text.length === 0) {
    return text;
  }
  return text.split(/[\n\r\u2028\u2029\u0085]/).filter((c: string) => c.length > 0).join(' ');
}

/** NSString.isValidEmailAddress */
export function isValidEmailAddress(text: string): boolean {
  return EMAIL_REGEX.test(text);
}

/** A range of UTF-16 offsets: lower..<upper */
export class TextRange {
  lower: number;
  upper: number;

  constructor(lower: number, upper: number) {
    this.lower = lower;
    this.upper = upper;
  }
}

/** NoteContentHelper.structure(of:) result */
export class NoteStructure {
  title: TextRange | null;
  body: TextRange | null;
  trimmedBody: TextRange | null;

  constructor(title: TextRange | null, body: TextRange | null, trimmedBody: TextRange | null) {
    this.title = title;
    this.body = body;
    this.trimmedBody = trimmedBody;
  }
}

const WHITESPACE_AND_NEWLINES: RegExp = /[\s\u0085]/;
const NEWLINES: RegExp = /[\n\r\u2028\u2029\u0085\u000B\u000C]/;

function locationOfFirstCharacter(content: string, matches: (ch: string) => boolean, start: number,
  backwards: boolean = false): number {
  if (start > content.length) {
    return -1;
  }
  if (backwards) {
    for (let i = start - 1; i >= 0; i--) {
      if (matches(content.charAt(i))) {
        return i;
      }
    }
    return -1;
  }
  for (let i = start; i < content.length; i++) {
    if (matches(content.charAt(i))) {
      return i;
    }
  }
  return -1;
}

function isNotWhitespace(ch: string): boolean {
  return !WHITESPACE_AND_NEWLINES.test(ch);
}

function isNewline(ch: string): boolean {
  return NEWLINES.test(ch);
}

function trimmedTextRange(content: string, startLocation: number, endAtNewline: boolean): TextRange | null {
  const first = locationOfFirstCharacter(content, isNotWhitespace, startLocation);
  if (first === -1) {
    return null;
  }
  let endRangeLocation = content.length;
  if (endAtNewline) {
    const newline = locationOfFirstCharacter(content, isNewline, first);
    endRangeLocation = newline === -1 ? content.length : newline;
  }
  const last = locationOfFirstCharacter(content, isNotWhitespace, endRangeLocation, true);
  if (last === -1) {
    return null;
  }
  return new TextRange(first, last + 1);
}

/** NoteContentHelper.structure(of:) */
export function noteStructure(content: string | null): NoteStructure {
  if (content === null || content.length === 0) {
    return new NoteStructure(null, null, null);
  }
  const titleRange = trimmedTextRange(content, 0, true);
  if (titleRange === null) {
    return new NoteStructure(null, null, null);
  }
  const newline = locationOfFirstCharacter(content, isNewline, titleRange.upper);
  if (newline === -1) {
    return new NoteStructure(titleRange, null, null);
  }
  const bodyStart = newline + 1;
  return new NoteStructure(titleRange, new TextRange(bodyStart, content.length),
    trimmedTextRange(content, bodyStart, false));
}

function compareStrings(a: string, b: string): ComparisonResult {
  if (a < b) {
    return ComparisonResult.ORDERED_ASCENDING;
  }
  return a > b ? ComparisonResult.ORDERED_DESCENDING : ComparisonResult.ORDERED_SAME;
}

/** NSString -caseInsensitiveCompare: */
export function caseInsensitiveCompare(a: string, b: string): ComparisonResult {
  return compareStrings(a.toLowerCase(), b.toLowerCase());
}

function compareDates(a: Date, b: Date): ComparisonResult {
  const delta = a.getTime() - b.getTime();
  if (delta < 0) {
    return ComparisonResult.ORDERED_ASCENDING;
  }
  return delta > 0 ? ComparisonResult.ORDERED_DESCENDING : ComparisonResult.ORDERED_SAME;
}

function stringArrayFromJSON(text: string | null): string[] {
  if (text === null || text.length === 0) {
    return [];
  }
  const parsed = objectFromJSONString(text);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const out: string[] = [];
  for (const item of parsed as Object[]) {
    out.push(String(item));
  }
  return out;
}

function boolFromValue(value: SPValue): boolean {
  if (typeof value === 'boolean') {
    return value as boolean;
  }
  if (typeof value === 'number') {
    return (value as number) !== 0;
  }
  if (typeof value === 'string') {
    return (value as string) === '1' || (value as string).toLowerCase() === 'true';
  }
  return false;
}

// Date formatters (Note.m -dateString:brief:)
const LOCALE: string = i18n.System.getSystemLocale();
const TIME_FORMATTER: intl.DateTimeFormat = new intl.DateTimeFormat(LOCALE, { timeStyle: 'short' });
const MONTH_DAY_FORMATTER: intl.DateTimeFormat = new intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric' });
const MONTH_DAY_YEAR_FORMATTER: intl.DateTimeFormat =
  new intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric', year: 'numeric' });
const NUMBERS_FORMATTER: intl.DateTimeFormat = new intl.DateTimeFormat(LOCALE, { dateStyle: 'short' });

export class Note extends SPManagedObject {
  /** Synced members of the Note entity (Simplenote 7.xcdatamodel, as SPCoreDataExporter exports it). */
  static readonly SCHEMA_MEMBERS: SPMemberDefinition[] = [
    new SPMemberDefinition('content', 'text'),
    new SPMemberDefinition('creationDate', 'date'),
    new SPMemberDefinition('deleted', 'int', false),
    new SPMemberDefinition('modificationDate', 'date'),
    new SPMemberDefinition('owner', 'text'),
    new SPMemberDefinition('publishURL', 'text'),
    new SPMemberDefinition('shareURL', 'text'),
    new SPMemberDefinition('systemTags', 'jsonlist'),
    new SPMemberDefinition('tags', 'jsonlist')
  ];

  content: string = '';
  creationDate: Date = new Date();
  modificationDate: Date = new Date();
  owner: string | null = null;
  remoteId: string | null = null;
  noteSynced: boolean = false;
  modificationDatePreview: string | null = null;
  creationDatePreview: string | null = null;
  titlePreview: string | null = null;
  bodyPreview: string | null = null;
  tagsArray: string[] = [];
  versions: SPDict | null = null;
  private tagsValue: string | null = null;
  private systemTagsValue: string | null = null;
  private systemTagsArray: string[] = [];
  private shareURLValue: string | null = null;
  private publishURLValue: string | null = null;
  private lastPositionValue: number = 0;
  private deletedValue: boolean = false;
  private pinnedValue: boolean = false;
  private markdownValue: boolean = false;
  private sharedValue: boolean = false;
  private publishedValue: boolean = false;
  private unreadValue: boolean = false;

  // MARK: - Simperium member access (KVC)

  protected getMemberValue(key: string): SPValue {
    switch (key) {
      case 'content':
        return this.content;
      case 'creationDate':
        return this.creationDate;
      case 'deleted':
        return this.deletedValue;
      case 'modificationDate':
        return this.modificationDate;
      case 'owner':
        return this.owner;
      case 'publishURL':
        return this.publishURLValue;
      case 'shareURL':
        return this.shareURLValue;
      case 'systemTags':
        return this.systemTagsValue;
      case 'tags':
        return this.tagsValue;
      default:
        return null;
    }
  }

  protected setMemberValue(key: string, value: SPValue): void {
    switch (key) {
      case 'content':
        this.content = typeof value === 'string' ? value as string : '';
        // iOS refreshes the managed object after a remote merge (awakeFromFetch -> createPreview);
        // without this the list keeps the old preview after a remote edit.
        this.createPreview();
        break;
      case 'creationDate':
        this.creationDate = value instanceof Date ? value as Date : new Date();
        break;
      case 'deleted':
        this.setDeleted(boolFromValue(value));
        break;
      case 'modificationDate':
        this.modificationDate = value instanceof Date ? value as Date : new Date();
        break;
      case 'owner':
        this.owner = typeof value === 'string' ? value as string : null;
        break;
      case 'publishURL':
        this.setPublishURL(typeof value === 'string' ? value as string : null);
        break;
      case 'shareURL':
        this.setShareURL(typeof value === 'string' ? value as string : null);
        break;
      case 'systemTags':
        this.setSystemTags(typeof value === 'string' ? value as string : null);
        break;
      case 'tags':
        this.setTags(typeof value === 'string' ? value as string : null);
        break;
      default:
        break;
    }
  }

  /** Member data plus the local-only attributes (lastPosition, remoteId, noteSynced). */
  storageDictionary(): SPDict {
    const dict = this.dictionary();
    dict['lastPosition'] = this.lastPositionValue;
    dict['remoteId'] = this.remoteId;
    dict['noteSynced'] = this.noteSynced;
    return dict;
  }

  loadStorageDictionary(data: SPDict): void {
    this.loadMemberData(data);
    const lastPosition = data['lastPosition'];
    this.lastPositionValue = typeof lastPosition === 'number' ? lastPosition as number : 0;
    const remoteId = data['remoteId'];
    this.remoteId = typeof remoteId === 'string' ? remoteId as string : null;
    this.noteSynced = boolFromValue(data['noteSynced']);
  }

  // MARK: - Lifecycle

  awakeFromFetch(): void {
    super.awakeFromFetch();
    this.createPreview();
    this.updateTagsArray();
    this.updateSystemTagsArray();
    this.updateSystemTagFlags();
  }

  awakeFromInsert(remote: boolean): void {
    super.awakeFromInsert(remote);
    this.content = '';
    this.publishURLValue = '';
    this.shareURLValue = '';
    this.creationDate = new Date();
    this.modificationDate = new Date();
    this.tagsValue = '[]';
    this.systemTagsValue = '[]';
    this.updateSystemTagsArray();
    this.updateTagsArray();
  }

  didTurnIntoFault(): void {
    super.didTurnIntoFault();
  }

  // MARK: - Properties

  localID(): string | null {
    if (this.bucket === null || !this.bucket.storage.isPersisted(this)) {
      return null;
    }
    return `x-coredata://${this.bucket.name}/${this.simperiumKey}`;
  }

  get tags(): string | null {
    return this.tagsValue;
  }

  set tags(newTags: string | null) {
    this.setTags(newTags);
  }

  get systemTags(): string | null {
    return this.systemTagsValue;
  }

  set systemTags(newTags: string | null) {
    this.setSystemTags(newTags);
  }

  get shareURL(): string | null {
    return this.shareURLValue;
  }

  set shareURL(url: string | null) {
    this.setShareURL(url);
  }

  get publishURL(): string | null {
    return this.publishURLValue;
  }

  set publishURL(url: string | null) {
    this.setPublishURL(url);
  }

  get deleted(): boolean {
    return this.deletedValue;
  }

  set deleted(b: boolean) {
    this.setDeleted(b);
  }

  get pinned(): boolean {
    return this.pinnedValue;
  }

  set pinned(b: boolean) {
    this.setPinned(b);
  }

  get markdown(): boolean {
    return this.markdownValue;
  }

  set markdown(b: boolean) {
    this.setMarkdown(b);
  }

  get shared(): boolean {
    return this.sharedValue;
  }

  set shared(b: boolean) {
    this.setShared(b);
  }

  get published(): boolean {
    return this.publishedValue;
  }

  set published(b: boolean) {
    this.setPublished(b);
  }

  get unread(): boolean {
    return this.unreadValue;
  }

  set unread(b: boolean) {
    this.setUnread(b);
  }

  get lastPosition(): number {
    return this.lastPositionValue;
  }

  set lastPosition(position: number) {
    this.setLastPosition(position);
  }

  primitiveContent(): string {
    return this.content;
  }

  setPrimitiveContent(newContent: string): void {
    this.content = newContent;
  }

  setDeleted(b: boolean): void {
    if (b === this.deletedValue) {
      return;
    }
    this.deletedValue = b;
  }

  setShared(bShared: boolean): void {
    if (bShared) {
      this.addSystemTag(SYSTEM_TAG_SHARED);
    } else {
      this.stripSystemTag(SYSTEM_TAG_SHARED);
    }
    this.sharedValue = bShared;
  }

  setPublished(bPublished: boolean): void {
    if (bPublished) {
      this.addSystemTag(SYSTEM_TAG_PUBLISHED);
    } else {
      this.stripSystemTag(SYSTEM_TAG_PUBLISHED);
    }
    this.publishedValue = bPublished;
  }

  setUnread(bUnread: boolean): void {
    if (bUnread) {
      this.addSystemTag(SYSTEM_TAG_UNREAD);
    } else {
      this.stripSystemTag(SYSTEM_TAG_UNREAD);
    }
    this.unreadValue = bUnread;
  }

  setPinned(bPinned: boolean): void {
    if (bPinned) {
      this.addSystemTag(SYSTEM_TAG_PINNED);
    } else {
      this.stripSystemTag(SYSTEM_TAG_PINNED);
    }
    this.pinnedValue = bPinned;
  }

  setMarkdown(bMarkdown: boolean): void {
    if (bMarkdown) {
      this.addSystemTag(SYSTEM_TAG_MARKDOWN);
    } else {
      this.stripSystemTag(SYSTEM_TAG_MARKDOWN);
    }
    this.markdownValue = bMarkdown;
  }

  setLastPosition(newLastPosition: number): void {
    if (this.lastPositionValue === newLastPosition) {
      return;
    }
    this.lastPositionValue = newLastPosition;
  }

  setShareURL(url: string | null): void {
    if (this.shareURLValue === url) {
      return;
    }
    this.shareURLValue = url;
  }

  setPublishURL(url: string | null): void {
    if (this.publishURLValue === url) {
      return;
    }
    this.publishURLValue = url;
  }

  setTags(newTags: string | null): void {
    if (this.tagsValue === newTags) {
      return;
    }
    this.tagsValue = newTags;
    this.updateTagsArray();
  }

  setSystemTags(newTags: string | null): void {
    if (this.systemTagsValue === newTags) {
      return;
    }
    this.systemTagsValue = newTags;
    this.updateSystemTagsArray();
    this.updateSystemTagFlags();
  }

  /** Maintain flags for performance purposes */
  updateSystemTagFlags(): void {
    this.pinnedValue = this.hasSystemTag(SYSTEM_TAG_PINNED);
    this.sharedValue = this.hasSystemTag(SYSTEM_TAG_SHARED);
    this.publishedValue = this.hasSystemTag(SYSTEM_TAG_PUBLISHED);
    this.unreadValue = this.hasSystemTag(SYSTEM_TAG_UNREAD);
    this.markdownValue = this.hasSystemTag(SYSTEM_TAG_MARKDOWN);
  }

  ensurePreviewStringsAreAvailable(): void {
    if (this.titlePreview !== null) {
      return;
    }
    this.createPreview();
  }

  // MARK: - Comparators (pinned notes always first)

  private comparePinned(note: Note): ComparisonResult | null {
    if (this.pinnedValue && !note.pinned) {
      return ComparisonResult.ORDERED_ASCENDING;
    } else if (!this.pinnedValue && note.pinned) {
      return ComparisonResult.ORDERED_DESCENDING;
    }
    return null;
  }

  compareModificationDate(note: Note): ComparisonResult {
    return this.comparePinned(note) ?? compareDates(note.modificationDate, this.modificationDate);
  }

  compareModificationDateReverse(note: Note): ComparisonResult {
    return this.comparePinned(note) ?? compareDates(this.modificationDate, note.modificationDate);
  }

  compareCreationDate(note: Note): ComparisonResult {
    return this.comparePinned(note) ?? compareDates(note.creationDate, this.creationDate);
  }

  compareCreationDateReverse(note: Note): ComparisonResult {
    return this.comparePinned(note) ?? compareDates(this.creationDate, note.creationDate);
  }

  compareAlpha(note: Note): ComparisonResult {
    return this.comparePinned(note) ?? caseInsensitiveCompare(this.content, note.content);
  }

  compareAlphaReverse(note: Note): ComparisonResult {
    return this.comparePinned(note) ?? caseInsensitiveCompare(note.content, this.content);
  }

  // MARK: - Date strings

  dateString(date: Date, brief: boolean): string {
    const now = new Date();
    const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const deltaMinutes = Math.trunc((nowMidnight.getTime() - date.getTime()) / 60000);
    const lastYearEnd = new Date(now.getFullYear() - 1, 11, 31);

    if (deltaMinutes <= 0) {
      const todayStr = 'Today';
      return (brief ? '' : `${todayStr}, `) + TIME_FORMATTER.format(date);
    } else if (deltaMinutes < 60 * 24) {
      const yesterdayStr = 'Yesterday';
      return brief ? yesterdayStr : `${yesterdayStr}, ${TIME_FORMATTER.format(date)}`;
    } else if (date.getTime() > lastYearEnd.getTime()) {
      // This year
      return brief ? MONTH_DAY_FORMATTER.format(date) :
        `${MONTH_DAY_FORMATTER.format(date)}, ${TIME_FORMATTER.format(date)}`;
    }
    // Previous years
    return brief ? NUMBERS_FORMATTER.format(date) : MONTH_DAY_YEAR_FORMATTER.format(date);
  }

  creationDateString(brief: boolean): string {
    return this.dateString(this.creationDate, brief);
  }

  modificationDateString(brief: boolean): string {
    return this.dateString(this.modificationDate, brief);
  }

  // MARK: - Tags

  setTagsFromList(tagList: string[]): void {
    this.setTags(jsonString(tagList));
  }

  updateTagsArray(): void {
    this.tagsArray = stringArrayFromJSON(this.tagsValue);
  }

  hasTags(): boolean {
    if (this.tagsValue === null || this.tagsValue.length === 0) {
      return false;
    }
    return this.tagsArray.length > 0;
  }

  hasTag(tag: string): boolean {
    if (this.tagsValue === null || this.tagsValue.length === 0) {
      return false;
    }
    return this.tagsArray.indexOf(tag) !== -1;
  }

  addTag(tag: string): void {
    if (!this.hasTag(tag)) {
      this.tagsArray.push(tag);
      this.setTags(jsonString(this.tagsArray));
    }
  }

  stripTag(tag: string): void {
    if (this.tagsValue === null || this.tagsValue.length === 0) {
      return;
    }
    this.tagsArray = this.tagsArray.filter((t: string) => t !== tag);
    this.setTags(jsonString(this.tagsArray));
  }

  updateSystemTagsArray(): void {
    this.systemTagsArray = stringArrayFromJSON(this.systemTagsValue);
  }

  addSystemTag(tag: string): void {
    if (!this.hasSystemTag(tag)) {
      this.systemTagsArray.push(tag);
      this.setSystemTags(jsonString(this.systemTagsArray));
    }
  }

  hasSystemTag(tag: string): boolean {
    if (this.systemTagsValue === null || this.systemTagsValue.length === 0) {
      return false;
    }
    return this.systemTagsArray.indexOf(tag) !== -1;
  }

  setSystemTagsFromList(tagList: string[]): void {
    this.setSystemTags(jsonString(tagList));
  }

  stripSystemTag(tag: string): void {
    if (this.systemTagsValue === null || this.systemTagsValue.length === 0) {
      return;
    }
    this.systemTagsArray = this.systemTagsArray.filter((t: string) => t !== tag);
    this.setSystemTags(jsonString(this.systemTagsArray));
  }

  noteDictionaryWithContent(include: boolean): SPDict {
    const note: SPDict = {};
    if (this.remoteId !== null && this.remoteId.length > 1) {
      note['key'] = this.remoteId;
    }
    note['deleted'] = this.deletedValue ? '1' : '0';
    note['tags'] = stringArrayFromJSON(this.tagsValue);
    note['systemtags'] = stringArrayFromJSON(this.systemTagsValue);
    note['modifydate'] = this.modificationDate.getTime() / 1000;
    note['createdate'] = this.creationDate.getTime() / 1000;
    if (include) {
      note['content'] = this.content;
    }
    return note;
  }

  isList(): boolean {
    // Quick and dirty for now to avoid having to upgrade the database again with another flag
    const newline = this.content.indexOf('\n');
    if (newline === -1 || newline + 1 + 2 > this.content.length) {
      return false;
    }
    return this.content.substring(newline + 1, newline + 3) === '- ';
  }

  // MARK: - Note+Properties

  /** Indicates if the receiver is a blank document */
  get isBlank(): boolean {
    return this.localID() === null && this.content.length === 0 && this.tagsArray.length === 0;
  }

  /** Returns the Creation / Modification date for a given SortMode */
  date(sortMode: SortMode): Date | null {
    switch (sortMode) {
      case SortMode.ALPHABETICALLY_ASCENDING:
      case SortMode.ALPHABETICALLY_DESCENDING:
        return null;
      case SortMode.CREATED_NEWEST:
      case SortMode.CREATED_OLDEST:
        return this.creationDate;
      case SortMode.MODIFIED_NEWEST:
      case SortMode.MODIFIED_OLDEST:
        return this.modificationDate;
      default:
        return null;
    }
  }

  /** Returns the collection user emails with who we're sharing this document */
  get emailTags(): string[] {
    return this.tagsArray.filter((tag: string) => isValidEmailAddress(tag));
  }

  /** Create title and body previews from content */
  createPreview(): void {
    const structure = noteStructure(this.content);
    this.titlePreview = this.titlePreviewWith(structure.title);
    this.bodyPreview = this.bodyPreviewWith(structure.trimmedBody);
    this.updateTagsArray();
  }

  private titlePreviewWith(range: TextRange | null): string {
    if (range === null) {
      return NEW_NOTE_PLACEHOLDER;
    }
    const result = this.content.substring(range.lower, range.upper);
    return result.startsWith(TITLE_MARKDOWN_PREFIX) ? result.substring(TITLE_MARKDOWN_PREFIX.length) : result;
  }

  private bodyPreviewWith(range: TextRange | null): string | null {
    if (range === null) {
      return null;
    }
    const upper = Math.min(range.lower + BODY_PREVIEW_CAP, range.upper);
    return replacingNewlinesWithSpaces(this.content.substring(range.lower, upper));
  }

  /** Returns excerpt of the content around the first match of one of the keywords */
  bodyExcerpt(keywords: string[] | null): string | null {
    if (keywords === null || keywords.length === 0) {
      return this.bodyPreview;
    }
    const content = this.content.normalize('NFC');
    const bodyRange = noteStructure(content).trimmedBody;
    if (bodyRange === null) {
      return null;
    }
    const excerpt = contentSlice(content, keywords, bodyRange, EXCERPT_LEADING_LIMIT, EXCERPT_TRAILING_LIMIT);
    if (excerpt === null) {
      return this.bodyPreview;
    }
    const shouldAddEllipsis = excerpt.lower > bodyRange.lower;
    const excerptString = (shouldAddEllipsis ? '…' : '') + content.substring(excerpt.lower, excerpt.upper);
    return replacingNewlinesWithSpaces(excerptString);
  }

  // MARK: - Note+Links

  /** Internal note link */
  get plainInternalLink(): string | null {
    if (this.simperiumKey.length === 0) {
      return null;
    }
    return simplenotePath(SIMPLENOTE_INTERLINK_HOST) + this.simperiumKey;
  }

  /** Returns the receiver's Markdown Internal Reference, when possible */
  get markdownInternalLink(): string | null {
    const title = this.titlePreview;
    const link = this.plainInternalLink;
    if (title === null || link === null) {
      return null;
    }
    const shortened = truncateWords(title, SIMPLENOTE_INTERLINK_MAX_TITLE_LENGTH);
    return `[${shortened}](${link})`;
  }

  /** Returns the full Public Link to the current document */
  get publicLink(): string | null {
    const targetURL = this.publishURLValue;
    if (targetURL === null || targetURL.length === 0 || !this.publishedValue) {
      return null;
    }
    return SIMPLENOTE_PUBLISHED_BASE_URL + targetURL;
  }

  instancesOfReference(note: Note): number {
    const internalLink = note.plainInternalLink;
    if (internalLink === null) {
      return 0;
    }
    return this.content.split(internalLink).length - 1;
  }

  // MARK: - Note+Publish

  get publishState(): PublishState {
    const url = this.publishURLValue ?? '';
    if (this.publishedValue && url.length > 0) {
      return PublishState.PUBLISHED;
    }
    if (this.publishedValue && url.length === 0) {
      return PublishState.PUBLISHING;
    }
    if (!this.publishedValue && url.length > 0) {
      return PublishState.UNPUBLISHING;
    }
    return PublishState.UNPUBLISHED;
  }
}

/**
 * String.contentSlice(matching:in:leadingLimit:trailingLimit:): the range around the first
 * keyword match, trimmed to whole words within the limits. Words are runs of letters / digits.
 */
function contentSlice(content: string, keywords: string[], range: TextRange, leadingLimit: number,
  trailingLimit: number): TextRange | null {
  const wordRegex = /[^\s.,;:!?"()\[\]{}<>\/\\|@#$%^&*+=~`\-]+/g;
  const segment = content.substring(range.lower, range.upper);
  const words: TextRange[] = [];
  let m: RegExpExecArray | null = wordRegex.exec(segment);
  while (m !== null) {
    words.push(new TextRange(range.lower + m.index, range.lower + m.index + m[0].length));
    m = wordRegex.exec(segment);
  }
  const fold = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const foldedKeywords = keywords.map(fold);

  const leading: TextRange[] = [];
  const matching: TextRange[] = [];
  const trailing: TextRange[] = [];
  for (const word of words) {
    if (trailingLimit > 0 && matching.length > 0) {
      if (word.upper - matching[0].upper > trailingLimit) {
        break;
      }
      trailing.push(word);
    }
    const folded = fold(content.substring(word.lower, word.upper));
    for (const keyword of foldedKeywords) {
      if (folded.indexOf(keyword) !== -1) {
        matching.push(word);
        break;
      }
    }
    if (leadingLimit > 0 && matching.length === 0) {
      leading.push(word);
    }
  }
  if (matching.length === 0) {
    return null;
  }
  const firstMatch = matching[0];
  const lastMatch = matching[matching.length - 1];

  let lower = range.lower;
  if (leadingLimit > 0) {
    lower = firstMatch.lower;
    for (let i = leading.length - 1; i >= 0; i--) {
      if (firstMatch.lower - leading[i].lower > leadingLimit) {
        break;
      }
      lower = leading[i].lower;
    }
  }
  let upper = range.upper;
  if (trailingLimit > 0) {
    upper = trailing.length > 0 ? trailing[trailing.length - 1].upper : lastMatch.upper;
    if (lastMatch.upper > upper) {
      upper = lastMatch.upper;
    }
  }
  return new TextRange(lower, upper);
}
