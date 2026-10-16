// Port of Hoextdown html.c / html.h (External/Hoextdown) — the HTML renderer and the TOC
// renderer — plus hash.c / hash.h, the header-id table the renderer owns. Pure logic, no UI.
//
// html_smartypants.c is not ported: nothing in the app calls hoedown_html_smartypants
// (SPMarkdownParser renders with the plain HTML renderer).
import {
  HoedownBuffer,
  NumberRef,
  hoedown_buffer_free,
  hoedown_buffer_new,
  hoedown_buffer_prefix,
  hoedown_buffer_put,
  hoedown_buffer_putc,
  hoedown_buffer_puts,
  hoedown_utf8_decode,
  hoedown_utf8_encode,
  isAlnum,
  isAscii,
  isSpace,
  memeqAt,
  strncasecmpAt,
  strncmpAt,
  toLower
} from './Buffer';
import { hoedown_escape_href, hoedown_escape_html } from './Escape';
import {
  HOEDOWN_AUTOLINK_EMAIL,
  HOEDOWN_EXT_AUTOLINK,
  HOEDOWN_EXT_FENCED_CODE,
  HOEDOWN_EXT_FOOTNOTES,
  HOEDOWN_EXT_TABLES,
  HOEDOWN_LI_BLOCK,
  HOEDOWN_LI_DD,
  HOEDOWN_LI_DT,
  HOEDOWN_LI_TASK,
  HOEDOWN_LIST_DEFINITION,
  HOEDOWN_LIST_ORDERED,
  HOEDOWN_TABLE_ALIGN_CENTER,
  HOEDOWN_TABLE_ALIGN_LEFT,
  HOEDOWN_TABLE_ALIGN_RIGHT,
  HOEDOWN_TABLE_ALIGNMASK,
  HOEDOWN_TABLE_HEADER,
  HoedownDocument,
  HoedownRenderer,
  HoedownRendererData,
  hoedown_document_free,
  hoedown_document_new,
  hoedown_document_render
} from './Document';

/*************
 * CONSTANTS *
 *************/

/* hoedown_html_flags */
export const HOEDOWN_HTML_SKIP_HTML: number = (1 << 0);
export const HOEDOWN_HTML_ESCAPE: number = (1 << 1);
export const HOEDOWN_HTML_HARD_WRAP: number = (1 << 2);
export const HOEDOWN_HTML_USE_XHTML: number = (1 << 3);
export const HOEDOWN_HTML_USE_TASK_LIST: number = (1 << 4);
export const HOEDOWN_HTML_LINE_CONTINUE: number = (1 << 5);
export const HOEDOWN_HTML_HEADER_ID: number = (1 << 6);
export const HOEDOWN_HTML_FENCED_CODE_SCRIPT: number = (1 << 7);

/* hoedown_html_tag */
export const HOEDOWN_HTML_TAG_NONE: number = 0;
export const HOEDOWN_HTML_TAG_OPEN: number = 1;
export const HOEDOWN_HTML_TAG_CLOSE: number = 2;

/************************
 * hash.c — header ids  *
 ************************/

const HOEDOWN_HASH_ITEM_SIZE: number = 255;
const HOEDOWN_HASH_FNV_PRIME: number = 0x01000193;
const HOEDOWN_HASH_FNV_OFFSET_BASIS: number = 0x811c9dc5;

export class HoedownHashItem {
  key: Uint8Array | null = null;
  value: NumberRef | null = null;
  next: HoedownHashItem | null = null;
  tail: HoedownHashItem | null = null;
}

export class HoedownHash {
  items: (HoedownHashItem | null)[] = [];
  asize: number = 0;
}

/* FNV hash over key[offset .. offset+len); `char` is signed on Apple targets, so bytes >= 0x80 sign-extend */
function hoedown_hash_fnv(key: Uint8Array, offset: number, len: number, limit: number): number {
  let hash: number = HOEDOWN_HASH_FNV_OFFSET_BASIS;

  for (let k = 0; k < len; k++) {
    const b: number = key[offset + k];
    const c: number = b >= 0x80 ? b - 256 : b;
    hash = Math.imul(hash, HOEDOWN_HASH_FNV_PRIME) >>> 0;
    hash = (hash ^ c) >>> 0;
  }

  return hash % limit;
}

/* strndup(key, n), or strdup(key) when n is 0 (stops at the first NUL, as C does) */
function hoedown_hash_keydup(key: Uint8Array, offset: number, key_len: number): Uint8Array {
  let n: number = key_len;
  if (n === 0) {
    while (offset + n < key.length && key[offset + n] !== 0) {
      n++;
    }
  }
  return key.slice(offset, offset + n);
}

function hoedown_hash_item_push(item: HoedownHashItem, key: Uint8Array, offset: number, key_len: number,
  value: NumberRef): boolean {
  let entry: HoedownHashItem;

  if (item.key !== null) {
    entry = new HoedownHashItem();
  } else {
    entry = item;
  }

  entry.key = hoedown_hash_keydup(key, offset, key_len);
  entry.value = value;

  const tail: HoedownHashItem | null = item.tail;
  if (tail !== null) {
    tail.next = entry;
  } else if (item !== entry) {
    item.next = entry;
  }
  item.tail = entry;

  return true;
}

export function hoedown_hash_new(size: number): HoedownHash {
  const hash: HoedownHash = new HoedownHash();
  const n: number = size === 0 ? HOEDOWN_HASH_ITEM_SIZE : size;
  for (let i = 0; i < n; i++) {
    hash.items.push(null);
  }
  hash.asize = n;
  return hash;
}

export function hoedown_hash_free(hash: HoedownHash | null): void {
  if (hash !== null) {
    hash.items = [];
    hash.asize = 0;
  }
}

export function hoedown_hash_add(hash: HoedownHash, key: Uint8Array, offset: number, key_len: number,
  value: NumberRef): boolean {
  const h: number = hoedown_hash_fnv(key, offset, key_len, hash.asize);

  let bucket: HoedownHashItem | null = hash.items[h];
  if (bucket === null) {
    bucket = new HoedownHashItem();
    hash.items[h] = bucket;
  }

  return hoedown_hash_item_push(bucket, key, offset, key_len, value);
}

/* strncmp(item->key, key, key_len) == 0 */
function hash_key_matches(itemKey: Uint8Array, key: Uint8Array, offset: number, key_len: number): boolean {
  for (let k = 0; k < key_len; k++) {
    const c1: number = k < itemKey.length ? itemKey[k] : 0;
    const c2: number = key[offset + k];
    if (c1 !== c2) {
      return false;
    }
    if (c1 === 0) {
      return true;
    }
  }
  return true;
}

export function hoedown_hash_find(hash: HoedownHash, key: Uint8Array, offset: number, key_len: number): NumberRef | null {
  const h: number = hoedown_hash_fnv(key, offset, key_len, hash.asize);

  let item: HoedownHashItem | null = hash.items[h];
  while (item !== null) {
    const itemKey: Uint8Array | null = item.key;
    if (itemKey !== null && hash_key_matches(itemKey, key, offset, key_len)) {
      return item.value;
    }
    item = item.next;
  }

  return null;
}

/*********
 * TYPES *
 *********/

export type HoedownLinkAttributesCallback = (ob: HoedownBuffer, url: HoedownBuffer | null,
  data: HoedownRendererData) => void;

export class HoedownHtmlTocData {
  header_count: number = 0;
  current_level: number = 0;
  level_offset: number = 0;
  nesting_level: number = 0;
  header: string | null = null;
  footer: string | null = null;
}

export class HoedownHtmlHashes {
  header_id: HoedownHash | null = null;
}

export class HoedownHtmlRendererState {
  opaque: Object | null = null;
  toc_data: HoedownHtmlTocData = new HoedownHtmlTocData();
  hash: HoedownHtmlHashes = new HoedownHtmlHashes();
  flags: number = 0;
  /* extra callbacks */
  link_attributes: HoedownLinkAttributesCallback | null = null;
}

function stateOf(data: HoedownRendererData): HoedownHtmlRendererState {
  return data.opaque as HoedownHtmlRendererState;
}

function USE_XHTML(opt: HoedownHtmlRendererState): boolean {
  return (opt.flags & HOEDOWN_HTML_USE_XHTML) !== 0;
}

function USE_TASK_LIST(opt: HoedownHtmlRendererState): boolean {
  return (opt.flags & HOEDOWN_HTML_USE_TASK_LIST) !== 0;
}

/* hoedown_html_is_tag: checks if data starts with a specific tag, returns the tag type or NONE */
export function hoedown_html_is_tag(data: Uint8Array, base: number, size: number, tagname: string): number {
  let i: number = 0;
  let t: number = 0;
  let closed: boolean = false;

  if (size < 3 || data[base] !== 0x3c) { /* '<' */
    return HOEDOWN_HTML_TAG_NONE;
  }

  i = 1;

  if (data[base + i] === 0x2f) { /* '/' */
    closed = true;
    i++;
  }

  for (; i < size; ++i, ++t) {
    if (t >= tagname.length) {
      break;
    }

    if (data[base + i] !== tagname.charCodeAt(t)) {
      return HOEDOWN_HTML_TAG_NONE;
    }
  }

  if (i === size) {
    return HOEDOWN_HTML_TAG_NONE;
  }

  if (isSpace(data[base + i]) || data[base + i] === 0x3e) { /* '>' */
    return closed ? HOEDOWN_HTML_TAG_CLOSE : HOEDOWN_HTML_TAG_OPEN;
  }

  return HOEDOWN_HTML_TAG_NONE;
}

function escape_html(ob: HoedownBuffer, source: Uint8Array, offset: number, length: number): void {
  hoedown_escape_html(ob, source, offset, length, false);
}

function escape_href(ob: HoedownBuffer, source: Uint8Array, offset: number, length: number): void {
  hoedown_escape_href(ob, source, offset, length);
}

/********************
 * GENERIC RENDERER *
 ********************/

function rndr_attributes(ob: HoedownBuffer, buf: Uint8Array, size: number, classBuf: HoedownBuffer | null,
  data: HoedownRendererData): boolean {
  /* i keeps track of how much we've parsed so far. */
  let i: number = 0;
  let rendered_id: boolean = false;
  let klass: HoedownBuffer | null = classBuf;

  while (i < size) {
    /* An attribute can come in a variety of shapes:
     * - #id, where "id" is a sequence of non-space characters
     * - .cls, where  "cls" is a sequence of non-space characters
     * - key=val, where "key" and "val" are sequences of non-space characters
     * - key="quoted val", where "quoted val" may not contain a quote.
     * We look for each case and set the key and val variables. We ignore text
     * that does not match the patterns above (e.g., single words).
     * */
    let is_id: boolean = false;
    let is_class: boolean = false;
    let key_start: number = 0;
    let key_end: number = 0;
    let val_start: number = 0;
    let val_end: number = 0;

    /* Skip to the first non-space character */
    while (i < size && buf[i] === 0x20) {
      ++i;
    }
    if (i >= size) {
      break;
    }

    if (buf[i] === 0x23) { /* '#' */
      /* #id */
      is_id = true;
      ++i;
    } else if (buf[i] === 0x2e) { /* '.' */
      /* .cls */
      is_class = true;
      ++i;
    }
    if (is_id || is_class) {
      val_start = i;
      for (val_end = val_start; val_end < size && buf[val_end] !== 0x20; ++val_end) {
        /* empty */
      }
      i = val_end;
    } else {
      /* key=... */
      key_start = i;
      for (key_end = key_start; key_end < size && buf[key_end] !== 0x20 && buf[key_end] !== 0x3d; ++key_end) {
        /* empty */
      }
      i = key_end;
      if (i >= size) {
        break;
      }
      ++i;
      if (buf[key_end] !== 0x3d) { /* '=' */
        continue;
      }
      if (strncasecmpAt(buf, key_start, 'id', key_end - key_start) === 0) {
        is_id = true;
      } else if (strncasecmpAt(buf, key_start, 'class', key_end - key_start) === 0) {
        is_class = true;
      }

      val_start = i;
      if (val_start < size && (buf[val_start] === 0x22 || buf[val_start] === 0x27)) {
        /* key="quoted val" */
        val_start += 1;
        for (val_end = val_start; val_end < size && buf[val_end] !== buf[val_start - 1]; ++val_end) {
          /* empty */
        }
        i = val_end;
        if (i >= size) {
          break;
        }
        ++i;
      } else {
        /* key=val */
        for (val_end = val_start; val_end < size && buf[val_end] !== 0x20; ++val_end) {
          /* empty */
        }
        i = val_end;
      }
    }

    /* Now that we found our keys and values, let's render the attribute. */
    if (is_id) {
      if (rendered_id) {
        continue;
      }
      if (val_end === val_start) {
        continue;
      }
      rendered_id = true;
      hoedown_buffer_puts(ob, ' id="');
      escape_html(ob, buf, val_start, val_end - val_start);
      hoedown_buffer_putc(ob, 0x22);
    } else if (is_class) {
      if (val_end === val_start) {
        continue;
      }
      if (klass === null) {
        klass = hoedown_buffer_new(size);
      }
      escape_html(klass, buf, val_start, val_end - val_start);
      hoedown_buffer_putc(klass, 0x20);
    } else {
      if (key_end === key_start) {
        continue;
      }
      hoedown_buffer_putc(ob, 0x20);
      escape_html(ob, buf, key_start, key_end - key_start);
      hoedown_buffer_puts(ob, '="');
      escape_html(ob, buf, val_start, val_end - val_start);
      hoedown_buffer_putc(ob, 0x22);
    }
  }

  if (klass !== null) {
    if (klass.size > 0) {
      hoedown_buffer_puts(ob, ' class="');
      hoedown_buffer_put(ob, klass.data, 0, klass.size - 1);
      hoedown_buffer_putc(ob, 0x22);
    }
  }
  return true;
}

function rndr_autolink(ob: HoedownBuffer, link: HoedownBuffer | null, type: number,
  data: HoedownRendererData): boolean {
  const state: HoedownHtmlRendererState = stateOf(data);

  if (link === null || link.size === 0) {
    return false;
  }

  hoedown_buffer_puts(ob, '<a href="');
  if (type === HOEDOWN_AUTOLINK_EMAIL) {
    hoedown_buffer_puts(ob, 'mailto:');
  }
  escape_href(ob, link.data, 0, link.size);

  const link_attributes: HoedownLinkAttributesCallback | null = state.link_attributes;
  if (link_attributes !== null) {
    hoedown_buffer_putc(ob, 0x22);
    link_attributes(ob, link, data);
    hoedown_buffer_putc(ob, 0x3e);
  } else {
    hoedown_buffer_puts(ob, '">');
  }

  /*
   * Pretty printing: if we get an email address as
   * an actual URI, e.g. `mailto:foo@bar.com`, we don't
   * want to print the `mailto:` prefix
   */
  if (hoedown_buffer_prefix(link, 'mailto:') === 0) {
    escape_html(ob, link.data, 7, link.size - 7);
  } else {
    escape_html(ob, link.data, 0, link.size);
  }

  hoedown_buffer_puts(ob, '</a>');

  return true;
}

function rndr_blockcode(ob: HoedownBuffer, text: HoedownBuffer | null, lang: HoedownBuffer | null,
  attr: HoedownBuffer | null, data: HoedownRendererData): void {
  if (ob.size > 0) {
    hoedown_buffer_putc(ob, 0x0a);
  }

  if (lang !== null) {
    const state: HoedownHtmlRendererState = stateOf(data);
    if ((state.flags & HOEDOWN_HTML_FENCED_CODE_SCRIPT) !== 0 &&
      lang.size > 7 && memeqAt(lang.data, 0, 'script@') && text !== null) {
      hoedown_buffer_puts(ob, '<script type="');
      escape_html(ob, lang.data, 7, lang.size - 7);
      hoedown_buffer_puts(ob, '">\n');
      hoedown_buffer_put(ob, text.data, 0, text.size);
      hoedown_buffer_puts(ob, '</script>\n');
      return;
    }
    hoedown_buffer_puts(ob, '<pre><code');
    if (attr !== null && attr.size > 0) {
      const lang_class: HoedownBuffer = hoedown_buffer_new(lang.size + 9);
      if (lang.size > 0) {
        hoedown_buffer_puts(lang_class, 'language-');
        escape_html(lang_class, lang.data, 0, lang.size);
        if (lang_class.data[lang_class.size - 1] !== 0x20) {
          hoedown_buffer_putc(lang_class, 0x20);
        }
      }
      rndr_attributes(ob, attr.data, attr.size, lang_class, data);
      hoedown_buffer_free(lang_class);
    } else {
      hoedown_buffer_puts(ob, ' class="language-');
      escape_html(ob, lang.data, 0, lang.size);
      hoedown_buffer_putc(ob, 0x22);
    }
    hoedown_buffer_putc(ob, 0x3e);
  } else if (attr !== null && attr.size > 0) {
    hoedown_buffer_puts(ob, '<pre><code');
    rndr_attributes(ob, attr.data, attr.size, null, data);
    hoedown_buffer_putc(ob, 0x3e);
  } else {
    hoedown_buffer_puts(ob, '<pre><code>');
  }

  if (text !== null) {
    escape_html(ob, text.data, 0, text.size);
  }

  hoedown_buffer_puts(ob, '</code></pre>\n');
}

function rndr_blockquote(ob: HoedownBuffer, content: HoedownBuffer | null, data: HoedownRendererData): void {
  if (ob.size > 0) {
    hoedown_buffer_putc(ob, 0x0a);
  }
  hoedown_buffer_puts(ob, '<blockquote>\n');
  if (content !== null) {
    hoedown_buffer_put(ob, content.data, 0, content.size);
  }
  hoedown_buffer_puts(ob, '</blockquote>\n');
}

function rndr_codespan(ob: HoedownBuffer, text: HoedownBuffer | null, attr: HoedownBuffer | null,
  data: HoedownRendererData): boolean {
  hoedown_buffer_puts(ob, '<code');
  if (attr !== null && attr.size > 0) {
    rndr_attributes(ob, attr.data, attr.size, null, data);
  }
  hoedown_buffer_putc(ob, 0x3e);
  if (text !== null) {
    escape_html(ob, text.data, 0, text.size);
  }
  hoedown_buffer_puts(ob, '</code>');
  return true;
}

/* the span renderers that wrap non-empty content in one tag pair */
function rndr_wrapped(ob: HoedownBuffer, content: HoedownBuffer | null, open: string, close: string): boolean {
  if (content === null || content.size === 0) {
    return false;
  }

  hoedown_buffer_puts(ob, open);
  hoedown_buffer_put(ob, content.data, 0, content.size);
  hoedown_buffer_puts(ob, close);
  return true;
}

function rndr_strikethrough(ob: HoedownBuffer, content: HoedownBuffer | null, data: HoedownRendererData): boolean {
  return rndr_wrapped(ob, content, '<del>', '</del>');
}

function rndr_double_emphasis(ob: HoedownBuffer, content: HoedownBuffer | null, data: HoedownRendererData): boolean {
  return rndr_wrapped(ob, content, '<strong>', '</strong>');
}

function rndr_emphasis(ob: HoedownBuffer, content: HoedownBuffer | null, data: HoedownRendererData): boolean {
  return rndr_wrapped(ob, content, '<em>', '</em>');
}

function rndr_underline(ob: HoedownBuffer, content: HoedownBuffer | null, data: HoedownRendererData): boolean {
  return rndr_wrapped(ob, content, '<u>', '</u>');
}

function rndr_highlight(ob: HoedownBuffer, content: HoedownBuffer | null, data: HoedownRendererData): boolean {
  return rndr_wrapped(ob, content, '<mark>', '</mark>');
}

function rndr_quote(ob: HoedownBuffer, content: HoedownBuffer | null, data: HoedownRendererData): boolean {
  return rndr_wrapped(ob, content, '<q>', '</q>');
}

function rndr_linebreak(ob: HoedownBuffer, data: HoedownRendererData): boolean {
  const state: HoedownHtmlRendererState = stateOf(data);
  hoedown_buffer_puts(ob, USE_XHTML(state) ? '<br/>\n' : '<br>\n');
  return true;
}

function hex2(b: number): string {
  const hex: string = '0123456789ABCDEF';
  return hex.charAt((b >> 4) & 0xf) + hex.charAt(b & 0xf);
}

function rndr_header_id(ob: HoedownBuffer, source: Uint8Array, length: number, escape: boolean,
  data: HoedownRendererData): void {
  let i: number = 0;
  let n: number = 0;
  const state: HoedownHtmlRendererState = stateOf(data);
  const hash: HoedownHash | null = state.hash.header_id;

  while (i < length) {
    const c: number = source[i];
    if (isAlnum(c)) {
      hoedown_buffer_putc(ob, toLower(c));
    } else if (c === 0x20) {
      hoedown_buffer_putc(ob, 0x2d); /* '-' */
    } else if (c === 0x2d || c === 0x5f) {
      hoedown_buffer_putc(ob, c);
    } else if (!isAscii(c)) {
      if (escape) {
        hoedown_buffer_puts(ob, '%' + hex2(c));
      } else {
        hoedown_buffer_putc(ob, c);
      }
    } else if (c === 0x26) { /* '&' */
      while (i < length && source[i] !== 0x3b) {
        ++i;
      }
    } else if (c === 0x3c) { /* '<' */
      while (i < length && source[i] !== 0x3e) {
        ++i;
      }
    }
    ++i;
  }

  if (hash !== null) {
    const value: NumberRef | null = hoedown_hash_find(hash, source, 0, length);
    if (value !== null) {
      ++value.value;
      n = value.value;
    }
    if (n > 0) {
      hoedown_buffer_puts(ob, `-${n}`);
    } else {
      hoedown_hash_add(hash, source, 0, length, new NumberRef(0));
    }
  }
}

function rndr_header(ob: HoedownBuffer, content: HoedownBuffer | null, attr: HoedownBuffer | null, level: number,
  data: HoedownRendererData): void {
  const state: HoedownHtmlRendererState = stateOf(data);

  if (ob.size > 0) {
    hoedown_buffer_putc(ob, 0x0a);
  }

  const merged_attr: HoedownBuffer = hoedown_buffer_new(64);

  if (attr !== null && attr.size > 0) {
    hoedown_buffer_put(merged_attr, attr.data, 0, attr.size);
  }
  if (content !== null && content.size > 0 &&
    ((state.flags & HOEDOWN_HTML_HEADER_ID) !== 0 || (level <= state.toc_data.nesting_level))) {
    hoedown_buffer_puts(merged_attr, ' #');
    rndr_header_id(merged_attr, content.data, content.size, false, data);
  }

  if (merged_attr.size > 0) {
    hoedown_buffer_puts(ob, `<h${level}`);
    rndr_attributes(ob, merged_attr.data, merged_attr.size, null, data);
    hoedown_buffer_putc(ob, 0x3e);
  } else {
    hoedown_buffer_puts(ob, `<h${level}>`);
  }

  hoedown_buffer_free(merged_attr);

  if (content !== null) {
    hoedown_buffer_put(ob, content.data, 0, content.size);
  }
  hoedown_buffer_puts(ob, `</h${level}>\n`);
}

function rndr_link(ob: HoedownBuffer, content: HoedownBuffer | null, link: HoedownBuffer | null,
  title: HoedownBuffer | null, attr: HoedownBuffer | null, data: HoedownRendererData): boolean {
  const state: HoedownHtmlRendererState = stateOf(data);

  hoedown_buffer_puts(ob, '<a href="');

  if (link !== null && link.size > 0) {
    escape_href(ob, link.data, 0, link.size);
  }

  if (title !== null && title.size > 0) {
    hoedown_buffer_puts(ob, '" title="');
    escape_html(ob, title.data, 0, title.size);
  }

  hoedown_buffer_putc(ob, 0x22);
  const link_attributes: HoedownLinkAttributesCallback | null = state.link_attributes;
  if (link_attributes !== null) {
    link_attributes(ob, link, data);
  }
  if (attr !== null && attr.size > 0) {
    rndr_attributes(ob, attr.data, attr.size, null, data);
  }
  hoedown_buffer_putc(ob, 0x3e);

  if (content !== null && content.size > 0) {
    hoedown_buffer_put(ob, content.data, 0, content.size);
  }
  hoedown_buffer_puts(ob, '</a>');
  return true;
}

function rndr_list(ob: HoedownBuffer, content: HoedownBuffer | null, attr: HoedownBuffer | null, flags: number,
  data: HoedownRendererData): void {
  if (ob.size > 0) {
    hoedown_buffer_putc(ob, 0x0a);
  }

  if ((flags & HOEDOWN_LIST_ORDERED) !== 0) {
    hoedown_buffer_puts(ob, '<ol');
  } else if ((flags & HOEDOWN_LIST_DEFINITION) !== 0) {
    hoedown_buffer_puts(ob, '<dl');
  } else {
    if ((flags & HOEDOWN_LI_TASK) !== 0) {
      hoedown_buffer_puts(ob, '<ul class="task-list"');
    } else {
      hoedown_buffer_puts(ob, '<ul');
    }
  }
  if (attr !== null && attr.size > 0) {
    rndr_attributes(ob, attr.data, attr.size, null, data);
  }

  hoedown_buffer_puts(ob, '>\n');

  if (content !== null) {
    hoedown_buffer_put(ob, content.data, 0, content.size);
  }

  if ((flags & HOEDOWN_LIST_ORDERED) !== 0) {
    hoedown_buffer_puts(ob, '</ol>\n');
  } else if ((flags & HOEDOWN_LIST_DEFINITION) !== 0) {
    hoedown_buffer_puts(ob, '</dl>\n');
  } else {
    hoedown_buffer_puts(ob, '</ul>\n');
  }
}

function rndr_listitem(ob: HoedownBuffer, content: HoedownBuffer | null, attr: HoedownBuffer | null,
  flags: NumberRef, data: HoedownRendererData): void {
  if (content !== null) {
    const state: HoedownHtmlRendererState = stateOf(data);
    let prefix: number = 0;
    let size: number = content.size;
    let is_li_tag: boolean = false;
    while (size > 0 && content.data[size - 1] === 0x0a) {
      size -= 1;
    }

    if ((flags.value & HOEDOWN_LI_DD) !== 0) {
      hoedown_buffer_puts(ob, '<dd');
    } else if ((flags.value & HOEDOWN_LI_DT) !== 0) {
      hoedown_buffer_puts(ob, '<dt');
    } else {
      hoedown_buffer_puts(ob, '<li');
      is_li_tag = true;
    }

    if (attr !== null && attr.size > 0) {
      rndr_attributes(ob, attr.data, attr.size, null, data);
    }
    hoedown_buffer_putc(ob, 0x3e);

    if (USE_TASK_LIST(state) && is_li_tag && size >= 3) {
      /* Block list items are wrapped in <p> tags. Output the opening tag now,
       * then check for a task list. */
      if ((flags.value & HOEDOWN_LI_BLOCK) !== 0) {
        prefix = 3;
        hoedown_buffer_put(ob, content.data, 0, prefix);
      }
      if (size >= prefix + 3) {
        if (strncmpAt(content.data, prefix, '[ ]', 3) === 0) {
          hoedown_buffer_puts(ob, '<input type="checkbox"');
          hoedown_buffer_puts(ob, USE_XHTML(state) ? '/>' : '>');
          prefix += 3;
          flags.value |= HOEDOWN_LI_TASK;
        } else if (strncasecmpAt(content.data, prefix, '[x]', 3) === 0) {
          hoedown_buffer_puts(ob, '<input checked="" type="checkbox"');
          hoedown_buffer_puts(ob, USE_XHTML(state) ? '/>' : '>');
          prefix += 3;
          flags.value |= HOEDOWN_LI_TASK;
        }
      }
    }

    hoedown_buffer_put(ob, content.data, prefix, size - prefix);
  } else {
    if ((flags.value & HOEDOWN_LI_DD) !== 0) {
      hoedown_buffer_puts(ob, '<dd>');
    } else if ((flags.value & HOEDOWN_LI_DT) !== 0) {
      hoedown_buffer_puts(ob, '<dt>');
    } else {
      hoedown_buffer_puts(ob, '<li>');
    }
  }
  if ((flags.value & HOEDOWN_LI_DD) !== 0) {
    hoedown_buffer_puts(ob, '</dd>\n');
  } else if ((flags.value & HOEDOWN_LI_DT) !== 0) {
    hoedown_buffer_puts(ob, '</dt>\n');
  } else {
    hoedown_buffer_puts(ob, '</li>\n');
  }
}

function rndr_paragraph(ob: HoedownBuffer, content: HoedownBuffer | null, attr: HoedownBuffer | null,
  data: HoedownRendererData): void {
  const state: HoedownHtmlRendererState = stateOf(data);
  let i: number = 0;

  if (ob.size > 0) {
    hoedown_buffer_putc(ob, 0x0a);
  }

  if (content === null || content.size === 0) {
    return;
  }

  while (i < content.size && isSpace(content.data[i])) {
    i++;
  }

  if (i === content.size) {
    return;
  }

  hoedown_buffer_puts(ob, '<p');

  if (attr !== null && attr.size > 0) {
    rndr_attributes(ob, attr.data, attr.size, null, data);
  }

  hoedown_buffer_puts(ob, '>');

  if ((state.flags & HOEDOWN_HTML_HARD_WRAP) !== 0) {
    let org: number = 0;
    while (i < content.size) {
      org = i;
      while (i < content.size && content.data[i] !== 0x0a) {
        i++;
      }

      if (i > org) {
        hoedown_buffer_put(ob, content.data, org, i - org);
      }

      /*
       * do not insert a line break if this newline
       * is the last character on the paragraph
       */
      if (i >= content.size - 1) {
        break;
      }

      rndr_linebreak(ob, data);
      i++;
    }
  } else if ((state.flags & HOEDOWN_HTML_LINE_CONTINUE) !== 0) {
    let org: number = 0;
    while (i < content.size) {
      org = i;
      while (i < content.size && content.data[i] !== 0x0a) {
        ++i;
      }
      if (i > org) {
        hoedown_buffer_put(ob, content.data, org, i - org);
      }

      if (i >= content.size - 1) {
        break;
      }

      if (content.data[i] === 0x0a &&
        (isAscii(content.data[i - 1]) || isAscii(content.data[i + 1]))) {
        if (i < 5 ||
          strncmpAt(content.data, i - 5, '<br/>', 5) !== 0 ||
          strncmpAt(content.data, i - 4, '<br>', 4) !== 0) {
          hoedown_buffer_puts(ob, ' ');
        }
      }
      ++i;
    }
  } else {
    hoedown_buffer_put(ob, content.data, i, content.size - i);
  }
  hoedown_buffer_puts(ob, '</p>\n');
}

function rndr_raw_block(ob: HoedownBuffer, text: HoedownBuffer | null, data: HoedownRendererData): void {
  let org: number = 0;
  let sz: number = 0;

  if (text === null) {
    return;
  }

  /* FIXME: Do we *really* need to trim the HTML? How does that make a difference? */
  sz = text.size;
  while (sz > 0 && text.data[sz - 1] === 0x0a) {
    sz--;
  }

  org = 0;
  while (org < sz && text.data[org] === 0x0a) {
    org++;
  }

  if (org >= sz) {
    return;
  }

  if (ob.size > 0) {
    hoedown_buffer_putc(ob, 0x0a);
  }

  hoedown_buffer_put(ob, text.data, org, sz - org);
  hoedown_buffer_putc(ob, 0x0a);
}

function rndr_triple_emphasis(ob: HoedownBuffer, content: HoedownBuffer | null, data: HoedownRendererData): boolean {
  return rndr_wrapped(ob, content, '<strong><em>', '</em></strong>');
}

function rndr_hrule(ob: HoedownBuffer, data: HoedownRendererData): void {
  const state: HoedownHtmlRendererState = stateOf(data);
  if (ob.size > 0) {
    hoedown_buffer_putc(ob, 0x0a);
  }
  hoedown_buffer_puts(ob, USE_XHTML(state) ? '<hr/>\n' : '<hr>\n');
}

function rndr_image(ob: HoedownBuffer, link: HoedownBuffer | null, title: HoedownBuffer | null,
  alt: HoedownBuffer | null, attr: HoedownBuffer | null, data: HoedownRendererData): boolean {
  const state: HoedownHtmlRendererState = stateOf(data);
  if (link === null || link.size === 0) {
    return false;
  }

  hoedown_buffer_puts(ob, '<img src="');
  escape_href(ob, link.data, 0, link.size);
  hoedown_buffer_puts(ob, '" alt="');

  if (alt !== null && alt.size > 0) {
    escape_html(ob, alt.data, 0, alt.size);
  }

  if (title !== null && title.size > 0) {
    hoedown_buffer_puts(ob, '" title="');
    escape_html(ob, title.data, 0, title.size);
  }

  hoedown_buffer_putc(ob, 0x22);
  if (attr !== null && attr.size > 0) {
    rndr_attributes(ob, attr.data, attr.size, null, data);
  }

  hoedown_buffer_puts(ob, USE_XHTML(state) ? '/>' : '>');
  return true;
}

function rndr_raw_html(ob: HoedownBuffer, text: HoedownBuffer | null, data: HoedownRendererData): boolean {
  const state: HoedownHtmlRendererState = stateOf(data);
  if (text === null) {
    return false;
  }

  /* ESCAPE overrides SKIP_HTML. It doesn't look to see if
   * there are any valid tags, just escapes all of them. */
  if ((state.flags & HOEDOWN_HTML_ESCAPE) !== 0) {
    escape_html(ob, text.data, 0, text.size);
    return true;
  }

  if ((state.flags & HOEDOWN_HTML_SKIP_HTML) !== 0) {
    return true;
  }

  hoedown_buffer_put(ob, text.data, 0, text.size);
  return true;
}

function rndr_table(ob: HoedownBuffer, content: HoedownBuffer | null, attr: HoedownBuffer | null,
  data: HoedownRendererData): void {
  if (ob.size > 0) {
    hoedown_buffer_putc(ob, 0x0a);
  }
  hoedown_buffer_puts(ob, '<table');
  if (attr !== null) {
    rndr_attributes(ob, attr.data, attr.size, null, data);
  }
  hoedown_buffer_puts(ob, '>\n');
  if (content !== null) {
    hoedown_buffer_put(ob, content.data, 0, content.size);
  }
  hoedown_buffer_puts(ob, '</table>\n');
}

function rndr_table_header(ob: HoedownBuffer, content: HoedownBuffer | null, data: HoedownRendererData): void {
  if (ob.size > 0) {
    hoedown_buffer_putc(ob, 0x0a);
  }
  hoedown_buffer_puts(ob, '<thead>\n');
  if (content !== null) {
    hoedown_buffer_put(ob, content.data, 0, content.size);
  }
  hoedown_buffer_puts(ob, '</thead>\n');
}

function rndr_table_body(ob: HoedownBuffer, content: HoedownBuffer | null, data: HoedownRendererData): void {
  if (ob.size > 0) {
    hoedown_buffer_putc(ob, 0x0a);
  }
  hoedown_buffer_puts(ob, '<tbody>\n');
  if (content !== null) {
    hoedown_buffer_put(ob, content.data, 0, content.size);
  }
  hoedown_buffer_puts(ob, '</tbody>\n');
}

function rndr_tablerow(ob: HoedownBuffer, content: HoedownBuffer | null, data: HoedownRendererData): void {
  hoedown_buffer_puts(ob, '<tr>\n');
  if (content !== null) {
    hoedown_buffer_put(ob, content.data, 0, content.size);
  }
  hoedown_buffer_puts(ob, '</tr>\n');
}

function rndr_tablecell(ob: HoedownBuffer, content: HoedownBuffer | null, flags: number,
  data: HoedownRendererData): void {
  if ((flags & HOEDOWN_TABLE_HEADER) !== 0) {
    hoedown_buffer_puts(ob, '<th');
  } else {
    hoedown_buffer_puts(ob, '<td');
  }

  switch (flags & HOEDOWN_TABLE_ALIGNMASK) {
    case HOEDOWN_TABLE_ALIGN_CENTER:
      hoedown_buffer_puts(ob, ' style="text-align: center">');
      break;

    case HOEDOWN_TABLE_ALIGN_LEFT:
      hoedown_buffer_puts(ob, ' style="text-align: left">');
      break;

    case HOEDOWN_TABLE_ALIGN_RIGHT:
      hoedown_buffer_puts(ob, ' style="text-align: right">');
      break;

    default:
      hoedown_buffer_puts(ob, '>');
  }

  if (content !== null) {
    hoedown_buffer_put(ob, content.data, 0, content.size);
  }

  if ((flags & HOEDOWN_TABLE_HEADER) !== 0) {
    hoedown_buffer_puts(ob, '</th>\n');
  } else {
    hoedown_buffer_puts(ob, '</td>\n');
  }
}

function rndr_superscript(ob: HoedownBuffer, content: HoedownBuffer | null, data: HoedownRendererData): boolean {
  return rndr_wrapped(ob, content, '<sup>', '</sup>');
}

function rndr_normal_text(ob: HoedownBuffer, content: HoedownBuffer | null, data: HoedownRendererData): void {
  if (content !== null) {
    escape_html(ob, content.data, 0, content.size);
  }
}

function rndr_footnotes(ob: HoedownBuffer, content: HoedownBuffer | null, data: HoedownRendererData): void {
  const state: HoedownHtmlRendererState = stateOf(data);

  if (ob.size > 0) {
    hoedown_buffer_putc(ob, 0x0a);
  }
  hoedown_buffer_puts(ob, '<div class="footnotes">\n');
  hoedown_buffer_puts(ob, USE_XHTML(state) ? '<hr/>\n' : '<hr>\n');
  hoedown_buffer_puts(ob, '<ol>\n');

  if (content !== null) {
    hoedown_buffer_put(ob, content.data, 0, content.size);
  }

  hoedown_buffer_puts(ob, '\n</ol>\n</div>\n');
}

function rndr_footnote_def(ob: HoedownBuffer, content: HoedownBuffer | null, num: number,
  data: HoedownRendererData): void {
  let i: number = 0;
  let pfound: boolean = false;

  /* insert anchor at the end of first paragraph block */
  if (content !== null) {
    const d: Uint8Array = content.data;
    while ((i + 3) < content.size) {
      if (d[i++] !== 0x3c) { /* '<' */
        continue;
      }
      if (d[i++] !== 0x2f) { /* '/' */
        continue;
      }
      if (d[i++] !== 0x70 && d[i] !== 0x50) { /* 'p' 'P' */
        continue;
      }
      if (d[i] !== 0x3e) { /* '>' */
        continue;
      }
      i -= 3;
      pfound = true;
      break;
    }
  }

  hoedown_buffer_puts(ob, `\n<li id="fn${num}">\n`);
  if (pfound && content !== null) {
    hoedown_buffer_put(ob, content.data, 0, i);
    hoedown_buffer_puts(ob, `&nbsp;<a href="#fnref${num}" rev="footnote">&#8617;</a>`);
    hoedown_buffer_put(ob, content.data, i, content.size - i);
  } else if (content !== null) {
    hoedown_buffer_put(ob, content.data, 0, content.size);
  }
  hoedown_buffer_puts(ob, '</li>\n');
}

function rndr_footnote_ref(ob: HoedownBuffer, num: number, data: HoedownRendererData): boolean {
  hoedown_buffer_puts(ob, `<sup id="fnref${num}"><a href="#fn${num}" rel="footnote">${num}</a></sup>`);
  return true;
}

function rndr_math(ob: HoedownBuffer, text: HoedownBuffer, displaymode: boolean, data: HoedownRendererData): boolean {
  hoedown_buffer_puts(ob, displaymode ? '\\[' : '\\(');
  escape_html(ob, text.data, 0, text.size);
  hoedown_buffer_puts(ob, displaymode ? '\\]' : '\\)');
  return true;
}

function toc_header(ob: HoedownBuffer, content: HoedownBuffer | null, attr: HoedownBuffer | null, level: number,
  data: HoedownRendererData): void {
  const state: HoedownHtmlRendererState = stateOf(data);

  if (level <= state.toc_data.nesting_level) {
    if (level < state.toc_data.level_offset) {
      state.toc_data.current_level++;
      return;
    }

    if (level > state.toc_data.current_level) {
      while (level > state.toc_data.current_level) {
        hoedown_buffer_puts(ob, '<ul>\n<li>\n');
        state.toc_data.current_level++;
      }
    } else if (level < state.toc_data.current_level) {
      hoedown_buffer_puts(ob, '</li>\n');
      while (level < state.toc_data.current_level) {
        hoedown_buffer_puts(ob, '</ul>\n</li>\n');
        state.toc_data.current_level--;
      }
      hoedown_buffer_puts(ob, '<li>\n');
    } else {
      hoedown_buffer_puts(ob, '</li>\n<li>\n');
    }

    if (attr !== null && attr.size > 0) {
      let n: number = 0;
      let i: number = 0;
      do {
        i++;
      } while (i < attr.size && attr.data[i - 1] !== 0x23); /* '#' */
      if (i < attr.size) {
        n = i;
        while (n < attr.size && attr.data[n] !== 0x23 &&
          attr.data[n] !== 0x2e && attr.data[n] !== 0x20) {
          n++;
        }
        hoedown_buffer_puts(ob, '<a href="#');
        escape_html(ob, attr.data, i, n - i);
        hoedown_buffer_puts(ob, '">');
      }
    } else if (content !== null) {
      hoedown_buffer_puts(ob, '<a href="#');
      rndr_header_id(ob, content.data, content.size, true, data);
      hoedown_buffer_puts(ob, '">');
    }

    if (content !== null) {
      hoedown_buffer_put(ob, content.data, 0, content.size);
    }
    hoedown_buffer_puts(ob, '</a>\n');
  }
}

function toc_link(ob: HoedownBuffer, content: HoedownBuffer | null, link: HoedownBuffer | null,
  title: HoedownBuffer | null, attr: HoedownBuffer | null, data: HoedownRendererData): boolean {
  if (content !== null && content.size > 0) {
    hoedown_buffer_put(ob, content.data, 0, content.size);
  }
  return true;
}

function toc_initialize(ob: HoedownBuffer, inline_render: boolean, data: HoedownRendererData): void {
  const state: HoedownHtmlRendererState = stateOf(data);
  const header: string | null = state.toc_data.header;
  if (header !== null) {
    hoedown_buffer_puts(ob, header + '\n');
  }
}

function toc_finalize(ob: HoedownBuffer, inline_render: boolean, data: HoedownRendererData): void {
  if (inline_render) {
    return;
  }

  const state: HoedownHtmlRendererState = stateOf(data);

  while (state.toc_data.current_level > 0) {
    hoedown_buffer_puts(ob, '</li>\n</ul>\n');
    state.toc_data.current_level--;
    if (state.toc_data.current_level < state.toc_data.level_offset) {
      break;
    }
  }

  const footer: string | null = state.toc_data.footer;
  if (footer !== null) {
    hoedown_buffer_puts(ob, footer + '\n');
  }

  state.toc_data.header_count = 0;
}

/* hoedown_html_toc_renderer_new: like hoedown_html_renderer_new, but the returned renderer produces the Table of Contents */
export function hoedown_html_toc_renderer_new(nesting_level: number): HoedownRenderer {
  const renderer: HoedownRenderer = new HoedownRenderer();

  renderer.header = toc_header;

  renderer.codespan = rndr_codespan;
  renderer.double_emphasis = rndr_double_emphasis;
  renderer.emphasis = rndr_emphasis;
  renderer.underline = rndr_underline;
  renderer.highlight = rndr_highlight;
  renderer.quote = rndr_quote;
  renderer.link = toc_link;
  renderer.triple_emphasis = rndr_triple_emphasis;
  renderer.strikethrough = rndr_strikethrough;
  renderer.superscript = rndr_superscript;

  renderer.normal_text = rndr_normal_text;

  renderer.doc_header = toc_initialize;
  renderer.doc_footer = toc_finalize;

  /* Prepare the state pointer */
  const state: HoedownHtmlRendererState = new HoedownHtmlRendererState();
  state.toc_data.nesting_level = nesting_level;
  state.hash.header_id = hoedown_hash_new(0);

  renderer.opaque = state;
  return renderer;
}

/* hoedown_html_renderer_new: allocates a regular HTML renderer */
export function hoedown_html_renderer_new(render_flags: number, nesting_level: number): HoedownRenderer {
  const renderer: HoedownRenderer = new HoedownRenderer();

  renderer.blockcode = rndr_blockcode;
  renderer.blockquote = rndr_blockquote;
  renderer.header = rndr_header;
  renderer.hrule = rndr_hrule;
  renderer.list = rndr_list;
  renderer.listitem = rndr_listitem;
  renderer.paragraph = rndr_paragraph;
  renderer.table = rndr_table;
  renderer.table_header = rndr_table_header;
  renderer.table_body = rndr_table_body;
  renderer.table_row = rndr_tablerow;
  renderer.table_cell = rndr_tablecell;
  renderer.footnotes = rndr_footnotes;
  renderer.footnote_def = rndr_footnote_def;
  renderer.blockhtml = rndr_raw_block;

  renderer.autolink = rndr_autolink;
  renderer.codespan = rndr_codespan;
  renderer.double_emphasis = rndr_double_emphasis;
  renderer.emphasis = rndr_emphasis;
  renderer.underline = rndr_underline;
  renderer.highlight = rndr_highlight;
  renderer.quote = rndr_quote;
  renderer.image = rndr_image;
  renderer.linebreak = rndr_linebreak;
  renderer.link = rndr_link;
  renderer.triple_emphasis = rndr_triple_emphasis;
  renderer.strikethrough = rndr_strikethrough;
  renderer.superscript = rndr_superscript;
  renderer.footnote_ref = rndr_footnote_ref;
  renderer.math = rndr_math;
  renderer.raw_html = rndr_raw_html;

  renderer.normal_text = rndr_normal_text;

  /* Prepare the state pointer */
  const state: HoedownHtmlRendererState = new HoedownHtmlRendererState();
  state.flags = render_flags;
  state.toc_data.nesting_level = nesting_level;

  if ((render_flags & HOEDOWN_HTML_SKIP_HTML) !== 0 || (render_flags & HOEDOWN_HTML_ESCAPE) !== 0) {
    renderer.blockhtml = null;
  }

  state.hash.header_id = hoedown_hash_new(0);

  renderer.opaque = state;

  return renderer;
}

/* hoedown_html_renderer_free: deallocate an HTML renderer */
export function hoedown_html_renderer_free(renderer: HoedownRenderer): void {
  const opaque: Object | null = renderer.opaque;
  if (opaque !== null) {
    const state: HoedownHtmlRendererState = opaque as HoedownHtmlRendererState;
    hoedown_hash_free(state.hash.header_id);
    state.hash.header_id = null;
  }
  renderer.opaque = null;
}

/*
 * The exact pipeline SPMarkdownParser.renderHTMLFromMarkdownString runs, minus its CSS
 * header/footer (the app-level wrapper owns those):
 *   renderer = hoedown_html_renderer_new(HOEDOWN_HTML_SKIP_HTML | HOEDOWN_HTML_USE_TASK_LIST, 0)
 *   document = hoedown_document_new(renderer, AUTOLINK | FENCED_CODE | FOOTNOTES | TABLES, 16, 0, NULL, NULL)
 *   hoedown_document_render(document, html, utf8(markdown))
 */
export const SP_MARKDOWN_HTML_FLAGS: number = HOEDOWN_HTML_SKIP_HTML | HOEDOWN_HTML_USE_TASK_LIST;
export const SP_MARKDOWN_EXTENSIONS: number = HOEDOWN_EXT_AUTOLINK | HOEDOWN_EXT_FENCED_CODE |
  HOEDOWN_EXT_FOOTNOTES | HOEDOWN_EXT_TABLES;
export const SP_MARKDOWN_MAX_NESTING: number = 16;

export function hoedown_render_markdown_to_html(markdown: string, render_flags: number, extensions: number,
  max_nesting: number): string {
  const renderer: HoedownRenderer = hoedown_html_renderer_new(render_flags, 0);
  const document: HoedownDocument = hoedown_document_new(renderer, extensions, max_nesting, 0, null, null);
  const html: HoedownBuffer = hoedown_buffer_new(16);
  try {
    const markdownData: Uint8Array = hoedown_utf8_encode(markdown);
    hoedown_document_render(document, html, markdownData, markdownData.length);
    return hoedown_utf8_decode(html.data, 0, html.size);
  } finally {
    hoedown_buffer_free(html);
    hoedown_document_free(document);
    hoedown_html_renderer_free(renderer);
  }
}
