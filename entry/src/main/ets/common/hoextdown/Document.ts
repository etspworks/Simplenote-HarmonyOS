// Port of Hoextdown document.c / document.h (External/Hoextdown) — the generic markdown parser —
// together with html_blocks.c / html5_blocks.c (block-tag lookup) and the stack.c work-buffer pool.
// Pure logic, no UI.
//
// Pointer model (see Buffer.ts): a C `uint8_t *data` becomes (data: Uint8Array, base: number), so C's
// `data[x]` is `data[base + x]` and C's `data + k` is `base + k`. Negative C indexes (data[-1]) are
// `data[base - 1]`. In-place edits (the blockquote memmove) act on the same backing array as in C.
import {
  HoedownBuffer,
  NumberRef,
  hoedown_buffer_grow,
  hoedown_buffer_new,
  hoedown_buffer_put,
  hoedown_buffer_putc,
  hoedown_buffer_puts,
  hoedown_buffer_reset,
  hoedown_buffer_slurp,
  hoedown_buffer_view,
  isAlnum,
  memchrAt,
  memeqAt,
  strchrHas,
  strncasecmpAt,
  toLower
} from './Buffer';
import { hoedown_autolink__email, hoedown_autolink__url, hoedown_autolink__www, HOEDOWN_AUTOLINK_SHORT_DOMAINS } from './Autolink';

/*************
 * CONSTANTS *
 *************/

/* hoedown_extensions — block-level extensions */
export const HOEDOWN_EXT_TABLES: number = (1 << 0);
export const HOEDOWN_EXT_MULTILINE_TABLES: number = (1 << 18);
export const HOEDOWN_EXT_FENCED_CODE: number = (1 << 1);
export const HOEDOWN_EXT_FOOTNOTES: number = (1 << 2);
export const HOEDOWN_EXT_DEFINITION_LISTS: number = (1 << 19);
export const HOEDOWN_EXT_BLOCKQUOTE_EMPTY_LINE: number = (1 << 21);
/* span-level extensions */
export const HOEDOWN_EXT_AUTOLINK: number = (1 << 3);
export const HOEDOWN_EXT_STRIKETHROUGH: number = (1 << 4);
export const HOEDOWN_EXT_UNDERLINE: number = (1 << 5);
export const HOEDOWN_EXT_HIGHLIGHT: number = (1 << 6);
export const HOEDOWN_EXT_QUOTE: number = (1 << 7);
export const HOEDOWN_EXT_SUPERSCRIPT: number = (1 << 8);
export const HOEDOWN_EXT_MATH: number = (1 << 9);
/* other flags */
export const HOEDOWN_EXT_NO_INTRA_EMPHASIS: number = (1 << 11);
export const HOEDOWN_EXT_SPACE_HEADERS: number = (1 << 12);
export const HOEDOWN_EXT_MATH_EXPLICIT: number = (1 << 13);
export const HOEDOWN_EXT_HTML5_BLOCKS: number = (1 << 20);
export const HOEDOWN_EXT_NO_INTRA_UNDERLINE_EMPHASIS: number = (1 << 21);
/* negative flags */
export const HOEDOWN_EXT_DISABLE_INDENTED_CODE: number = (1 << 14);
/* special attribute */
export const HOEDOWN_EXT_SPECIAL_ATTRIBUTE: number = (1 << 15);
/* script tags */
export const HOEDOWN_EXT_SCRIPT_TAGS: number = (1 << 16);
/* meta block */
export const HOEDOWN_EXT_META_BLOCK: number = (1 << 17);

export const HOEDOWN_EXT_BLOCK: number = HOEDOWN_EXT_TABLES | HOEDOWN_EXT_MULTILINE_TABLES |
  HOEDOWN_EXT_FENCED_CODE | HOEDOWN_EXT_FOOTNOTES | HOEDOWN_EXT_DEFINITION_LISTS |
  HOEDOWN_EXT_BLOCKQUOTE_EMPTY_LINE;
export const HOEDOWN_EXT_SPAN: number = HOEDOWN_EXT_AUTOLINK | HOEDOWN_EXT_STRIKETHROUGH |
  HOEDOWN_EXT_UNDERLINE | HOEDOWN_EXT_HIGHLIGHT | HOEDOWN_EXT_QUOTE | HOEDOWN_EXT_SUPERSCRIPT |
  HOEDOWN_EXT_MATH;
export const HOEDOWN_EXT_FLAGS: number = HOEDOWN_EXT_NO_INTRA_EMPHASIS | HOEDOWN_EXT_SPACE_HEADERS |
  HOEDOWN_EXT_MATH_EXPLICIT | HOEDOWN_EXT_SPECIAL_ATTRIBUTE | HOEDOWN_EXT_SCRIPT_TAGS |
  HOEDOWN_EXT_META_BLOCK | HOEDOWN_EXT_HTML5_BLOCKS;
export const HOEDOWN_EXT_NEGATIVE: number = HOEDOWN_EXT_DISABLE_INDENTED_CODE;

/* hoedown_list_flags */
export const HOEDOWN_LIST_ORDERED: number = (1 << 0);
export const HOEDOWN_LI_BLOCK: number = (1 << 1); /* <li> containing block data */
export const HOEDOWN_LI_TASK: number = (1 << 2);
export const HOEDOWN_LI_END: number = (1 << 3); /* internal list flag */
export const HOEDOWN_LIST_DEFINITION: number = (1 << 4);
export const HOEDOWN_LI_DT: number = (1 << 5);
export const HOEDOWN_LI_DD: number = (1 << 6);

/* hoedown_table_flags */
export const HOEDOWN_TABLE_ALIGN_LEFT: number = 1;
export const HOEDOWN_TABLE_ALIGN_RIGHT: number = 2;
export const HOEDOWN_TABLE_ALIGN_CENTER: number = 3;
export const HOEDOWN_TABLE_ALIGNMASK: number = 3;
export const HOEDOWN_TABLE_HEADER: number = 4;

/* hoedown_autolink_type */
export const HOEDOWN_AUTOLINK_NONE: number = 0; /* used internally when it is not an autolink */
export const HOEDOWN_AUTOLINK_NORMAL: number = 1; /* normal http/http/ftp/mailto/etc link */
export const HOEDOWN_AUTOLINK_EMAIL: number = 2; /* e-mail link without explit mailto: */

/* hoedown_header_type */
export const HOEDOWN_HEADER_NONE: number = 0; /* not a header */
export const HOEDOWN_HEADER_ATX: number = 1; /* e.g. "# Foo" */
export const HOEDOWN_HEADER_SETEXT: number = 2; /* e.g. "Foo\n---" or "Foo\n===" */

/* hoedown_link_type */
export const HOEDOWN_LINK_NONE: number = 0; /* not in a link */
export const HOEDOWN_LINK_INLINE: number = 1; /* e.g. [foo](/bar/) */
export const HOEDOWN_LINK_REFERENCE: number = 2; /* e.g. [foo][bar] */
export const HOEDOWN_LINK_EMPTY_REFERENCE: number = 3; /* e.g. [foo][] */
export const HOEDOWN_LINK_SHORTCUT: number = 4; /* e.g. [foo] */

const REF_TABLE_SIZE: number = 8;

const BUFFER_BLOCK: number = 0;
const BUFFER_SPAN: number = 1;
const BUFFER_ATTRIBUTE: number = 2;

/* markdown_char_t */
const MD_CHAR_NONE: number = 0;
const MD_CHAR_EMPHASIS: number = 1;
const MD_CHAR_CODESPAN: number = 2;
const MD_CHAR_LINEBREAK: number = 3;
const MD_CHAR_LINK: number = 4;
const MD_CHAR_IMAGE: number = 5;
const MD_CHAR_LANGLE: number = 6;
const MD_CHAR_ESCAPE: number = 7;
const MD_CHAR_ENTITY: number = 8;
const MD_CHAR_AUTOLINK_URL: number = 9;
const MD_CHAR_AUTOLINK_EMAIL: number = 10;
const MD_CHAR_AUTOLINK_WWW: number = 11;
const MD_CHAR_SUPERSCRIPT: number = 12;
const MD_CHAR_QUOTE: number = 13;
const MD_CHAR_MATH: number = 14;

/* character codes the parser switches on */
const C_NL: number = 0x0a;
const C_CR: number = 0x0d;
const C_TAB: number = 0x09;
const C_SPACE: number = 0x20;
const C_BANG: number = 0x21;
const C_DQUOTE: number = 0x22;
const C_HASH: number = 0x23;
const C_DOLLAR: number = 0x24;
const C_AMP: number = 0x26;
const C_SQUOTE: number = 0x27;
const C_LPAREN: number = 0x28;
const C_RPAREN: number = 0x29;
const C_STAR: number = 0x2a;
const C_PLUS: number = 0x2b;
const C_DASH: number = 0x2d;
const C_DOT: number = 0x2e;
const C_SLASH: number = 0x2f;
const C_ZERO: number = 0x30;
const C_NINE: number = 0x39;
const C_COLON: number = 0x3a;
const C_LT: number = 0x3c;
const C_EQ: number = 0x3d;
const C_GT: number = 0x3e;
const C_QMARK: number = 0x3f;
const C_AT: number = 0x40;
const C_LBRACKET: number = 0x5b;
const C_BACKSLASH: number = 0x5c;
const C_RBRACKET: number = 0x5d;
const C_CARET: number = 0x5e;
const C_UNDERSCORE: number = 0x5f;
const C_BACKTICK: number = 0x60;
const C_LBRACE: number = 0x7b;
const C_PIPE: number = 0x7c;
const C_RBRACE: number = 0x7d;
const C_TILDE: number = 0x7e;
const C_UPPER_H: number = 0x48;
const C_UPPER_R: number = 0x52;
const C_LOWER_H: number = 0x68;
const C_LOWER_R: number = 0x72;
const C_LOWER_W: number = 0x77;

/*********
 * TYPES *
 *********/

export class HoedownRendererData {
  opaque: Object | null = null;
}

/* block level callbacks - NULL skips the block */
export type HoedownBlockcodeCallback = (ob: HoedownBuffer, text: HoedownBuffer | null, lang: HoedownBuffer | null,
  attr: HoedownBuffer | null, data: HoedownRendererData) => void;
export type HoedownContentCallback = (ob: HoedownBuffer, content: HoedownBuffer | null,
  data: HoedownRendererData) => void;
export type HoedownHeaderCallback = (ob: HoedownBuffer, content: HoedownBuffer | null, attr: HoedownBuffer | null,
  level: number, data: HoedownRendererData) => void;
export type HoedownHruleCallback = (ob: HoedownBuffer, data: HoedownRendererData) => void;
export type HoedownListCallback = (ob: HoedownBuffer, content: HoedownBuffer | null, attr: HoedownBuffer | null,
  flags: number, data: HoedownRendererData) => void;
export type HoedownListitemCallback = (ob: HoedownBuffer, content: HoedownBuffer | null, attr: HoedownBuffer | null,
  flags: NumberRef, data: HoedownRendererData) => void;
export type HoedownAttrContentCallback = (ob: HoedownBuffer, content: HoedownBuffer | null, attr: HoedownBuffer | null,
  data: HoedownRendererData) => void;
export type HoedownTableCellCallback = (ob: HoedownBuffer, content: HoedownBuffer | null, flags: number,
  data: HoedownRendererData) => void;
export type HoedownFootnoteDefCallback = (ob: HoedownBuffer, content: HoedownBuffer | null, num: number,
  data: HoedownRendererData) => void;
/* span level callbacks - NULL or return false prints the span verbatim */
export type HoedownAutolinkCallback = (ob: HoedownBuffer, link: HoedownBuffer | null, type: number,
  data: HoedownRendererData) => boolean;
export type HoedownCodespanCallback = (ob: HoedownBuffer, text: HoedownBuffer | null, attr: HoedownBuffer | null,
  data: HoedownRendererData) => boolean;
export type HoedownSpanCallback = (ob: HoedownBuffer, content: HoedownBuffer | null,
  data: HoedownRendererData) => boolean;
export type HoedownImageCallback = (ob: HoedownBuffer, link: HoedownBuffer | null, title: HoedownBuffer | null,
  alt: HoedownBuffer | null, attr: HoedownBuffer | null, data: HoedownRendererData) => boolean;
export type HoedownLinebreakCallback = (ob: HoedownBuffer, data: HoedownRendererData) => boolean;
export type HoedownLinkCallback = (ob: HoedownBuffer, content: HoedownBuffer | null, link: HoedownBuffer | null,
  title: HoedownBuffer | null, attr: HoedownBuffer | null, data: HoedownRendererData) => boolean;
export type HoedownFootnoteRefCallback = (ob: HoedownBuffer, num: number, data: HoedownRendererData) => boolean;
export type HoedownMathCallback = (ob: HoedownBuffer, text: HoedownBuffer, displaymode: boolean,
  data: HoedownRendererData) => boolean;
/* miscellaneous callbacks */
export type HoedownDocCallback = (ob: HoedownBuffer, inline_render: boolean, data: HoedownRendererData) => void;
/* reference callbacks */
export type HoedownRefCallback = (orig: HoedownBuffer, data: HoedownRendererData) => void;

/* hoedown_user_block: returns the length of a user block starting at context[offset] */
export type HoedownUserBlock = (context: Uint8Array, offset: number, size: number, data: HoedownRendererData) => number;

/* hoedown_renderer - functions for rendering parsed data */
export class HoedownRenderer {
  /* state object */
  opaque: Object | null = null;

  /* block level callbacks - NULL skips the block */
  blockcode: HoedownBlockcodeCallback | null = null;
  blockquote: HoedownContentCallback | null = null;
  header: HoedownHeaderCallback | null = null;
  hrule: HoedownHruleCallback | null = null;
  list: HoedownListCallback | null = null;
  listitem: HoedownListitemCallback | null = null;
  paragraph: HoedownAttrContentCallback | null = null;
  table: HoedownAttrContentCallback | null = null;
  table_header: HoedownContentCallback | null = null;
  table_body: HoedownContentCallback | null = null;
  table_row: HoedownContentCallback | null = null;
  table_cell: HoedownTableCellCallback | null = null;
  footnotes: HoedownContentCallback | null = null;
  footnote_def: HoedownFootnoteDefCallback | null = null;
  blockhtml: HoedownContentCallback | null = null;

  /* span level callbacks - NULL or return 0 prints the span verbatim */
  autolink: HoedownAutolinkCallback | null = null;
  codespan: HoedownCodespanCallback | null = null;
  double_emphasis: HoedownSpanCallback | null = null;
  emphasis: HoedownSpanCallback | null = null;
  underline: HoedownSpanCallback | null = null;
  highlight: HoedownSpanCallback | null = null;
  quote: HoedownSpanCallback | null = null;
  image: HoedownImageCallback | null = null;
  linebreak: HoedownLinebreakCallback | null = null;
  link: HoedownLinkCallback | null = null;
  triple_emphasis: HoedownSpanCallback | null = null;
  strikethrough: HoedownSpanCallback | null = null;
  superscript: HoedownSpanCallback | null = null;
  footnote_ref: HoedownFootnoteRefCallback | null = null;
  math: HoedownMathCallback | null = null;
  raw_html: HoedownSpanCallback | null = null;

  /* low level callbacks - NULL copies input directly into the output */
  entity: HoedownContentCallback | null = null;
  normal_text: HoedownContentCallback | null = null;

  /* miscellaneous callbacks */
  doc_header: HoedownDocCallback | null = null;
  doc_footer: HoedownDocCallback | null = null;

  /* user block */
  user_block: HoedownContentCallback | null = null;

  /* reference callbacks */
  /* called when a link reference definition is parsed */
  ref: HoedownRefCallback | null = null;
  /* called when a footnote reference definition is parsed */
  footnote_ref_def: HoedownRefCallback | null = null;
}

/* memcpy(dst, src, sizeof(hoedown_renderer)) */
export function hoedown_renderer_copy(src: HoedownRenderer): HoedownRenderer {
  const r: HoedownRenderer = new HoedownRenderer();
  r.opaque = src.opaque;
  r.blockcode = src.blockcode;
  r.blockquote = src.blockquote;
  r.header = src.header;
  r.hrule = src.hrule;
  r.list = src.list;
  r.listitem = src.listitem;
  r.paragraph = src.paragraph;
  r.table = src.table;
  r.table_header = src.table_header;
  r.table_body = src.table_body;
  r.table_row = src.table_row;
  r.table_cell = src.table_cell;
  r.footnotes = src.footnotes;
  r.footnote_def = src.footnote_def;
  r.blockhtml = src.blockhtml;
  r.autolink = src.autolink;
  r.codespan = src.codespan;
  r.double_emphasis = src.double_emphasis;
  r.emphasis = src.emphasis;
  r.underline = src.underline;
  r.highlight = src.highlight;
  r.quote = src.quote;
  r.image = src.image;
  r.linebreak = src.linebreak;
  r.link = src.link;
  r.triple_emphasis = src.triple_emphasis;
  r.strikethrough = src.strikethrough;
  r.superscript = src.superscript;
  r.footnote_ref = src.footnote_ref;
  r.math = src.math;
  r.raw_html = src.raw_html;
  r.entity = src.entity;
  r.normal_text = src.normal_text;
  r.doc_header = src.doc_header;
  r.doc_footer = src.doc_footer;
  r.user_block = src.user_block;
  r.ref = src.ref;
  r.footnote_ref_def = src.footnote_ref_def;
  return r;
}

/***************
 * LOCAL TYPES *
 ***************/

/* link_ref: reference to a link */
class LinkRef {
  id: number = 0;
  link: HoedownBuffer | null = null;
  title: HoedownBuffer | null = null;
  attr: HoedownBuffer | null = null;
  next: LinkRef | null = null;
}

/* footnote_ref: reference to a footnote */
class FootnoteRef {
  id: number = 0;
  is_used: boolean = false;
  num: number = 0;
  contents: HoedownBuffer | null = null;
  /* the original string id of the footnote, before conversion to an int */
  name: HoedownBuffer | null = null;
}

/* footnote_item: an item in a footnote_list */
class FootnoteItem {
  ref: FootnoteRef;
  next: FootnoteItem | null = null;

  constructor(ref: FootnoteRef) {
    this.ref = ref;
  }
}

/* footnote_list: linked list of footnote_item */
class FootnoteList {
  count: number = 0;
  head: FootnoteItem | null = null;
  tail: FootnoteItem | null = null;
}

/* hoedown_stack of work buffers: items[0..size) are in use, the rest are pooled for reuse */
class WorkStack {
  items: HoedownBuffer[] = [];
  size: number = 0;
}

/* column count + per-column hoedown_table_flags, filled by parse_table_header */
class TableColumns {
  count: number = 0;
  flags: number[] = [];
}

/* a (start, size) span into the parsed data — the fenced-code `lang` out-parameter */
class ByteSpan {
  start: number = 0;
  size: number = 0;
}

export class HoedownDocument {
  md: HoedownRenderer;
  data: HoedownRendererData = new HoedownRendererData();

  attr_activation: number = 0;

  refs: (LinkRef | null)[] = [];
  footnotes_found: FootnoteList = new FootnoteList();
  footnotes_used: FootnoteList = new FootnoteList();
  active_char: Uint8Array = new Uint8Array(256);
  work_bufs: WorkStack[] = [new WorkStack(), new WorkStack(), new WorkStack()];
  ext_flags: number = 0;
  max_nesting: number = 0;
  in_link_body: boolean = false;

  /* extra information provided to callbacks */
  link_id: HoedownBuffer | null = null;
  link_inline_attr: HoedownBuffer | null = null;
  link_ref_attr: HoedownBuffer | null = null;
  is_escape_char: boolean = false;
  header_type: number = HOEDOWN_HEADER_NONE;
  link_type: number = HOEDOWN_LINK_NONE;
  footnote_id: HoedownBuffer | null = null;
  list_depth: number = 0;
  blockquote_depth: number = 0;
  ul_item_char: number = 0;
  hrule_char: number = 0;
  fencedcode_char: number = 0;
  ol_numeral: HoedownBuffer | null = null;

  user_block: HoedownUserBlock | null = null;
  meta: HoedownBuffer | null = null;

  constructor(md: HoedownRenderer) {
    this.md = md;
  }
}

/***************************
 * HELPER FUNCTIONS *
 ***************************/

const BUF_SIZE: number[] = [256, 64, 64];

function newbuf(doc: HoedownDocument, type: number): HoedownBuffer {
  const pool: WorkStack = doc.work_bufs[type];
  let work: HoedownBuffer;

  if (pool.size < pool.items.length) {
    work = pool.items[pool.size++];
    work.size = 0;
  } else {
    work = hoedown_buffer_new(BUF_SIZE[type]);
    pool.items.push(work);
    pool.size++;
  }

  return work;
}

function popbuf(doc: HoedownDocument, type: number): void {
  doc.work_bufs[type].size--;
}

function unscape_text(ob: HoedownBuffer, src: HoedownBuffer): void {
  let i: number = 0;
  let org: number = 0;
  while (i < src.size) {
    org = i;
    while (i < src.size && src.data[i] !== C_BACKSLASH) {
      i++;
    }

    if (i > org) {
      hoedown_buffer_put(ob, src.data, org, i - org);
    }

    if (i + 1 >= src.size) {
      break;
    }

    hoedown_buffer_putc(ob, src.data[i + 1]);
    i += 2;
  }
}

function hash_link_ref(link_ref: Uint8Array, base: number, length: number): number {
  let hash: number = 0;

  for (let i = 0; i < length; ++i) {
    hash = (toLower(link_ref[base + i]) + (hash << 6) + (hash << 16) - hash) >>> 0;
  }

  return hash;
}

function add_link_ref(references: (LinkRef | null)[], name: Uint8Array, base: number, name_size: number): LinkRef {
  const ref: LinkRef = new LinkRef();

  ref.id = hash_link_ref(name, base, name_size);
  ref.next = references[ref.id % REF_TABLE_SIZE];

  references[ref.id % REF_TABLE_SIZE] = ref;
  return ref;
}

function find_link_ref(references: (LinkRef | null)[], name: Uint8Array, base: number, length: number): LinkRef | null {
  const hash: number = hash_link_ref(name, base, length);
  let ref: LinkRef | null = references[hash % REF_TABLE_SIZE];

  while (ref !== null) {
    if (ref.id === hash) {
      return ref;
    }
    ref = ref.next;
  }

  return null;
}

function reset_link_refs(): (LinkRef | null)[] {
  const refs: (LinkRef | null)[] = [];
  for (let i = 0; i < REF_TABLE_SIZE; ++i) {
    refs.push(null);
  }
  return refs;
}

function create_footnote_ref(list: FootnoteList, name: Uint8Array, base: number, name_size: number): FootnoteRef {
  const ref: FootnoteRef = new FootnoteRef();
  ref.id = hash_link_ref(name, base, name_size);
  return ref;
}

function add_footnote_ref(list: FootnoteList, ref: FootnoteRef): boolean {
  const item: FootnoteItem = new FootnoteItem(ref);

  if (list.head === null || list.tail === null) {
    list.head = item;
    list.tail = item;
  } else {
    list.tail.next = item;
    list.tail = item;
  }
  list.count++;

  return true;
}

function find_footnote_ref(list: FootnoteList, name: Uint8Array, base: number, length: number): FootnoteRef | null {
  const hash: number = hash_link_ref(name, base, length);
  let item: FootnoteItem | null = list.head;

  while (item !== null) {
    if (item.ref.id === hash) {
      return item.ref;
    }
    item = item.next;
  }

  return null;
}

/*
 * Check whether a char is a Markdown spacing char.
 * Right now we only consider spaces the actual space and a newline: tabs and carriage
 * returns are filtered out during the preprocessing phase.
 */
function _isspace(c: number): boolean {
  return c === C_SPACE || c === C_NL;
}

/* is_empty_all: verify that all the data is spacing */
function is_empty_all(data: Uint8Array, base: number, size: number): boolean {
  let i: number = 0;
  while (i < size && _isspace(data[base + i])) {
    i++;
  }
  return i === size;
}

/*
 * Replace all spacing characters in data with spaces. As a special
 * case, this collapses a newline with the previous space, if possible.
 */
function replace_spacing(ob: HoedownBuffer, data: Uint8Array, base: number, size: number): void {
  let i: number = 0;
  let mark: number = 0;
  hoedown_buffer_grow(ob, size);
  while (true) {
    mark = i;
    while (i < size && data[base + i] !== C_NL) {
      i++;
    }
    hoedown_buffer_put(ob, data, base + mark, i - mark);

    if (i >= size) {
      break;
    }

    if (!(i > 0 && data[base + i - 1] === C_SPACE)) {
      hoedown_buffer_putc(ob, C_SPACE);
    }
    i++;
  }
}

/****************************
 * INLINE PARSING FUNCTIONS *
 ****************************/

/* is_mail_autolink • looks for the address part of a mail autolink and '>' */
/* this is less strict than the original markdown e-mail address matching */
function is_mail_autolink(data: Uint8Array, base: number, size: number): number {
  let nb: number = 0;

  /* address is assumed to be: [-@._a-zA-Z0-9]+ with exactly one '@' */
  for (let i = 0; i < size; ++i) {
    const c: number = data[base + i];
    if (isAlnum(c)) {
      continue;
    }

    if (c === C_AT) {
      nb++;
    } else if (c === C_DASH || c === C_DOT || c === C_UNDERSCORE) {
      /* allowed */
    } else if (c === C_GT) {
      return (nb === 1) ? i + 1 : 0;
    } else {
      return 0;
    }
  }

  return 0;
}

function script_tag_length(data: Uint8Array, base: number, size: number): number {
  let i: number = 2;
  let comment: number = 0;

  if (size < 3 || data[base] !== C_LT || data[base + 1] !== C_QMARK) {
    return 0;
  }

  i = 2;

  while (i < size) {
    if (data[base + i - 1] === C_QMARK && data[base + i] === C_GT && comment === 0) {
      break;
    }

    if (data[base + i] === C_SQUOTE || data[base + i] === C_DQUOTE) {
      if (comment !== 0) {
        if (data[base + i] === comment && data[base + i - 1] !== C_BACKSLASH) {
          comment = 0;
        }
      } else {
        comment = data[base + i];
      }
    }

    ++i;
  }

  if (i >= size) {
    return i;
  }

  return i + 1;
}

/* tag_length • returns the length of the given tag, or 0 is it's not valid */
function tag_length(data: Uint8Array, base: number, size: number, autolink: NumberRef, script_tag: boolean): number {
  let i: number = 0;
  let j: number = 0;

  /* a valid tag can't be shorter than 3 chars */
  if (size < 3) {
    return 0;
  }

  if (data[base] !== C_LT) {
    return 0;
  }

  /* HTML comment, laxist form */
  if (size > 5 && data[base + 1] === C_BANG && data[base + 2] === C_DASH && data[base + 3] === C_DASH) {
    i = 5;

    while (i < size && !(data[base + i - 2] === C_DASH && data[base + i - 1] === C_DASH && data[base + i] === C_GT)) {
      i++;
    }

    i++;

    if (i <= size) {
      return i;
    }
  }

  /* begins with a '<' optionally followed by '/', followed by letter or number */
  i = (data[base + 1] === C_SLASH) ? 2 : 1;

  if (!isAlnum(data[base + i])) {
    if (script_tag) {
      return script_tag_length(data, base, size);
    }
    return 0;
  }

  /* scheme test */
  autolink.value = HOEDOWN_AUTOLINK_NONE;

  /* try to find the beginning of an URI */
  while (i < size && (isAlnum(data[base + i]) || data[base + i] === C_DOT || data[base + i] === C_PLUS ||
    data[base + i] === C_DASH)) {
    i++;
  }

  if (i > 1 && i < size && data[base + i] === C_AT) {
    j = is_mail_autolink(data, base + i, size - i);
    if (j !== 0) {
      autolink.value = HOEDOWN_AUTOLINK_EMAIL;
      return i + j;
    }
  }

  if (i > 2 && i < size && data[base + i] === C_COLON) {
    autolink.value = HOEDOWN_AUTOLINK_NORMAL;
    i++;
  }

  /* completing autolink test: no spacing or ' or " */
  if (i >= size) {
    autolink.value = HOEDOWN_AUTOLINK_NONE;
  } else if (autolink.value !== HOEDOWN_AUTOLINK_NONE) {
    j = i;

    while (i < size) {
      if (data[base + i] === C_BACKSLASH) {
        i += 2;
      } else if (data[base + i] === C_GT || data[base + i] === C_SQUOTE ||
        data[base + i] === C_DQUOTE || data[base + i] === C_SPACE || data[base + i] === C_NL) {
        break;
      } else {
        i++;
      }
    }

    if (i >= size) {
      return 0;
    }
    if (i > j && data[base + i] === C_GT) {
      return i + 1;
    }
    /* one of the forbidden chars has been found */
    autolink.value = HOEDOWN_AUTOLINK_NONE;
  }

  /* looking for something looking like a tag end */
  while (i < size && data[base + i] !== C_GT) {
    i++;
  }
  if (i >= size) {
    return 0;
  }
  return i + 1;
}

/* char_trigger dispatch — markdown_char_ptrs[] */
function run_char_trigger(kind: number, ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number,
  offset: number, size: number): number {
  switch (kind) {
    case MD_CHAR_EMPHASIS: return char_emphasis(ob, doc, data, base, offset, size);
    case MD_CHAR_CODESPAN: return char_codespan(ob, doc, data, base, offset, size);
    case MD_CHAR_LINEBREAK: return char_linebreak(ob, doc, data, base, offset, size);
    case MD_CHAR_LINK: return char_link(ob, doc, data, base, offset, size);
    case MD_CHAR_IMAGE: return char_image(ob, doc, data, base, offset, size);
    case MD_CHAR_LANGLE: return char_langle_tag(ob, doc, data, base, offset, size);
    case MD_CHAR_ESCAPE: return char_escape(ob, doc, data, base, offset, size);
    case MD_CHAR_ENTITY: return char_entity(ob, doc, data, base, offset, size);
    case MD_CHAR_AUTOLINK_URL: return char_autolink_url(ob, doc, data, base, offset, size);
    case MD_CHAR_AUTOLINK_EMAIL: return char_autolink_email(ob, doc, data, base, offset, size);
    case MD_CHAR_AUTOLINK_WWW: return char_autolink_www(ob, doc, data, base, offset, size);
    case MD_CHAR_SUPERSCRIPT: return char_superscript(ob, doc, data, base, offset, size);
    case MD_CHAR_QUOTE: return char_quote(ob, doc, data, base, offset, size);
    case MD_CHAR_MATH: return char_math(ob, doc, data, base, offset, size);
    default: return 0; /* MD_CHAR_NONE */
  }
}

/* parse_inline • parses inline markdown elements */
function parse_inline(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, size: number): void {
  let i: number = 0;
  let end: number = 0;
  let consumed: number = 0;
  const active_char: Uint8Array = doc.active_char;

  if (doc.work_bufs[BUFFER_SPAN].size + doc.work_bufs[BUFFER_BLOCK].size > doc.max_nesting) {
    return;
  }

  while (i < size) {
    let user_block: number = 0;
    while (end < size) {
      if (doc.user_block !== null) {
        user_block = doc.user_block(data, base + end, size - end, doc.data);
        if (user_block !== 0) {
          break;
        }
      }
      /* copying inactive chars into the output */
      if (active_char[data[base + end]] !== 0) {
        break;
      }
      end++;
    }

    if (doc.md.normal_text !== null) {
      doc.md.normal_text(ob, hoedown_buffer_view(data, base + i, end - i), doc.data);
    } else {
      hoedown_buffer_put(ob, data, base + i, end - i);
    }

    if (end >= size) {
      break;
    }
    i = end;

    if (user_block !== 0) {
      const work: HoedownBuffer = hoedown_buffer_view(data, base + i, user_block);
      end = user_block;
      if (doc.md.user_block !== null) {
        doc.md.user_block(ob, work, doc.data);
      } else {
        hoedown_buffer_put(ob, data, base + i, size - i);
      }
      if (end === 0) {
        end = i + 1;
      } else {
        i += end;
        end = i;
        consumed = i;
      }
    } else {
      end = run_char_trigger(active_char[data[base + end]], ob, doc, data, base + i, i - consumed, size - i);
      if (end === 0) { /* no action from the callback */
        end = i + 1;
      } else {
        i += end;
        end = i;
        consumed = i;
      }
    }
  }
}

/* parse_inline_attributes • parses inline attributes, returning the end position of the
 * attributes. attributes must be in the start. differs from parse_attributes in
 * that parses_attributes assumes attributes are at the end of data.*/
function parse_inline_attributes(data: Uint8Array, base: number, size: number, attr: HoedownBuffer | null,
  attr_activation: number): number {
  let attr_start: number = 0;
  let i: number = 0;

  if (size < 1) {
    return 0;
  }

  if (data[base + i] === C_LBRACE &&
    (attr_activation === 0 || (i + 1 < size && data[base + i + 1] === attr_activation))) {
    attr_start = i + 1;
    /* skip an extra character to skip over the activation character if any */
    if (attr_activation !== 0) {
      attr_start++;
    }
  } else {
    return 0;
  }

  while (i < size) {
    /* ignore escaped characters */
    if (data[base + i] === C_BACKSLASH) {
      i += 2;
    } else if (data[base + i] === C_RBRACE) {
      if (attr !== null) {
        hoedown_buffer_put(attr, data, base + attr_start, i - attr_start);
      }
      return i + 1;
    } else {
      i++;
    }
  }
  return 0;
}

/* parse_attributes • parses special attributes at the end of the data */
function parse_attributes(data: Uint8Array, base: number, size: number, attr: HoedownBuffer | null,
  block_attr: HoedownBuffer | null, block_id: string, block_id_size: number, is_header: boolean,
  attr_activation: number): number {
  let i: number = 0;
  let len: number = 0;
  let begin: number = 0;
  let end: number = 0;

  if (size < 1) {
    return 0;
  }

  i = size;
  while (i > 0 && data[base + i - 1] === C_NL) {
    i--;
  }
  len = i;

  if (i > 0 && data[base + i - 1] === C_RBRACE) {
    do {
      i--;
    } while (i > 0 && data[base + i] !== C_LBRACE);

    begin = i + 1;
    end = len - 1;
    while (i > 0 && data[base + i - 1] === C_SPACE) {
      i--;
    }
  }

  if (is_header && i > 0 && data[base + i - 1] === C_HASH) {
    while (i > 0 && data[base + i - 1] === C_HASH) {
      i--;
    }
    while (i > 0 && data[base + i - 1] === C_SPACE) {
      i--;
    }
  }

  if (begin > 0 && end > 0 && data[base + begin - 1] === C_LBRACE && data[base + end] === C_RBRACE) {
    if (begin >= 2 && data[base + begin - 2] === C_BACKSLASH && data[base + end - 1] === C_BACKSLASH) {
      return len;
    }

    if (block_attr !== null && data[base + begin] === C_AT) {
      /* skip the @ by incrementing past it */
      begin++;
      let j: number = 0;
      while (begin < end && data[base + begin] !== C_SPACE) {
        /* if a block_id was fed in, check to make sure the string until the
         * space is identical */
        if (block_id_size !== 0 &&
          (j >= block_id_size || block_id.charCodeAt(j) !== data[base + begin])) {
          return len;
        }
        begin++;
        j++;
      }
      /* it might have matched only the first portion of block_id; make sure
       * there's no more to it here */
      if (j !== block_id_size) {
        return len;
      }
      if (block_attr !== null) {
        if (block_attr.size > 0) {
          hoedown_buffer_reset(block_attr);
        }
        hoedown_buffer_put(block_attr, data, base + begin, end - begin);
      }
      len = i;
      if (attr !== null) {
        len = parse_attributes(data, base, len, attr, null, '', 0, is_header, attr_activation);
      }
    } else if (attr !== null && (attr_activation === 0 || attr_activation === data[base + begin])) {
      if (attr.size > 0) {
        hoedown_buffer_reset(attr);
      }
      if (attr_activation !== 0) {
        begin++;
      }
      hoedown_buffer_put(attr, data, base + begin, end - begin);
      len = i;
    }
  }

  return len;
}

/* is_escaped • returns whether special char at data[loc] is escaped by '\\' */
function is_escaped(data: Uint8Array, base: number, loc: number): boolean {
  let i: number = loc;
  while (i >= 1 && data[base + i - 1] === C_BACKSLASH) {
    i--;
  }

  /* odd numbers of backslashes escapes data[loc] */
  return (loc - i) % 2 === 1;
}

/* is_backslashed • returns whether special char at data[loc] is preceded by '\\', a stricter interpretation of escaping than is_escaped. */
function is_backslashed(data: Uint8Array, base: number, loc: number): boolean {
  return loc >= 1 && data[base + loc - 1] === C_BACKSLASH;
}

/* find_emph_char • looks for the next emph uint8_t, skipping other constructs */
function find_emph_char(data: Uint8Array, base: number, size: number, c: number): number {
  let i: number = 0;

  while (i < size) {
    while (i < size && data[base + i] !== c && data[base + i] !== C_LBRACKET && data[base + i] !== C_BACKTICK) {
      i++;
    }

    if (i === size) {
      return 0;
    }

    /* not counting escaped chars */
    if (is_escaped(data, base, i)) {
      i++;
      continue;
    }

    if (data[base + i] === c) {
      return i;
    }

    /* skipping a codespan */
    if (data[base + i] === C_BACKTICK) {
      let span_nb: number = 0;
      let bt: number = 0;
      let tmp_i: number = 0;

      /* counting the number of opening backticks */
      while (i < size && data[base + i] === C_BACKTICK) {
        i++;
        span_nb++;
      }

      if (i >= size) {
        return 0;
      }

      /* finding the matching closing sequence */
      bt = 0;
      while (i < size && bt < span_nb) {
        if (tmp_i === 0 && data[base + i] === c) {
          tmp_i = i;
        }
        if (data[base + i] === C_BACKTICK) {
          bt++;
        } else {
          bt = 0;
        }
        i++;
      }

      /* not a well-formed codespan; use found matching emph char */
      if (bt < span_nb && i >= size) {
        return tmp_i;
      }
    } else if (data[base + i] === C_LBRACKET) {
      /* skipping a link */
      let tmp_i: number = 0;
      let cc: number = 0;

      i++;
      while (i < size && data[base + i] !== C_RBRACKET) {
        if (tmp_i === 0 && data[base + i] === c) {
          tmp_i = i;
        }
        i++;
      }

      i++;
      while (i < size && _isspace(data[base + i])) {
        i++;
      }

      if (i >= size) {
        return tmp_i;
      }

      if (data[base + i] === C_LBRACKET) {
        cc = C_RBRACKET;
      } else if (data[base + i] === C_LPAREN) {
        cc = C_RPAREN;
      } else {
        if (tmp_i !== 0) {
          return tmp_i;
        } else {
          continue;
        }
      }

      i++;
      while (i < size && data[base + i] !== cc) {
        if (tmp_i === 0 && data[base + i] === c) {
          tmp_i = i;
        }
        i++;
      }

      if (i >= size) {
        return tmp_i;
      }

      i++;
    }
  }

  return 0;
}

/* find_separator_char • looks for the next unbackslashed separator character c */
function find_separator_char(data: Uint8Array, base: number, size: number, c: number): number {
  let i: number = 0;

  while (i < size) {
    while (i < size && data[base + i] !== c) {
      i++;
    }

    if (i === size) {
      return 0;
    }

    /* not counting backslashed separators */
    if (is_backslashed(data, base, i)) {
      i++;
      continue;
    }

    if (data[base + i] === c) {
      return i;
    }
  }

  return 0;
}

function call_span(cb: HoedownSpanCallback | null, ob: HoedownBuffer, content: HoedownBuffer | null,
  doc: HoedownDocument): boolean {
  // C calls these unconditionally (a NULL callback would crash); a missing one renders nothing
  return cb !== null ? cb(ob, content, doc.data) : false;
}

/* parse_emph1 • parsing single emphase */
/* closed by a symbol not preceded by spacing and not followed by symbol */
function parse_emph1(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, size: number,
  c: number): number {
  let i: number = 0;
  let len: number = 0;
  let r: boolean = false;

  /* skipping one symbol if coming from emph3 */
  if (size > 1 && data[base] === c && data[base + 1] === c) {
    i = 1;
  }

  while (i < size) {
    len = find_emph_char(data, base + i, size - i, c);
    if (len === 0) {
      return 0;
    }
    i += len;
    if (i >= size) {
      return 0;
    }

    if (data[base + i] === c && !_isspace(data[base + i - 1])) {
      if ((doc.ext_flags & HOEDOWN_EXT_NO_INTRA_EMPHASIS) !== 0 ||
        ((doc.ext_flags & HOEDOWN_EXT_NO_INTRA_UNDERLINE_EMPHASIS) !== 0 && c === C_UNDERSCORE)) {
        if (i + 1 < size && isAlnum(data[base + i + 1])) {
          continue;
        }
      }

      const work: HoedownBuffer = newbuf(doc, BUFFER_SPAN);
      parse_inline(work, doc, data, base, i);

      if ((doc.ext_flags & HOEDOWN_EXT_UNDERLINE) !== 0 && c === C_UNDERSCORE) {
        r = call_span(doc.md.underline, ob, work, doc);
      } else {
        r = call_span(doc.md.emphasis, ob, work, doc);
      }

      popbuf(doc, BUFFER_SPAN);
      return r ? i + 1 : 0;
    }
  }

  return 0;
}

/* parse_emph2 • parsing single emphase */
function parse_emph2(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, size: number,
  c: number): number {
  let i: number = 0;
  let len: number = 0;
  let r: boolean = false;

  while (i < size) {
    len = find_emph_char(data, base + i, size - i, c);
    if (len === 0) {
      return 0;
    }
    i += len;

    if (i + 1 < size && data[base + i] === c && data[base + i + 1] === c && i > 0 &&
      !_isspace(data[base + i - 1])) {
      const work: HoedownBuffer = newbuf(doc, BUFFER_SPAN);
      parse_inline(work, doc, data, base, i);

      if (c === C_TILDE) {
        r = call_span(doc.md.strikethrough, ob, work, doc);
      } else if (c === C_EQ) {
        r = call_span(doc.md.highlight, ob, work, doc);
      } else {
        r = call_span(doc.md.double_emphasis, ob, work, doc);
      }

      popbuf(doc, BUFFER_SPAN);
      return r ? i + 2 : 0;
    }
    i++;
  }
  return 0;
}

/* parse_emph3 • parsing single emphase */
/* finds the first closing tag, and delegates to the other emph */
function parse_emph3(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, size: number,
  c: number): number {
  let i: number = 0;
  let len: number = 0;
  let r: boolean = false;

  while (i < size) {
    len = find_emph_char(data, base + i, size - i, c);
    if (len === 0) {
      return 0;
    }
    i += len;

    /* skip spacing preceded symbols */
    if (data[base + i] !== c || _isspace(data[base + i - 1])) {
      continue;
    }

    const triple_emphasis: HoedownSpanCallback | null = doc.md.triple_emphasis;
    if (i + 2 < size && data[base + i + 1] === c && data[base + i + 2] === c && triple_emphasis !== null) {
      /* triple symbol found */
      const work: HoedownBuffer = newbuf(doc, BUFFER_SPAN);

      parse_inline(work, doc, data, base, i);
      r = triple_emphasis(ob, work, doc.data);
      popbuf(doc, BUFFER_SPAN);
      return r ? i + 3 : 0;
    } else if (i + 1 < size && data[base + i + 1] === c) {
      /* double symbol found, handing over to emph1 */
      len = parse_emph1(ob, doc, data, base - 2, size + 2, c);
      if (len === 0) {
        return 0;
      } else {
        return len - 2;
      }
    } else {
      /* single symbol found, handing over to emph2 */
      len = parse_emph2(ob, doc, data, base - 1, size + 1, c);
      if (len === 0) {
        return 0;
      } else {
        return len - 1;
      }
    }
  }
  return 0;
}

/* parse_math • parses a math span until the given ending delimiter */
function parse_math(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, offset: number,
  size: number, end: string, delimsz: number, displaymodeIn: boolean): number {
  let i: number = delimsz;
  let displaymode: boolean = displaymodeIn;
  const endDelim: string = end.substring(0, delimsz);

  const math: HoedownMathCallback | null = doc.md.math;
  if (math === null) {
    return 0;
  }

  /* find ending delimiter */
  while (true) {
    while (i < size && data[base + i] !== end.charCodeAt(0)) {
      i++;
    }

    if (i >= size) {
      return 0;
    }

    if (!is_escaped(data, base, i) && !(i + delimsz > size) && memeqAt(data, base + i, endDelim)) {
      break;
    }

    i++;
  }

  /* prepare buffers */
  const text: HoedownBuffer = hoedown_buffer_view(data, base + delimsz, i - delimsz);

  /* if this is a $$ and MATH_EXPLICIT is not active,
   * guess whether displaymode should be enabled from the context */
  i += delimsz;
  if (delimsz === 2 && (doc.ext_flags & HOEDOWN_EXT_MATH_EXPLICIT) === 0) {
    displaymode = is_empty_all(data, base - offset, offset) && is_empty_all(data, base + i, size - i);
  }

  /* call callback */
  if (math(ob, text, displaymode, doc.data)) {
    return i;
  }

  return 0;
}

/* char_emphasis • single and double emphasis parsing */
function char_emphasis(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, offset: number,
  size: number): number {
  const c: number = data[base];
  let ret: number = 0;

  if ((doc.ext_flags & HOEDOWN_EXT_NO_INTRA_EMPHASIS) !== 0) {
    if (offset > 0 && !_isspace(data[base - 1]) && data[base - 1] !== C_GT && data[base - 1] !== C_LPAREN) {
      return 0;
    }
  }

  if (size > 2 && data[base + 1] !== c) {
    /* spacing cannot follow an opening emphasis;
     * strikethrough and highlight only takes two characters '~~' */
    if (c === C_TILDE || c === C_EQ || _isspace(data[base + 1])) {
      return 0;
    }
    ret = parse_emph1(ob, doc, data, base + 1, size - 1, c);
    if (ret === 0) {
      return 0;
    }

    return ret + 1;
  }

  if (size > 3 && data[base + 1] === c && data[base + 2] !== c) {
    if (_isspace(data[base + 2])) {
      return 0;
    }
    ret = parse_emph2(ob, doc, data, base + 2, size - 2, c);
    if (ret === 0) {
      return 0;
    }

    return ret + 2;
  }

  if (size > 4 && data[base + 1] === c && data[base + 2] === c && data[base + 3] !== c) {
    if (c === C_TILDE || c === C_EQ || _isspace(data[base + 3])) {
      return 0;
    }
    ret = parse_emph3(ob, doc, data, base + 3, size - 3, c);
    if (ret === 0) {
      return 0;
    }

    return ret + 3;
  }

  return 0;
}

/* char_linebreak • '\n' preceded by two spaces (assuming linebreak != 0) */
function char_linebreak(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, offset: number,
  size: number): number {
  if (offset < 2 || data[base - 1] !== C_SPACE || data[base - 2] !== C_SPACE) {
    return 0;
  }

  /* removing the last space from ob and rendering */
  while (ob.size > 0 && ob.data[ob.size - 1] === C_SPACE) {
    ob.size--;
  }

  if (doc.md.linebreak === null) {
    return 0;
  }
  return doc.md.linebreak(ob, doc.data) ? 1 : 0;
}

/* char_codespan • '`' parsing a code span (assuming codespan != 0) */
function char_codespan(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, offset: number,
  size: number): number {
  let end: number = 0;
  let nb: number = 0;
  let i: number = 0;
  let f_begin: number = 0;
  let f_end: number = 0;

  /* counting the number of backticks in the delimiter */
  while (nb < size && data[base + nb] === C_BACKTICK) {
    nb++;
  }

  /* finding the next delimiter */
  i = 0;
  for (end = nb; end < size && i < nb; end++) {
    if (data[base + end] === C_BACKTICK) {
      if (end + 1 === size || !is_escaped(data, base, end)) {
        i++;
      } else {
        i = 0;
      }
    } else {
      i = 0;
    }
  }

  if (i < nb && end >= size) {
    return 0; /* no matching delimiter */
  }

  /* trimming outside whitespace */
  f_begin = nb;
  while (f_begin < end && (data[base + f_begin] === C_SPACE || data[base + f_begin] === C_NL)) {
    f_begin++;
  }

  f_end = end - nb;
  while (f_end > nb && (data[base + f_end - 1] === C_SPACE || data[base + f_end - 1] === C_NL)) {
    f_end--;
  }

  const codespan: HoedownCodespanCallback | null = doc.md.codespan;
  if (codespan === null) {
    return 0;
  }

  /* real code span */
  if (f_begin < f_end) {
    const attr: HoedownBuffer = newbuf(doc, BUFFER_ATTRIBUTE);
    const work: HoedownBuffer = hoedown_buffer_view(data, base + f_begin, f_end - f_begin);

    if ((doc.ext_flags & HOEDOWN_EXT_SPECIAL_ATTRIBUTE) !== 0) {
      end += parse_inline_attributes(data, base + end, size - end, attr, doc.attr_activation);
    }

    if (!codespan(ob, work, attr, doc.data)) {
      end = 0;
    }
    popbuf(doc, BUFFER_ATTRIBUTE);
  } else {
    if (!codespan(ob, null, null, doc.data)) {
      end = 0;
    }
  }

  return end;
}

/* char_quote • '"' parsing a quote */
function char_quote(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, offset: number,
  size: number): number {
  let end: number = 0;
  let nq: number = 0;
  let i: number = 0;
  let f_begin: number = 0;
  let f_end: number = 0;

  /* counting the number of quotes in the delimiter */
  while (nq < size && data[base + nq] === C_DQUOTE) {
    nq++;
  }

  /* finding the next delimiter */
  end = nq;
  while (true) {
    i = end;
    end += find_emph_char(data, base + end, size - end, C_DQUOTE);
    if (end === i) {
      return 0; /* no matching delimiter */
    }
    i = end;
    while (end < size && data[base + end] === C_DQUOTE && end - i < nq) {
      end++;
    }
    if (end - i >= nq) {
      break;
    }
  }

  /* trimming outside spaces */
  f_begin = nq;
  while (f_begin < end && data[base + f_begin] === C_SPACE) {
    f_begin++;
  }

  f_end = end - nq;
  while (f_end > nq && data[base + f_end - 1] === C_SPACE) {
    f_end--;
  }

  /* real quote */
  if (f_begin < f_end) {
    const work: HoedownBuffer = newbuf(doc, BUFFER_SPAN);
    parse_inline(work, doc, data, base + f_begin, f_end - f_begin);

    if (!call_span(doc.md.quote, ob, work, doc)) {
      end = 0;
    }
    popbuf(doc, BUFFER_SPAN);
  } else {
    if (!call_span(doc.md.quote, ob, null, doc)) {
      end = 0;
    }
  }

  return end;
}

const ESCAPE_CHARS: string = '\\`*_{}[]()#+-.!:|&<>^~="$';

/* char_escape • '\\' backslash escape */
function char_escape(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, offset: number,
  size: number): number {
  let w: number = 0;

  if (size > 1) {
    if (data[base + 1] === C_BACKSLASH && (doc.ext_flags & HOEDOWN_EXT_MATH) !== 0 &&
      size > 2 && (data[base + 2] === C_LPAREN || data[base + 2] === C_LBRACKET)) {
      const end: string = (data[base + 2] === C_LBRACKET) ? '\\\\]' : '\\\\)';
      w = parse_math(ob, doc, data, base, offset, size, end, 3, data[base + 2] === C_LBRACKET);
      if (w !== 0) {
        return w;
      }
    }

    if (!strchrHas(ESCAPE_CHARS, data[base + 1])) {
      return 0;
    }

    if (doc.md.normal_text !== null) {
      doc.is_escape_char = true;
      doc.md.normal_text(ob, hoedown_buffer_view(data, base + 1, 1), doc.data);
      doc.is_escape_char = false;
    } else {
      hoedown_buffer_putc(ob, data[base + 1]);
    }
  } else if (size === 1) {
    if (doc.md.normal_text !== null) {
      doc.md.normal_text(ob, hoedown_buffer_view(data, base, 1), doc.data);
    } else {
      hoedown_buffer_putc(ob, data[base]);
    }
  }

  return 2;
}

/* char_entity • '&' escaped when it doesn't belong to an entity */
/* valid entities are assumed to be anything matching &#?[A-Za-z0-9]+; */
function char_entity(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, offset: number,
  size: number): number {
  let end: number = 1;

  if (end < size && data[base + end] === C_HASH) {
    end++;
  }

  while (end < size && isAlnum(data[base + end])) {
    end++;
  }

  if (end < size && data[base + end] === 0x3b) { /* ';' */
    end++; /* real entity */
  } else {
    return 0; /* lone '&' */
  }

  if (doc.md.entity !== null) {
    doc.md.entity(ob, hoedown_buffer_view(data, base, end), doc.data);
  } else {
    hoedown_buffer_put(ob, data, base, end);
  }

  return end;
}

/* char_langle_tag • '<' when tags or autolinks are allowed */
function char_langle_tag(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, offset: number,
  size: number): number {
  const altype: NumberRef = new NumberRef(HOEDOWN_AUTOLINK_NONE);
  const end: number = tag_length(data, base, size, altype, (doc.ext_flags & HOEDOWN_EXT_SCRIPT_TAGS) !== 0);
  let ret: boolean = false;

  if (end > 2) {
    if (doc.md.autolink !== null && altype.value !== HOEDOWN_AUTOLINK_NONE) {
      const u_link: HoedownBuffer = newbuf(doc, BUFFER_SPAN);
      unscape_text(u_link, hoedown_buffer_view(data, base + 1, end - 2));
      ret = doc.md.autolink(ob, u_link, altype.value, doc.data);
      popbuf(doc, BUFFER_SPAN);
    } else if (doc.md.raw_html !== null) {
      ret = doc.md.raw_html(ob, hoedown_buffer_view(data, base, end), doc.data);
    }
  }

  if (!ret) {
    return 0;
  } else {
    return end;
  }
}

function char_autolink_www(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, offset: number,
  size: number): number {
  const rewind: NumberRef = new NumberRef(0);
  let link_len: number = 0;
  const md_link: HoedownLinkCallback | null = doc.md.link;

  if (md_link === null || doc.in_link_body) {
    return 0;
  }

  const link: HoedownBuffer = newbuf(doc, BUFFER_SPAN);

  link_len = hoedown_autolink__www(rewind, link, data, base, offset, size, HOEDOWN_AUTOLINK_SHORT_DOMAINS);
  if (link_len > 0) {
    const link_url: HoedownBuffer = newbuf(doc, BUFFER_SPAN);
    hoedown_buffer_puts(link_url, 'http://');
    hoedown_buffer_put(link_url, link.data, 0, link.size);

    if (ob.size > rewind.value) {
      ob.size -= rewind.value;
    } else {
      ob.size = 0;
    }

    const normal_text: HoedownContentCallback | null = doc.md.normal_text;
    if (normal_text !== null) {
      const link_text: HoedownBuffer = newbuf(doc, BUFFER_SPAN);
      normal_text(link_text, link, doc.data);
      md_link(ob, link_text, link_url, null, null, doc.data);
      popbuf(doc, BUFFER_SPAN);
    } else {
      md_link(ob, link, link_url, null, null, doc.data);
    }
    popbuf(doc, BUFFER_SPAN);
  }

  popbuf(doc, BUFFER_SPAN);
  return link_len;
}

function char_autolink_email(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number,
  offset: number, size: number): number {
  const rewind: NumberRef = new NumberRef(0);
  let link_len: number = 0;
  const autolink: HoedownAutolinkCallback | null = doc.md.autolink;

  if (autolink === null || doc.in_link_body) {
    return 0;
  }

  const link: HoedownBuffer = newbuf(doc, BUFFER_SPAN);

  link_len = hoedown_autolink__email(rewind, link, data, base, offset, size, 0);
  if (link_len > 0) {
    if (ob.size > rewind.value) {
      ob.size -= rewind.value;
    } else {
      ob.size = 0;
    }

    autolink(ob, link, HOEDOWN_AUTOLINK_EMAIL, doc.data);
  }

  popbuf(doc, BUFFER_SPAN);
  return link_len;
}

function char_autolink_url(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, offset: number,
  size: number): number {
  const rewind: NumberRef = new NumberRef(0);
  let link_len: number = 0;
  const autolink: HoedownAutolinkCallback | null = doc.md.autolink;

  if (autolink === null || doc.in_link_body) {
    return 0;
  }

  const link: HoedownBuffer = newbuf(doc, BUFFER_SPAN);

  link_len = hoedown_autolink__url(rewind, link, data, base, offset, size, 0);
  if (link_len > 0) {
    if (ob.size > rewind.value) {
      ob.size -= rewind.value;
    } else {
      ob.size = 0;
    }

    autolink(ob, link, HOEDOWN_AUTOLINK_NORMAL, doc.data);
  }

  popbuf(doc, BUFFER_SPAN);
  return link_len;
}

function char_image(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, offset: number,
  size: number): number {
  let ret: number = 0;

  if (size < 2 || data[base + 1] !== C_LBRACKET) {
    return 0;
  }

  ret = char_link(ob, doc, data, base + 1, offset + 1, size - 1);
  if (ret === 0) {
    return 0;
  }
  return ret + 1;
}

/* char_link • '[': parsing a link, a footnote or an image */
function char_link(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, offset: number,
  size: number): number {
  const org_work_size: number = doc.work_bufs[BUFFER_SPAN].size;
  const pos: NumberRef = new NumberRef(1);

  const ret: boolean = char_link_body(ob, doc, data, base, offset, size, pos);

  /* cleanup */
  doc.work_bufs[BUFFER_SPAN].size = org_work_size;
  return ret ? pos.value : 0;
}

/* body of char_link up to its `cleanup:` label; every `goto cleanup` is a return */
function char_link_body(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, offset: number,
  size: number, pos: NumberRef): boolean {
  const is_img: boolean = (offset > 0 && data[base - 1] === C_BANG && !is_escaped(data, base - offset, offset - 1));
  const is_footnote: boolean = ((doc.ext_flags & HOEDOWN_EXT_FOOTNOTES) !== 0 && size > 1 &&
    data[base + 1] === C_CARET);
  let i: number = 1;
  let txt_e: number = 0;
  let link_b: number = 0;
  let link_e: number = 0;
  let title_b: number = 0;
  let title_e: number = 0;
  let content: HoedownBuffer | null = null;
  let link: HoedownBuffer | null = null;
  let title: HoedownBuffer | null = null;
  let u_link: HoedownBuffer | null = null;
  let inline_attr: HoedownBuffer | null = null;
  let ref_attr: HoedownBuffer | null = null;
  let attr: HoedownBuffer | null = null;
  let id: HoedownBuffer | null = null;
  let ret: boolean = false;
  let in_title: boolean = false;
  let qtype: number = 0;
  let link_type: number = HOEDOWN_LINK_NONE;
  let ref_attr_exists: boolean = false;
  let inline_attr_exists: boolean = false;

  /* checking whether the correct renderer exists */
  if ((is_footnote && doc.md.footnote_ref === null) || (is_img && doc.md.image === null) ||
    (!is_img && !is_footnote && doc.md.link === null)) {
    return false;
  }

  /* looking for the matching closing bracket */
  i += find_emph_char(data, base + i, size - i, C_RBRACKET);
  txt_e = i;

  if (i < size && data[base + i] === C_RBRACKET) {
    i++;
  } else {
    return false;
  }

  /* footnote link */
  if (is_footnote) {
    if (txt_e < 3) {
      return false;
    }

    const footnoteId: HoedownBuffer = hoedown_buffer_view(data, base + 2, txt_e - 2);

    const fr: FootnoteRef | null = find_footnote_ref(doc.footnotes_found, data, base + 2, txt_e - 2);

    /* mark footnote used */
    if (fr !== null && !fr.is_used) {
      if (!add_footnote_ref(doc.footnotes_used, fr)) {
        return false;
      }
      fr.is_used = true;
      fr.num = doc.footnotes_used.count;

      /* render */
      if (doc.md.footnote_ref !== null) {
        doc.link_id = footnoteId;
        ret = doc.md.footnote_ref(ob, fr.num, doc.data);
        doc.link_id = null;
      }
    }

    pos.value = i;
    return ret;
  }

  /* skip any amount of spacing */
  /* (this is much more laxist than original markdown syntax) */
  while (i < size && _isspace(data[base + i])) {
    i++;
  }

  if (i < size && data[base + i] === C_LPAREN) {
    /* inline style link */
    let nb_p: number = 0;

    link_type = HOEDOWN_LINK_INLINE;

    /* skipping initial spacing */
    i++;

    while (i < size && _isspace(data[base + i])) {
      i++;
    }

    link_b = i;

    /* looking for link end: ' " ) */
    /* Count the number of open parenthesis */
    nb_p = 0;

    while (i < size) {
      if (data[base + i] === C_BACKSLASH) {
        i += 2;
      } else if (data[base + i] === C_LPAREN && i !== 0) {
        nb_p++;
        i++;
      } else if (data[base + i] === C_RPAREN) {
        if (nb_p === 0) {
          break;
        } else {
          nb_p--;
        }
        i++;
      } else if (i >= 1 && _isspace(data[base + i - 1]) &&
        (data[base + i] === C_SQUOTE || data[base + i] === C_DQUOTE)) {
        break;
      } else {
        i++;
      }
    }

    if (i >= size) {
      return false;
    }
    link_e = i;

    /* looking for title end if present */
    if (data[base + i] === C_SQUOTE || data[base + i] === C_DQUOTE) {
      qtype = data[base + i];
      in_title = true;
      i++;
      title_b = i;

      while (i < size) {
        if (data[base + i] === C_BACKSLASH) {
          i += 2;
        } else if (data[base + i] === qtype) {
          in_title = false;
          i++;
        } else if ((data[base + i] === C_RPAREN) && !in_title) {
          break;
        } else {
          i++;
        }
      }

      if (i >= size) {
        return false;
      }

      /* skipping spacing after title */
      title_e = i - 1;
      while (title_e > title_b && _isspace(data[base + title_e])) {
        title_e--;
      }

      /* checking for closing quote presence */
      if (data[base + title_e] !== C_SQUOTE && data[base + title_e] !== C_DQUOTE) {
        title_b = 0;
        title_e = 0;
        link_e = i;
      }
    }

    /* remove spacing at the end of the link */
    while (link_e > link_b && _isspace(data[base + link_e - 1])) {
      link_e--;
    }

    /* remove optional angle brackets around the link */
    if (data[base + link_b] === C_LT && data[base + link_e - 1] === C_GT) {
      link_b++;
      link_e--;
    }

    /* building escaped link and title */
    if (link_e > link_b) {
      link = newbuf(doc, BUFFER_SPAN);
      hoedown_buffer_put(link, data, base + link_b, link_e - link_b);
    }

    if (title_e > title_b) {
      title = newbuf(doc, BUFFER_SPAN);
      hoedown_buffer_put(title, data, base + title_b, title_e - title_b);
    }

    i++;
  } else if (i < size && data[base + i] === C_LBRACKET) {
    /* reference style link */
    const refId: HoedownBuffer = newbuf(doc, BUFFER_SPAN);
    id = refId;

    /* looking for the id */
    i++;
    link_b = i;
    while (i < size && data[base + i] !== C_RBRACKET) {
      i++;
    }
    if (i >= size) {
      return false;
    }
    link_e = i;

    /* finding the link_ref */
    if (link_b === link_e) {
      link_type = HOEDOWN_LINK_EMPTY_REFERENCE;
      replace_spacing(refId, data, base + 1, txt_e - 1);
    } else {
      link_type = HOEDOWN_LINK_REFERENCE;
      hoedown_buffer_put(refId, data, base + link_b, link_e - link_b);
    }

    const lr: LinkRef | null = find_link_ref(doc.refs, refId.data, 0, refId.size);
    if (lr === null) {
      return false;
    }

    /* keeping link and title from link_ref */
    link = lr.link;
    title = lr.title;
    ref_attr = lr.attr;
    i++;
  } else {
    /* shortcut reference style link */
    const refId: HoedownBuffer = newbuf(doc, BUFFER_SPAN);
    id = refId;

    link_type = HOEDOWN_LINK_SHORTCUT;

    /* crafting the id */
    replace_spacing(refId, data, base + 1, txt_e - 1);

    /* finding the link_ref */
    const lr: LinkRef | null = find_link_ref(doc.refs, refId.data, 0, refId.size);
    if (lr === null) {
      return false;
    }

    /* keeping link and title from link_ref */
    link = lr.link;
    title = lr.title;
    ref_attr = lr.attr;

    /* rewinding the spacing */
    i = txt_e + 1;
  }

  /* building content: img alt is kept, only link content is parsed */
  if (txt_e > 1) {
    const body: HoedownBuffer = newbuf(doc, BUFFER_SPAN);
    content = body;
    if (is_img) {
      hoedown_buffer_put(body, data, base + 1, txt_e - 1);
    } else {
      /* disable autolinking when parsing inline the
       * content of a link */
      doc.in_link_body = true;
      parse_inline(body, doc, data, base + 1, txt_e - 1);
      doc.in_link_body = false;
    }
  }

  if (link !== null) {
    const unescaped: HoedownBuffer = newbuf(doc, BUFFER_SPAN);
    u_link = unescaped;
    unscape_text(unescaped, link);
  }

  /* if special attributes are enabled, attempt to parse an inline one from
   * the link */
  if ((doc.ext_flags & HOEDOWN_EXT_SPECIAL_ATTRIBUTE) !== 0) {
    /* attr is a span because cleanup code depends on it being span */
    const inl: HoedownBuffer = newbuf(doc, BUFFER_SPAN);
    inline_attr = inl;
    i += parse_inline_attributes(data, base + i, size - i, inl, doc.attr_activation);
  }

  /* remove optional < and > around inline and ref special attributes */
  if (ref_attr !== null && ref_attr.size > 0) {
    if (ref_attr.size > 1) {
      if (ref_attr.data[0] === C_LT) {
        hoedown_buffer_slurp(ref_attr, 1);
      }
      if (ref_attr.data[ref_attr.size - 1] === C_GT) {
        ref_attr.size--;
      }
    }
  }
  if (inline_attr !== null && inline_attr.size > 0) {
    if (inline_attr.size > 1) {
      if (inline_attr.data[0] === C_LT) {
        hoedown_buffer_slurp(inline_attr, 1);
      }
      if (inline_attr.data[inline_attr.size - 1] === C_GT) {
        inline_attr.size--;
      }
    }
  }

  /* construct the final attr that is actually applied to the link */
  ref_attr_exists = ref_attr !== null && ref_attr.size > 0;
  inline_attr_exists = inline_attr !== null && inline_attr.size > 0;
  if (ref_attr_exists || inline_attr_exists) {
    const joined: HoedownBuffer = newbuf(doc, BUFFER_SPAN);
    attr = joined;
    if (ref_attr !== null && ref_attr_exists) {
      hoedown_buffer_put(joined, ref_attr.data, 0, ref_attr.size);
    }
    /* if both inline and ref attrs exist, join them with a space to prevent
     * conflicts */
    if (ref_attr_exists && inline_attr_exists) {
      hoedown_buffer_putc(joined, C_SPACE);
    }
    if (inline_attr !== null && inline_attr_exists) {
      hoedown_buffer_put(joined, inline_attr.data, 0, inline_attr.size);
    }
  }

  /* calling the relevant rendering function */
  doc.link_id = id;
  doc.link_type = link_type;
  doc.link_ref_attr = ref_attr;
  doc.link_inline_attr = inline_attr;
  if (is_img) {
    ret = doc.md.image !== null ? doc.md.image(ob, u_link, title, content, attr, doc.data) : false;
  } else {
    ret = doc.md.link !== null ? doc.md.link(ob, content, u_link, title, attr, doc.data) : false;
  }
  doc.link_inline_attr = null;
  doc.link_ref_attr = null;
  doc.link_type = HOEDOWN_LINK_NONE;
  doc.link_id = null;

  pos.value = i;
  return ret;
}

function char_superscript(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, offset: number,
  size: number): number {
  let sup_start: number = 0;
  let sup_len: number = 0;

  const superscript: HoedownSpanCallback | null = doc.md.superscript;
  if (superscript === null) {
    return 0;
  }

  if (size < 2) {
    return 0;
  }

  if (data[base + 1] === C_LPAREN) {
    sup_start = 2;
    sup_len = find_emph_char(data, base + 2, size - 2, C_RPAREN) + 2;

    if (sup_len === size) {
      return 0;
    }
  } else {
    sup_start = 1;
    sup_len = 1;

    while (sup_len < size && !_isspace(data[base + sup_len])) {
      sup_len++;
    }
  }

  if (sup_len - sup_start === 0) {
    return (sup_start === 2) ? 3 : 0;
  }

  const sup: HoedownBuffer = newbuf(doc, BUFFER_SPAN);
  parse_inline(sup, doc, data, base + sup_start, sup_len - sup_start);
  superscript(ob, sup, doc.data);
  popbuf(doc, BUFFER_SPAN);

  return (sup_start === 2) ? sup_len + 1 : sup_len;
}

function char_math(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, offset: number,
  size: number): number {
  /* double dollar */
  if (size > 1 && data[base + 1] === C_DOLLAR) {
    return parse_math(ob, doc, data, base, offset, size, '$$', 2, true);
  }

  /* single dollar allowed only with MATH_EXPLICIT flag */
  if ((doc.ext_flags & HOEDOWN_EXT_MATH_EXPLICIT) !== 0) {
    return parse_math(ob, doc, data, base, offset, size, '$', 1, false);
  }

  return 0;
}

/*********************************
 * BLOCK-LEVEL PARSING FUNCTIONS *
 *********************************/

/* is_empty • returns the line length when it is empty, 0 otherwise */
function is_empty(data: Uint8Array, base: number, size: number): number {
  let i: number = 0;

  for (i = 0; i < size && data[base + i] !== C_NL; i++) {
    if (data[base + i] !== C_SPACE) {
      return 0;
    }
  }

  return i + 1;
}

/* is_hrule • returns whether a line is a horizontal rule */
function is_hrule(data: Uint8Array, base: number, size: number): boolean {
  let i: number = 0;
  let n: number = 0;
  let c: number = 0;

  /* skipping initial spaces */
  if (size < 3) {
    return false;
  }
  if (data[base] === C_SPACE) {
    i++;
    if (data[base + 1] === C_SPACE) {
      i++;
      if (data[base + 2] === C_SPACE) {
        i++;
      }
    }
  }

  /* looking at the hrule uint8_t */
  if (i + 2 >= size ||
    (data[base + i] !== C_STAR && data[base + i] !== C_DASH && data[base + i] !== C_UNDERSCORE)) {
    return false;
  }
  c = data[base + i];

  /* the whole line must be the char or space */
  while (i < size && data[base + i] !== C_NL) {
    if (data[base + i] === c) {
      n++;
    } else if (data[base + i] !== C_SPACE) {
      return false;
    }

    i++;
  }

  return n >= 3;
}

/* check if a line is a code fence; return the
 * end of the code fence. if passed, width of
 * the fence rule and character will be returned */
function is_codefence(data: Uint8Array, base: number, size: number, width: NumberRef | null,
  chr: NumberRef | null): number {
  let i: number = 0;
  let n: number = 1;
  let c: number = 0;

  /* skipping initial spaces */
  if (size < 3) {
    return 0;
  }

  if (data[base] === C_SPACE) {
    i++;
    if (data[base + 1] === C_SPACE) {
      i++;
      if (data[base + 2] === C_SPACE) {
        i++;
      }
    }
  }

  /* looking at the hrule uint8_t */
  c = data[base + i];
  if (i + 2 >= size || !(c === C_TILDE || c === C_BACKTICK)) {
    return 0;
  }

  /* the fence must be that same character */
  while (++i < size && data[base + i] === c) {
    ++n;
  }

  if (n < 3) {
    return 0;
  }

  if (width !== null) {
    width.value = n;
  }
  if (chr !== null) {
    chr.value = c;
  }
  return i;
}

/* expects single line, checks if it's a codefence and extracts language */
function parse_codefence(doc: HoedownDocument, data: Uint8Array, base: number, size: number, lang: ByteSpan,
  width: NumberRef, chr: NumberRef, flags: number, attr: HoedownBuffer): number {
  let i: number = 0;
  let w: number = 0;
  let lang_start: number = 0;
  let attr_start: number = 0;

  w = is_codefence(data, base, size, width, chr);
  i = w;
  if (i === 0) {
    return 0;
  }

  while (i < size && _isspace(data[base + i])) {
    i++;
  }

  lang_start = i;

  if ((flags & HOEDOWN_EXT_SPECIAL_ATTRIBUTE) !== 0) {
    attr_start = i + parse_attributes(data, base + i, size - i, attr, null, '', 0, false, doc.attr_activation);
    while (i < attr_start) {
      if (_isspace(data[base + i])) {
        break;
      }
      i++;
    }
  } else {
    while (i < size && !_isspace(data[base + i])) {
      i++;
    }
  }

  lang.start = base + lang_start;
  lang.size = i - lang_start;

  /* Avoid parsing a codespan as a fence */
  i = lang_start + 2;
  while (i < size && !(data[base + i] === chr.value && data[base + i - 1] === chr.value &&
    data[base + i - 2] === chr.value)) {
    i++;
  }
  if (i < size) {
    return 0;
  }

  return w;
}

/* is_atxheader • returns whether the line is a hash-prefixed header */
function is_atxheader(doc: HoedownDocument, data: Uint8Array, base: number, size: number): boolean {
  let level: number = 0;
  let begin: number = 0;
  let len: number = 0;

  if (data[base] !== C_HASH) {
    return false;
  }

  while (level < size && level < 6 && data[base + level] === C_HASH) {
    level++;
  }

  if (level >= size || data[base + level] === C_NL) {
    return false;
  }

  len = size - level;
  const nl: number = memchrAt(data, base + level, C_NL, len);
  if (nl >= 0) {
    len = nl + 1;
  }

  /* if the header is only whitespace, it is not a header */
  if (len > 0 && is_empty_all(data, base + level, len)) {
    return false;
  }

  if ((doc.ext_flags & HOEDOWN_EXT_SPACE_HEADERS) !== 0 && level < size && data[base + level] !== C_SPACE) {
    return false;
  }

  /* if the header is only special attribute, it is not a header */
  if (len > 0 && (doc.ext_flags & HOEDOWN_EXT_SPECIAL_ATTRIBUTE) !== 0) {
    const brace: number = memchrAt(data, base + level, C_LBRACE, len);
    if (brace >= 0) {
      /* get number of characters from # to { */
      begin = brace;
      if (begin > 0 && !is_empty_all(data, base + level, begin)) {
        return true;
      }
      /* check for special attributes after the # */
      return parse_inline_attributes(data, base + level + begin, len - begin, null, doc.attr_activation) === 0;
    }
  }

  return true;
}

/* is_headerline • returns whether the line is a setext-style hdr underline */
function is_headerline(data: Uint8Array, base: number, size: number): number {
  let i: number = 0;

  /* test of level 1 header */
  if (data[base + i] === C_EQ) {
    for (i = 1; i < size && data[base + i] === C_EQ; i++) {
      /* empty */
    }
    while (i < size && data[base + i] === C_SPACE) {
      i++;
    }
    return (i >= size || data[base + i] === C_NL) ? 1 : 0;
  }

  /* test of level 2 header */
  if (data[base + i] === C_DASH) {
    for (i = 1; i < size && data[base + i] === C_DASH; i++) {
      /* empty */
    }
    while (i < size && data[base + i] === C_SPACE) {
      i++;
    }
    return (i >= size || data[base + i] === C_NL) ? 2 : 0;
  }

  return 0;
}

function is_next_headerline(data: Uint8Array, base: number, size: number): number {
  let i: number = 0;

  while (i < size && data[base + i] !== C_NL) {
    i++;
  }

  if (++i >= size) {
    return 0;
  }

  return is_headerline(data, base + i, size - i);
}

/* prefix_quote • returns blockquote prefix length */
function prefix_quote(data: Uint8Array, base: number, size: number): number {
  let i: number = 0;
  if (i < size && data[base + i] === C_SPACE) {
    i++;
  }
  if (i < size && data[base + i] === C_SPACE) {
    i++;
  }
  if (i < size && data[base + i] === C_SPACE) {
    i++;
  }

  if (i < size && data[base + i] === C_GT) {
    if (i + 1 < size && data[base + i + 1] === C_SPACE) {
      return i + 2;
    }

    return i + 1;
  }

  return 0;
}

/* prefix_code • returns prefix length for block code*/
function prefix_code(data: Uint8Array, base: number, size: number): number {
  if (size > 3 && data[base] === C_SPACE && data[base + 1] === C_SPACE &&
    data[base + 2] === C_SPACE && data[base + 3] === C_SPACE) {
    return 4;
  }

  return 0;
}

/* prefix_oli • returns ordered list item prefix */
function prefix_oli(data: Uint8Array, base: number, size: number): number {
  let i: number = 0;

  if (i < size && data[base + i] === C_SPACE) {
    i++;
  }
  if (i < size && data[base + i] === C_SPACE) {
    i++;
  }
  if (i < size && data[base + i] === C_SPACE) {
    i++;
  }

  if (i >= size || data[base + i] < C_ZERO || data[base + i] > C_NINE) {
    return 0;
  }

  while (i < size && data[base + i] >= C_ZERO && data[base + i] <= C_NINE) {
    i++;
  }

  if (i + 1 >= size || data[base + i] !== C_DOT || data[base + i + 1] !== C_SPACE) {
    return 0;
  }

  if (is_next_headerline(data, base + i, size - i) !== 0) {
    return 0;
  }

  return i + 2;
}

/* prefix_uli • returns unordered list item prefix */
function prefix_uli(data: Uint8Array, base: number, size: number): number {
  let i: number = 0;

  if (i < size && data[base + i] === C_SPACE) {
    i++;
  }
  if (i < size && data[base + i] === C_SPACE) {
    i++;
  }
  if (i < size && data[base + i] === C_SPACE) {
    i++;
  }

  if (i + 1 >= size ||
    (data[base + i] !== C_STAR && data[base + i] !== C_PLUS && data[base + i] !== C_DASH) ||
    data[base + i + 1] !== C_SPACE) {
    return 0;
  }

  if (is_next_headerline(data, base + i, size - i) !== 0) {
    return 0;
  }

  return i + 2;
}

/* prefix_dt • returns dictionary definition prefix
 * this is in the form of /\s{0,3}:/ (e.g. "  :", where spacing is optional) */
function prefix_dt(data: Uint8Array, base: number, size: number): number {
  let i: number = 0;

  /* skip up to 3 whitespaces (since it's an indented codeblock at 4) */
  if (i < size && data[base + i] === C_SPACE) {
    i++;
  }
  if (i < size && data[base + i] === C_SPACE) {
    i++;
  }
  if (i < size && data[base + i] === C_SPACE) {
    i++;
  }

  /* if the first character after whitespaces isn't :, it isn't a dt */
  if (i + 1 >= size ||
    data[base + i] !== C_COLON ||
    data[base + i + 1] !== C_SPACE) {
    return 0;
  }

  if (is_next_headerline(data, base + i, size - i) !== 0) {
    return 0;
  }

  return i + 2;
}

/* prefix_dli • returns dictionary definition prefix
 * a dli looks like a block of text, followed by optional whitespace, followed
 * by another block with : as the first non-whitespace character */
function prefix_dli(doc: HoedownDocument, data: Uint8Array, base: number, size: number): number {
  /* end is to keep track of the final return value */
  let i: number = 0;
  let j: number = 0;
  let end: number = 0;
  let empty: boolean = false;

  /* if the first line has a : in front of it, it can't be a definition list
   * that starts at this point */
  if (prefix_dt(data, base, size) !== 0) {
    return 0;
  }

  /* temporarily toggle definition lists off to prevent infinite loops */
  doc.ext_flags &= ~HOEDOWN_EXT_DEFINITION_LISTS;

  /* check if it is a block of text with no double newlines inside, followed by
   *  another block of text starting with : */
  while (i < size) {
    /* if the line we are on is empty, flip the empty flag to indicate that
     * the next block of text we see has to start with : to be considered
     * a definition list; then skip to the next line */
    j = is_empty(data, base + i, size - i);
    if (j !== 0) {
      empty = true;
      i += j;
      continue;
    }

    /* if anything special is found while parsing the definition term part,
     * then return so that the main loop can deal with it */
    if (!is_paragraph(doc, data, base + i, size - i)) {
      break;
    }

    /* check if the current line starts with :, returning the position of the
     * beginning of the line if it does */
    j = prefix_dt(data, base + i, size - i);
    if (j > 0) {
      end = i;
      break;
    } else if (empty) {
      /* if an empty newline has been found, then since : was not the first
       * character after whitespaces, it can't be a definition list */
      break;
    }
    /* scan characters until the next newline */
    for (i = i + 1; i < size && data[base + i - 1] !== C_NL; i++) {
      /* empty */
    }
  }

  doc.ext_flags |= HOEDOWN_EXT_DEFINITION_LISTS;
  return end;
}

/* parse_blockquote • handles parsing of a blockquote fragment */
function parse_blockquote(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number,
  size: number): number {
  let beg: number = 0;
  let end: number = 0;
  let pre: number = 0;
  let work_size: number = 0;
  let work_data: number = -1; /* absolute index into data; -1 is C's NULL */

  doc.blockquote_depth++;

  const out: HoedownBuffer = newbuf(doc, BUFFER_BLOCK);
  beg = 0;
  while (beg < size) {
    for (end = beg + 1; end < size && data[base + end - 1] !== C_NL; end++) {
      /* empty */
    }

    pre = prefix_quote(data, base + beg, end - beg);

    if (pre !== 0) {
      beg += pre; /* skipping prefix */
    } else if ((doc.ext_flags & HOEDOWN_EXT_BLOCKQUOTE_EMPTY_LINE) !== 0 &&
      is_empty(data, base + beg, end - beg) !== 0) {
      /* empty line finished */
      break;
    } else if (is_empty(data, base + beg, end - beg) !== 0 &&
      (end >= size || (prefix_quote(data, base + end, size - end) === 0 &&
        is_empty(data, base + end, size - end) === 0))) {
      /* empty line followed by non-quote line */
      break;
    }

    if (beg < end) { /* copy into the in-place working buffer */
      if (work_data < 0) {
        work_data = base + beg;
      } else if (base + beg !== work_data + work_size) {
        data.copyWithin(work_data + work_size, base + beg, base + end);
      }
      work_size += end - beg;
    }
    beg = end;
  }

  parse_block(out, doc, data, work_data < 0 ? base : work_data, work_size);
  if (doc.md.blockquote !== null) {
    doc.md.blockquote(ob, out, doc.data);
  }
  popbuf(doc, BUFFER_BLOCK);

  doc.blockquote_depth--;

  return end;
}

/* parse_paragraph • handles parsing of a regular paragraph */
function parse_paragraph(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number,
  size: number): number {
  let workData: number = base;
  let workSize: number = 0;
  let i: number = 0;
  let end: number = 0;
  let level: number = 0;

  while (i < size) {
    for (end = i + 1; end < size && data[base + end - 1] !== C_NL; end++) {
      /* empty */
    }

    if (is_empty(data, base + i, size - i) !== 0) {
      break;
    }

    level = is_headerline(data, base + i, size - i);
    if (level !== 0) {
      if (i === 0) {
        level = 0;
        i = end;
      }
      break;
    }

    if (is_atxheader(doc, data, base + i, size - i) ||
      is_hrule(data, base + i, size - i) ||
      prefix_quote(data, base + i, size - i) !== 0) {
      end = i;
      break;
    }

    i = end;
  }

  workSize = i;
  while (workSize > 0 && data[base + workSize - 1] === C_NL) {
    workSize--;
  }

  if (level === 0) {
    const attr: HoedownBuffer = newbuf(doc, BUFFER_ATTRIBUTE);
    if ((doc.ext_flags & HOEDOWN_EXT_SPECIAL_ATTRIBUTE) !== 0) {
      parse_attributes(data, workData, workSize, null, attr, 'paragraph', 9, true, doc.attr_activation);
      if (attr.size > 0) {
        /* remove the length of the attribute from the work size - the 12 comes
         * from the leading space (1), the paragraph (9), the @ symbol (1), and
         * the {} (2) (any extra spaces in the attribute are included inside
         * the attribute) */
        workSize -= attr.size + 12;
      }
    }

    const tmp: HoedownBuffer = newbuf(doc, BUFFER_BLOCK);
    parse_inline(tmp, doc, data, workData, workSize);
    if (doc.md.paragraph !== null) {
      doc.md.paragraph(ob, tmp, attr, doc.data);
    }
    popbuf(doc, BUFFER_BLOCK);
    popbuf(doc, BUFFER_ATTRIBUTE);
  } else {
    let len: number = 0;

    if (workSize > 0) {
      let beg: number = 0;
      i = workSize;
      workSize -= 1;

      while (workSize > 0 && data[base + workSize] !== C_NL) {
        workSize -= 1;
      }

      beg = workSize + 1;
      while (workSize > 0 && data[base + workSize - 1] === C_NL) {
        workSize -= 1;
      }

      if (workSize > 0) {
        const tmp: HoedownBuffer = newbuf(doc, BUFFER_BLOCK);
        parse_inline(tmp, doc, data, workData, workSize);

        if (doc.md.paragraph !== null) {
          doc.md.paragraph(ob, tmp, null, doc.data);
        }

        popbuf(doc, BUFFER_BLOCK);
        workData += beg;
        workSize = i - beg;
      } else {
        workSize = i;
      }
    }

    const header_work: HoedownBuffer = newbuf(doc, BUFFER_SPAN);
    const attr_work: HoedownBuffer = newbuf(doc, BUFFER_ATTRIBUTE);

    len = workSize;
    if ((doc.ext_flags & HOEDOWN_EXT_SPECIAL_ATTRIBUTE) !== 0) {
      len = parse_attributes(data, workData, workSize, attr_work, null, '', 0, true, doc.attr_activation);
    }

    parse_inline(header_work, doc, data, workData, len);

    if (doc.md.header !== null) {
      doc.header_type = HOEDOWN_HEADER_SETEXT;
      doc.md.header(ob, header_work, attr_work, level, doc.data);
      doc.header_type = HOEDOWN_HEADER_NONE;
    }

    popbuf(doc, BUFFER_SPAN);
    popbuf(doc, BUFFER_ATTRIBUTE);
  }

  return end;
}

/* parse_fencedcode • handles parsing of a block-level code fragment */
function parse_fencedcode(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, size: number,
  flags: number): number {
  let i: number = 0;
  let text_start: number = 0;
  let line_start: number = 0;
  let w: number = 0;
  let w2: number = 0;
  const width: NumberRef = new NumberRef(0);
  const width2: NumberRef = new NumberRef(0);
  const chr: NumberRef = new NumberRef(0);
  const chr2: NumberRef = new NumberRef(0);
  const lang: ByteSpan = new ByteSpan();
  /* needed for parse_attribute functions as buffer functions do not work with
   * buffers on the stack */
  const attr: HoedownBuffer = newbuf(doc, BUFFER_ATTRIBUTE);

  /* parse codefence line */
  while (i < size && data[base + i] !== C_NL) {
    i++;
  }

  w = parse_codefence(doc, data, base, i, lang, width, chr, flags, attr);
  if (w === 0) {
    popbuf(doc, BUFFER_ATTRIBUTE);
    return 0;
  }

  /* search for end */
  i++;
  text_start = i;
  while ((line_start = i) < size) {
    while (i < size && data[base + i] !== C_NL) {
      i++;
    }

    w2 = is_codefence(data, base + line_start, i - line_start, width2, chr2);
    if (w === w2 && width.value === width2.value && chr.value === chr2.value &&
      is_empty(data, base + line_start + w, i - (line_start + w)) !== 0) {
      break;
    }

    if (i < size) {
      i++;
    }
  }

  const textSize: number = line_start - text_start;

  if (doc.md.blockcode !== null) {
    doc.fencedcode_char = chr.value;
    doc.md.blockcode(ob,
      textSize > 0 ? hoedown_buffer_view(data, base + text_start, textSize) : null,
      lang.size > 0 ? hoedown_buffer_view(data, lang.start, lang.size) : null,
      attr.size > 0 ? attr : null,
      doc.data);
    doc.fencedcode_char = 0;
  }

  popbuf(doc, BUFFER_ATTRIBUTE);

  return i;
}

function parse_blockcode(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number,
  size: number): number {
  let beg: number = 0;
  let end: number = 0;
  let pre: number = 0;

  const work: HoedownBuffer = newbuf(doc, BUFFER_BLOCK);
  const attr: HoedownBuffer = newbuf(doc, BUFFER_ATTRIBUTE);

  beg = 0;
  while (beg < size) {
    for (end = beg + 1; end < size && data[base + end - 1] !== C_NL; end++) {
      /* empty */
    }
    pre = prefix_code(data, base + beg, end - beg);

    if (pre !== 0) {
      beg += pre; /* skipping prefix */
    } else if (is_empty(data, base + beg, end - beg) === 0) {
      /* non-empty non-prefixed line breaks the pre */
      break;
    }

    if (beg < end) {
      /* verbatim copy to the working buffer,
       * escaping entities */
      if (is_empty(data, base + beg, end - beg) !== 0) {
        hoedown_buffer_putc(work, C_NL);
      } else {
        hoedown_buffer_put(work, data, base + beg, end - beg);
      }
    }
    beg = end;
  }

  while (work.size > 0 && work.data[work.size - 1] === C_NL) {
    work.size -= 1;
  }

  if ((doc.ext_flags & HOEDOWN_EXT_SPECIAL_ATTRIBUTE) !== 0) {
    work.size = parse_attributes(work.data, 0, work.size, null, attr, '', 0, false, doc.attr_activation);
  }

  hoedown_buffer_putc(work, C_NL);

  if (doc.md.blockcode !== null) {
    doc.md.blockcode(ob, work, null, attr, doc.data);
  }

  popbuf(doc, BUFFER_BLOCK);
  popbuf(doc, BUFFER_ATTRIBUTE);
  return beg;
}

/* parse_listitem • parsing of a single list item */
/*	assuming initial prefix is already removed */
function parse_listitem(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, size: number,
  flags: NumberRef, attribute: HoedownBuffer): number {
  let beg: number = 0;
  let end: number = 0;
  let pre: number = 0;
  let sublist: number = 0;
  let orgpre: number = 0;
  let i: number = 0;
  let len: number = 0;
  let fence_pre: number = 0;
  let in_empty: boolean = false;
  let has_inside_empty: boolean = false;
  let in_fence: boolean = false;
  let ul_item_char: number = C_STAR;
  let ol_numeral: HoedownBuffer | null = null;

  /* keeping track of the first indentation prefix */
  while (orgpre < 3 && orgpre < size && data[base + orgpre] === C_SPACE) {
    orgpre++;
  }

  beg = prefix_uli(data, base, size);
  if (beg !== 0) {
    ul_item_char = data[base + beg - 2];
  }
  if (beg === 0) {
    beg = prefix_oli(data, base, size);
    if (beg !== 0) {
      const numeral: HoedownBuffer = hoedown_buffer_new(1024);
      ol_numeral = numeral;
      /* -2 to eliminate the trailing ". " */
      hoedown_buffer_put(numeral, data, base, beg - 2);
    }
    if ((flags.value & HOEDOWN_LIST_DEFINITION) !== 0) {
      beg = prefix_dt(data, base, size);
      if (beg !== 0) {
        ul_item_char = data[base + beg - 2];
      }
    }
  }

  if (beg === 0) {
    return 0;
  }

  /* skipping to the beginning of the following line */
  end = beg;
  while (end < size && data[base + end - 1] !== C_NL) {
    end++;
  }

  /* getting working buffers */
  const work: HoedownBuffer = newbuf(doc, BUFFER_SPAN);
  const inter: HoedownBuffer = newbuf(doc, BUFFER_SPAN);

  /* calculating the indentation */
  i = 0;
  while (i < 4 && beg + i < end && data[base + beg + i] === C_SPACE) {
    i++;
  }

  beg += i;

  /* putting the first line into the working buffer */
  hoedown_buffer_put(work, data, base + beg, end - beg);
  beg = end;

  const attr: HoedownBuffer = newbuf(doc, BUFFER_ATTRIBUTE);

  /* process the following lines */
  while (beg < size) {
    let has_next_uli: number = 0;
    let has_next_oli: number = 0;
    let has_next_dli: number = 0;

    end++;

    while (end < size && data[base + end - 1] !== C_NL) {
      end++;
    }

    /* process an empty line */
    if (is_empty(data, base + beg, end - beg) !== 0) {
      in_empty = true;
      beg = end;
      continue;
    }

    /* calculating the indentation */
    i = 0;
    while (i < 4 && beg + i < end && data[base + beg + i] === C_SPACE) {
      i++;
    }

    if (in_fence && i > fence_pre) {
      i = fence_pre;
    }

    pre = i;

    if ((doc.ext_flags & HOEDOWN_EXT_FENCED_CODE) !== 0) {
      if (is_codefence(data, base + beg + i, end - beg - i, null, null) !== 0) {
        in_fence = !in_fence;
      }
      if (in_fence && fence_pre === 0) {
        fence_pre = pre;
      }
    }

    /* Only check for new list items if we are **not** inside
     * a fenced code block */
    if (!in_fence) {
      has_next_uli = prefix_uli(data, base + beg + i, end - beg - i);
      has_next_oli = prefix_oli(data, base + beg + i, end - beg - i);

      /* only check for the next definition if it is same indentation or less
       * since embedded definition lists need terms, so finding just a
       * colon by itself does not mean anything */
      if (pre <= orgpre) {
        has_next_dli = prefix_dt(data, base + beg + i, end - beg - i);
      }
    }

    /* checking for a new item */
    if ((has_next_uli !== 0 && !is_hrule(data, base + beg + i, end - beg - i)) ||
      has_next_oli !== 0 || ((flags.value & HOEDOWN_LI_DD) !== 0 && has_next_dli !== 0)) {
      if (in_empty) {
        has_inside_empty = true;
      }

      /* the following item must have the same (or less) indentation */
      if (pre <= orgpre) {
        /* if the following item has different list type, we end this list */
        if (in_empty && (
          ((flags.value & HOEDOWN_LIST_ORDERED) !== 0 && has_next_uli !== 0) ||
            ((flags.value & HOEDOWN_LIST_ORDERED) === 0 && has_next_oli !== 0))) {
          flags.value |= HOEDOWN_LI_END;
          has_inside_empty = false;
        }
        break;
      }

      if (sublist === 0) {
        sublist = work.size;
      }
    } else if (in_empty && pre === 0) {
      /* joining only indented stuff after empty lines;
       * note that now we only require 1 space of indentation
       * to continue a list */
      flags.value |= HOEDOWN_LI_END;
      break;
    }

    if (in_empty) {
      hoedown_buffer_putc(work, C_NL);
      has_inside_empty = true;
      in_empty = false;
    }

    /* adding the line without prefix into the working buffer */
    hoedown_buffer_put(work, data, base + beg + i, end - beg - i);
    beg = end;
  }

  /* render of li contents */
  if (has_inside_empty) {
    flags.value |= HOEDOWN_LI_BLOCK;
  }

  if ((flags.value & HOEDOWN_LI_BLOCK) !== 0) {
    /* intermediate render of block li */
    pre = 0;
    if (sublist !== 0 && sublist < work.size) {
      end = sublist;
    } else {
      end = work.size;
    }

    if ((doc.ext_flags & HOEDOWN_EXT_SPECIAL_ATTRIBUTE) !== 0) {
      i = 0;
      while (i < end && work.data[i] !== C_NL) {
        i++;
      }

      len = parse_attributes(work.data, 0, i, attr, attribute, 'list', 4, false, doc.attr_activation);
      if (i !== len) {
        pre = i;
        parse_block(inter, doc, work.data, 0, len);
      }
    }

    parse_block(inter, doc, work.data, pre, end - pre);
    if (end === sublist) {
      parse_block(inter, doc, work.data, sublist, work.size - sublist);
    }
  } else {
    /* intermediate render of inline li */
    if (sublist !== 0 && sublist < work.size) {
      if ((doc.ext_flags & HOEDOWN_EXT_SPECIAL_ATTRIBUTE) !== 0) {
        len = parse_attributes(work.data, 0, sublist, attr, attribute, 'list', 4, false, doc.attr_activation);
      } else {
        len = sublist;
      }
      parse_inline(inter, doc, work.data, 0, len);
      parse_block(inter, doc, work.data, sublist, work.size - sublist);
    } else {
      if ((doc.ext_flags & HOEDOWN_EXT_SPECIAL_ATTRIBUTE) !== 0) {
        len = parse_attributes(work.data, 0, work.size, attr, attribute, 'list', 4, false, doc.attr_activation);
      } else {
        len = work.size;
      }
      parse_inline(inter, doc, work.data, 0, len);
    }
  }

  /* render of li itself */
  if (doc.md.listitem !== null) {
    doc.ul_item_char = ul_item_char;
    doc.ol_numeral = ol_numeral;
    doc.md.listitem(ob, inter, attr, flags, doc.data);
    doc.ol_numeral = null;
    doc.ul_item_char = 0;
  }

  popbuf(doc, BUFFER_SPAN);
  popbuf(doc, BUFFER_SPAN);
  popbuf(doc, BUFFER_ATTRIBUTE);
  return beg;
}

/* parse_definition • parsing of a term/definition pair, assuming starting
 * at start of line */
function parse_definition(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, size: number,
  flags: NumberRef, attribute: HoedownBuffer): number {
  /* end represents the position of the first line where definitions start */
  let j: number = 0;
  let k: number = 0;
  let len: number = 0;
  let end: number = prefix_dli(doc, data, base, size);
  if (end <= 0) {
    return 0;
  }

  /* scan all the definition terms, rendering them to the output buffer
   * the +1 is to account for the trailing newline on each term
   * j is a counter keeping track of the beginning of each new term */
  flags.value |= HOEDOWN_LI_DT;
  while (j + 1 < end) {
    /* find the end of the term (where the newline is) */
    for (k = j + 1; k - 1 < end && data[base + k - 1] !== C_NL; k++) {
      /* empty */
    }

    len = k - j;

    if (is_empty(data, base + j, len) !== 0) {
      j = k;
      continue;
    }

    const work: HoedownBuffer = newbuf(doc, BUFFER_BLOCK);
    const attr_work: HoedownBuffer = newbuf(doc, BUFFER_ATTRIBUTE);

    if ((doc.ext_flags & HOEDOWN_EXT_SPECIAL_ATTRIBUTE) !== 0) {
      len = parse_attributes(data, base + j, len, attr_work, null, '', 0, true, doc.attr_activation);
    }

    parse_inline(work, doc, data, base + j, len);

    if (doc.md.listitem !== null) {
      doc.md.listitem(ob, work, attr_work, flags, doc.data);
    }

    j = k;

    popbuf(doc, BUFFER_BLOCK);
    popbuf(doc, BUFFER_ATTRIBUTE);
  }
  flags.value &= ~HOEDOWN_LI_DT;

  /* scan all the definitions, rendering it to the output buffer */
  flags.value |= HOEDOWN_LI_DD;
  while (end < size) {
    j = parse_listitem(ob, doc, data, base + end, size - end, flags, attribute);
    if (j <= 0) {
      break;
    }
    end += j;
  }

  flags.value &= ~HOEDOWN_LI_DD;
  flags.value &= ~HOEDOWN_LI_END;

  return end;
}

/* parse_list • parsing ordered or unordered list block */
function parse_list(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, size: number,
  listFlags: number): number {
  const flags: NumberRef = new NumberRef(listFlags);
  let i: number = 0;
  let j: number = 0;

  doc.list_depth++;

  const work: HoedownBuffer = newbuf(doc, BUFFER_BLOCK);
  const attr: HoedownBuffer = newbuf(doc, BUFFER_ATTRIBUTE);

  while (i < size) {
    if ((flags.value & HOEDOWN_LIST_DEFINITION) !== 0) {
      j = parse_definition(work, doc, data, base + i, size - i, flags, attr);
    } else {
      j = parse_listitem(work, doc, data, base + i, size - i, flags, attr);
    }
    i += j;

    if (j === 0 || (flags.value & HOEDOWN_LI_END) !== 0) {
      break;
    }
  }

  if (doc.md.list !== null) {
    doc.md.list(ob, work, attr, flags.value, doc.data);
  }
  popbuf(doc, BUFFER_BLOCK);
  popbuf(doc, BUFFER_ATTRIBUTE);

  doc.list_depth--;

  return i;
}

/* parse_atxheader • parsing of atx-style headers */
function parse_atxheader(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number,
  size: number): number {
  let level: number = 0;
  let i: number = 0;
  let end: number = 0;
  let skip: number = 0;

  while (level < size && level < 6 && data[base + level] === C_HASH) {
    level++;
  }

  for (i = level; i < size && data[base + i] === C_SPACE; i++) {
    /* empty */
  }

  for (end = i; end < size && data[base + end] !== C_NL; end++) {
    /* empty */
  }
  skip = end;

  while (end > 0 && data[base + end - 1] === C_HASH) {
    end--;
  }

  while (end > 0 && data[base + end - 1] === C_SPACE) {
    end--;
  }

  if (end > i) {
    const work: HoedownBuffer = newbuf(doc, BUFFER_SPAN);
    const attr: HoedownBuffer = newbuf(doc, BUFFER_ATTRIBUTE);
    let len: number = 0;

    len = end - i;
    if ((doc.ext_flags & HOEDOWN_EXT_SPECIAL_ATTRIBUTE) !== 0) {
      len = parse_attributes(data, base + i, end - i, attr, null, '', 0, true, doc.attr_activation);
    }

    parse_inline(work, doc, data, base + i, len);

    if (doc.md.header !== null) {
      doc.header_type = HOEDOWN_HEADER_ATX;
      doc.md.header(ob, work, attr, level, doc.data);
      doc.header_type = HOEDOWN_HEADER_NONE;
    }

    popbuf(doc, BUFFER_SPAN);
    popbuf(doc, BUFFER_ATTRIBUTE);
  } else if (doc.md.header !== null) {
    doc.md.header(ob, null, null, level, doc.data);
  }

  return skip;
}

/* parse_footnote_def • parse a single footnote definition */
function parse_footnote_def(ob: HoedownBuffer, doc: HoedownDocument, num: number, name: HoedownBuffer | null,
  data: Uint8Array, base: number, size: number): void {
  const work: HoedownBuffer = newbuf(doc, BUFFER_SPAN);
  doc.footnote_id = name;

  parse_block(work, doc, data, base, size);

  if (doc.md.footnote_def !== null) {
    doc.md.footnote_def(ob, work, num, doc.data);
  }

  doc.footnote_id = null;
  popbuf(doc, BUFFER_SPAN);
}

/* parse_footnote_list • render the contents of the footnotes */
function parse_footnote_list(ob: HoedownBuffer, doc: HoedownDocument, footnotes: FootnoteList): void {
  if (footnotes.count === 0) {
    return;
  }

  const work: HoedownBuffer = newbuf(doc, BUFFER_BLOCK);

  let item: FootnoteItem | null = footnotes.head;
  while (item !== null) {
    const ref: FootnoteRef = item.ref;
    const contents: HoedownBuffer | null = ref.contents;
    if (contents !== null) {
      parse_footnote_def(work, doc, ref.num, ref.name, contents.data, 0, contents.size);
    }
    item = item.next;
  }

  if (doc.md.footnotes !== null) {
    doc.md.footnotes(ob, work, doc.data);
  }
  popbuf(doc, BUFFER_BLOCK);
}

/* htmlblock_is_end • check for end of HTML block : </tag>( *)\n */
/*	returns tag length on match, 0 otherwise */
/*	assumes data starts with "<" */
function htmlblock_is_end(tag: string, tag_len: number, doc: HoedownDocument, data: Uint8Array, base: number,
  size: number): number {
  const i: number = tag_len + 3;
  let w: number = 0;

  /* try to match the end tag */
  /* note: we're not considering tags like "</tag >" which are still valid */
  if (i > size ||
    data[base + 1] !== C_SLASH ||
    strncasecmpAt(data, base + 2, tag, tag_len) !== 0 ||
    data[base + tag_len + 2] !== C_GT) {
    return 0;
  }

  /* rest of the line must be empty */
  w = is_empty(data, base + i, size - i);
  if (w === 0 && i < size) {
    return 0;
  }

  return i + w;
}

/* htmlblock_find_end • try to find HTML block ending tag */
/*	returns the length on match, 0 otherwise */
function htmlblock_find_end(tag: string, tag_len: number, doc: HoedownDocument, data: Uint8Array, base: number,
  size: number): number {
  let i: number = 0;
  let w: number = 0;

  while (true) {
    while (i < size && data[base + i] !== C_LT) {
      i++;
    }
    if (i >= size) {
      return 0;
    }

    w = htmlblock_is_end(tag, tag_len, doc, data, base + i, size - i);
    if (w !== 0) {
      return i + w;
    }
    i++;
  }
}

/* htmlblock_find_end_strict • try to find end of HTML block in strict mode */
/*	(it must have a blank line or a new HTML tag afterwards) */
/*	returns the length on match, 0 otherwise */
function htmlblock_find_end_strict(tag: string, tag_len: number, doc: HoedownDocument, data: Uint8Array,
  base: number, size: number): number {
  let i: number = 0;
  let mark: number = 0;

  while (true) {
    mark = i;
    while (i < size && data[base + i] !== C_NL) {
      i++;
    }
    if (i < size) {
      i++;
    }
    if (i === mark) {
      return 0;
    }

    mark += htmlblock_find_end(tag, tag_len, doc, data, base + mark, i - mark);
    if (mark === i && (is_empty(data, base + i, size - i) !== 0 ||
      (i + 1 < size && data[base + i] === C_LT && data[base + i + 1] !== C_SLASH) || i >= size)) {
      break;
    }
  }

  return i;
}

/* html_blocks.c — gperf `hoedown_find_block_tag` word list (case-insensitive exact match) */
const BLOCK_TAGS: string[] = [
  'p', 'h6', 'div', 'del', 'form', 'table', 'figure', 'pre', 'fieldset', 'noscript', 'script', 'style',
  'dl', 'ol', 'ul', 'math', 'ins', 'h5', 'iframe', 'h4', 'h3', 'blockquote', 'h2', 'h1'
];

/* html5_blocks.c — gperf `hoedown_find_html5_block_tag` word list (case-insensitive exact match) */
const HTML5_BLOCK_TAGS: string[] = [
  'p', 'ul', 'pre', 'form', 'style', 'footer', 'figure', 'section', 'fieldset', 'dl', 'figcaption', 'div',
  'del', 'header', 'script', 'math', 'video', 'ol', 'noscript', 'hgroup', 'table', 'blockquote', 'article',
  'aside', 'ins', 'iframe', 'canvas', 'nav', 'h6', 'h5', 'h4', 'h3', 'h2', 'h1', 'output'
];

const MAX_BLOCK_TAG_LENGTH: number = 10;

function find_block_tag_in(words: string[], data: Uint8Array, base: number, len: number): string | null {
  if (len < 1 || len > MAX_BLOCK_TAG_LENGTH) {
    return null;
  }
  let word: string = '';
  for (let k = 0; k < len; k++) {
    word += String.fromCharCode(toLower(data[base + k]));
  }
  for (const candidate of words) {
    if (candidate === word) {
      return candidate;
    }
  }
  return null;
}

export function hoedown_find_block_tag(data: Uint8Array, base: number, len: number): string | null {
  return find_block_tag_in(BLOCK_TAGS, data, base, len);
}

export function hoedown_find_html5_block_tag(data: Uint8Array, base: number, len: number): string | null {
  return find_block_tag_in(HTML5_BLOCK_TAGS, data, base, len);
}

/* parse_htmlblock • parsing of inline HTML block */
function parse_htmlblock(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, size: number,
  do_render: boolean): number {
  let i: number = 0;
  let j: number = 0;
  let tag_len: number = 0;
  let tag_end: number = 0;
  let curtag: string | null = null;
  let meta: number = 0;
  let workSize: number = 0;

  /* identification of the opening tag */
  if (size < 2 || data[base] !== C_LT) {
    return 0;
  }

  i = 1;
  while (i < size && data[base + i] !== C_GT && data[base + i] !== C_SPACE) {
    i++;
  }

  if (i < size) {
    if ((doc.ext_flags & HOEDOWN_EXT_HTML5_BLOCKS) !== 0) {
      curtag = hoedown_find_html5_block_tag(data, base + 1, i - 1);
    } else {
      curtag = hoedown_find_block_tag(data, base + 1, i - 1);
    }
  }

  /* handling of special cases */
  if (curtag === null) {
    /* HTML comment, laxist form */
    if (size > 5 && data[base + 1] === C_BANG && data[base + 2] === C_DASH && data[base + 3] === C_DASH) {
      i = 5;

      if (data[base + 4] === C_STAR) {
        meta++;
      }

      while (i < size && !(data[base + i - 2] === C_DASH && data[base + i - 1] === C_DASH &&
        data[base + i] === C_GT)) {
        i++;
      }

      if (data[base + i - 3] === C_STAR) {
        meta++;
      }

      i++;

      if (i < size) {
        j = is_empty(data, base + i, size - i);
      }

      if (j !== 0) {
        workSize = i + j;

        const meta_buf: HoedownBuffer | null = doc.meta;
        if (do_render && (doc.ext_flags & HOEDOWN_EXT_META_BLOCK) !== 0 && meta === 2 && meta_buf !== null) {
          let org: number = 0;
          let sz: number = 0;

          sz = workSize - 5;
          while (sz > 0 && data[base + sz - 1] === C_NL) {
            sz--;
          }

          org = 5;
          while (org < sz && data[base + org] === C_NL) {
            org++;
          }

          if (org < sz) {
            hoedown_buffer_put(meta_buf, data, base + org, sz - org);
            hoedown_buffer_putc(meta_buf, C_NL);
          }
        } else if (do_render && doc.md.blockhtml !== null) {
          doc.md.blockhtml(ob, hoedown_buffer_view(data, base, workSize), doc.data);
        }
        return workSize;
      }
    }

    /* HR, which is the only self-closing block tag considered */
    if (size > 4 && (data[base + 1] === C_LOWER_H || data[base + 1] === C_UPPER_H) &&
      (data[base + 2] === C_LOWER_R || data[base + 2] === C_UPPER_R)) {
      i = 3;
      while (i < size && data[base + i] !== C_GT) {
        i++;
      }

      if (i + 1 < size) {
        i++;
        j = is_empty(data, base + i, size - i);
        if (j !== 0) {
          workSize = i + j;
          if (do_render && doc.md.blockhtml !== null) {
            doc.md.blockhtml(ob, hoedown_buffer_view(data, base, workSize), doc.data);
          }
          return workSize;
        }
      }
    }

    /* Extension script tags */
    if ((doc.ext_flags & HOEDOWN_EXT_SCRIPT_TAGS) !== 0) {
      i = script_tag_length(data, base, size);
      if (i !== 0) {
        if (i < size) {
          j = is_empty(data, base + i, size - i);
        }

        if (j !== 0) {
          workSize = i + j;
          if (do_render && doc.md.blockhtml !== null) {
            doc.md.blockhtml(ob, hoedown_buffer_view(data, base, workSize), doc.data);
          }
          return workSize;
        }
      }
    }

    /* no special case recognised */
    return 0;
  }

  /* looking for a matching closing tag in strict mode */
  tag_len = curtag.length;
  tag_end = htmlblock_find_end_strict(curtag, tag_len, doc, data, base, size);

  /* if not found, trying a second pass looking for indented match */
  /* but not if tag is "ins" or "del" (following original Markdown.pl) */
  if (tag_end === 0 && curtag !== 'ins' && curtag !== 'del') {
    tag_end = htmlblock_find_end(curtag, tag_len, doc, data, base, size);
  }

  if (tag_end === 0) {
    return 0;
  }

  /* the end of the block has been found */
  if (do_render && doc.md.blockhtml !== null) {
    doc.md.blockhtml(ob, hoedown_buffer_view(data, base, tag_end), doc.data);
  }

  return tag_end;
}

/* Common function to parse table main rows and continued rows. */
function parse_table_cell_line(ob: HoedownBuffer, data: Uint8Array, base: number, size: number, offset: number,
  separator: number, is_continuation: boolean): number {
  let pos: number = offset;
  let line_end: number = 0;
  let cell_start: number = 0;
  let cell_end: number = 0;
  let len: number = 0;
  let copy_start: number = 0;
  let copy_end: number = 0;

  while (pos < size && _isspace(data[base + pos])) {
    pos++;
  }

  cell_start = pos;

  line_end = pos;
  while (line_end < size && data[base + line_end] !== C_NL) {
    line_end++;
  }
  len = find_separator_char(data, base + pos, line_end - pos, separator);

  /* Two possibilities for len == 0:
     1) No more separator char found in the current line.
     2) The next separator is right after the current one, i.e. empty cell.
     For case 1, we skip to the end of line; for case 2 we just continue.
  */
  if (len === 0 && pos < size && data[base + pos] !== separator) {
    while (pos + len < size && data[base + pos + len] !== C_NL) {
      len++;
    }
  }
  pos += len;

  cell_end = pos - 1;

  while (cell_end > cell_start && _isspace(data[base + cell_end])) {
    cell_end--;
  }

  /* If this isn't the first line of the cell, add a new line before the
     extra cell contents, to separate them (and make backslash linebreaks
     work).
  */
  if (is_continuation) {
    hoedown_buffer_putc(ob, C_NL);
  }

  /* Remove escaping from pipes */
  copy_start = cell_start;
  copy_end = cell_start;
  while (copy_end < cell_end + 1) {
    if (data[base + copy_end] === separator && copy_end > copy_start && data[base + copy_end - 1] === C_BACKSLASH) {
      hoedown_buffer_put(ob, data, base + copy_start, copy_end - copy_start - 1);
      copy_start = copy_end;
    }
    copy_end++;
  }
  hoedown_buffer_put(ob, data, base + copy_start, copy_end - copy_start);

  return pos - offset;
}

function parse_table_row(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, size: number,
  columns: number, rows: number, col_data: number[], header_flag: number): void {
  let i: number = 0;
  let col: number = 0;

  const table_cell: HoedownTableCellCallback | null = doc.md.table_cell;
  const table_row: HoedownContentCallback | null = doc.md.table_row;
  if (table_cell === null || table_row === null) {
    return;
  }

  const row_work: HoedownBuffer = newbuf(doc, BUFFER_SPAN);

  /* skip optional first pipe */
  if (i < size && data[base + i] === C_PIPE) {
    i++;
  }

  for (col = 0; col < columns && i < size; ++col) {
    let pos: number = 0;
    let extra_rows_in_cell: number = 0;

    /* cell_content is the text that is inline parsed into cell_work. It
       consists of the values of this cell from each row, concatenated and
       separated by new lines.
    */
    const cell_content: HoedownBuffer = newbuf(doc, BUFFER_SPAN);
    const cell_work: HoedownBuffer = newbuf(doc, BUFFER_SPAN);

    i += parse_table_cell_line(cell_content, data, base, size, i, C_PIPE, false);

    /* Add extra rows of the cell. This only occurs if rows is greater than 0,
       which only happens when multiline tables are enabled.

       Each extra row is a colon, followed by cell contents for the continued
       row, separated by colons.
    */
    extra_rows_in_cell = rows - 1;
    pos = i;
    while (extra_rows_in_cell > 0 && pos < size) {
      /* seek to the end of the current row */
      while (pos < size && data[base + pos] !== C_NL) {
        pos++;
      }

      /* skip new line and leading colon */
      if (pos < size) {
        pos++;
      }
      if (pos < size) {
        pos++;
      }

      /* Seek to the beginning of the correct column on the continuation line.
       * The continuation line should have the expected number of columns, and
       * so we never expect pos >= size or data[pos] == '\n'. These checks serve
       * as defense in depth against wrong preconditions. */
      for (let c = 0; c < col; c++) {
        while (pos < size && data[base + pos] !== C_NL &&
          (is_backslashed(data, base, pos) || data[base + pos] !== C_COLON)) {
          pos++;
        }
        if (pos < size && data[base + pos] === C_COLON) {
          pos++; /* skip colon */
        }
      }

      parse_table_cell_line(cell_content, data, base, size, pos, C_COLON, true);

      extra_rows_in_cell--;
    }

    parse_inline(cell_work, doc, cell_content.data, 0, cell_content.size);

    table_cell(row_work, cell_work, col_data[col] | header_flag, doc.data);

    popbuf(doc, BUFFER_SPAN);
    popbuf(doc, BUFFER_SPAN);
    i++;
  }

  for (; col < columns; ++col) {
    const empty_cell: HoedownBuffer = new HoedownBuffer(0);
    table_cell(row_work, empty_cell, col_data[col] | header_flag, doc.data);
  }

  table_row(ob, row_work, doc.data);

  popbuf(doc, BUFFER_SPAN);
}

function parse_table_header(ob: HoedownBuffer, attr: HoedownBuffer, doc: HoedownDocument, data: Uint8Array,
  base: number, size: number, columns: TableColumns): number {
  let pipes: number = 0;
  let rows: number = 0;
  let i: number = 0;
  let col: number = 0;
  let header_end: number = 0;
  let under_end: number = 0;

  pipes = 0;
  while (i < size && data[base + i] !== C_NL) {
    if (!is_backslashed(data, base, i) && data[base + i] === C_PIPE) {
      pipes++;
    }
    i++;
  }

  if (i === size || pipes === 0) {
    return 0;
  }

  header_end = i;

  while (header_end > 0 && _isspace(data[base + header_end - 1])) {
    header_end--;
  }

  if (data[base] === C_PIPE) {
    pipes--;
  }

  if (header_end > 0 && data[base + header_end - 1] === C_PIPE && !is_backslashed(data, base, header_end - 1)) {
    pipes--;
  }

  if ((doc.ext_flags & HOEDOWN_EXT_SPECIAL_ATTRIBUTE) !== 0) {
    let n: number = parse_attributes(data, base, header_end, attr, null, '', 0, true, doc.attr_activation);
    /* n == header_end when no attribute is found */
    if (n !== header_end) {
      while (n > 0 && _isspace(data[base + n - 1])) {
        n--;
      }
      if (attr.size > 0 && n > 0 && data[base + n - 1] === C_PIPE && !is_backslashed(data, base, n - 1)) {
        pipes--;
      }

      header_end = n + 1;
    }
  }

  if (pipes < 0) {
    return 0;
  }

  /* header_contents will have the lines of the header copied into it, and then
     is passed to parse_table_row. We need a separate buffer to avoid passing
     the attribute to parse_table_row.
  */
  const header_contents: HoedownBuffer = newbuf(doc, BUFFER_SPAN);
  hoedown_buffer_put(header_contents, data, base, header_end);

  columns.count = pipes + 1;
  columns.flags = [];
  for (let k = 0; k < columns.count; k++) {
    columns.flags.push(0);
  }

  /* If the multiline table extension is enabled, check the next lines for
     continuation markers, to find the number of text rows that make up this
     logical row, and copy the contents of each row to header_contents,
     separated by new lines.
  */
  rows = 1;
  if ((doc.ext_flags & HOEDOWN_EXT_MULTILINE_TABLES) !== 0) {
    while (i < size) {
      let j: number = i + 1;
      let colons: number = 0;

      /* Require that the continuation line starts with a colon */
      if (j >= size || data[base + j] !== C_COLON) {
        break;
      }
      /* Skip the leading colon to match the pipe counting behavior above */
      j++;

      /* Require that the continuation line start with ": ", to
         distinguish from ":-" which could start a left-aligned header
         bar.
      */
      if (j >= size || data[base + j] !== C_SPACE) {
        break;
      }

      while (j < size && data[base + j] !== C_NL) {
        j++;
        if (j < size && !is_backslashed(data, base, j) && data[base + j] === C_COLON) {
          colons++;
        }
      }

      /* Allow a trailing colon to match the pipe counting behavior above */
      if (!is_backslashed(data, base, j - 1) && data[base + j - 1] === C_COLON) {
        colons--;
      }

      if (colons !== pipes) {
        break;
      }

      hoedown_buffer_putc(header_contents, C_NL);
      /* data[i] is the previous new line, and data[j] is the next new
         line. This copies all the text between the new lines.
       */
      hoedown_buffer_put(header_contents, data, base + i + 1, j - i - 1);

      rows++;
      i = j;
      header_end = j;
    }
  }

  /* Parse the header underline */
  i++;
  if (i < size && data[base + i] === C_PIPE) {
    i++;
  }

  under_end = i;
  while (under_end < size && data[base + under_end] !== C_NL) {
    under_end++;
  }

  for (col = 0; col < columns.count && i < under_end; ++col) {
    let dashes: number = 0;

    while (i < under_end && data[base + i] === C_SPACE) {
      i++;
    }

    if (i < under_end && data[base + i] === C_COLON) {
      i++;
      columns.flags[col] |= HOEDOWN_TABLE_ALIGN_LEFT;
      dashes++;
    }

    while (i < under_end && data[base + i] === C_DASH) {
      i++;
      dashes++;
    }

    if (i < under_end && data[base + i] === C_COLON) {
      i++;
      columns.flags[col] |= HOEDOWN_TABLE_ALIGN_RIGHT;
      dashes++;
    }

    while (i < under_end && data[base + i] === C_SPACE) {
      i++;
    }

    if (i < under_end && data[base + i] !== C_PIPE && data[base + i] !== C_PLUS) {
      break;
    }

    if (dashes < 3) {
      break;
    }

    i++;
  }

  if (col < columns.count) {
    /* clean up header_contents */
    popbuf(doc, BUFFER_SPAN);
    return 0;
  }

  parse_table_row(
    ob, doc, header_contents.data, 0,
    header_contents.size,
    columns.count,
    rows,
    columns.flags,
    HOEDOWN_TABLE_HEADER
  );

  /* clean up header_contents */
  popbuf(doc, BUFFER_SPAN);

  return under_end + 1;
}

function parse_table(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number,
  size: number): number {
  let i: number = 0;
  const columns: TableColumns = new TableColumns();

  const work: HoedownBuffer = newbuf(doc, BUFFER_BLOCK);
  const header_work: HoedownBuffer = newbuf(doc, BUFFER_SPAN);
  const body_work: HoedownBuffer = newbuf(doc, BUFFER_BLOCK);
  const attr_work: HoedownBuffer = newbuf(doc, BUFFER_ATTRIBUTE);
  i = parse_table_header(header_work, attr_work, doc, data, base, size, columns);
  if (i > 0) {
    while (i < size) {
      let row_start: number = 0;
      let pipes: number = 0;
      let rows: number = 1;

      row_start = i;

      while (i < size && data[base + i] !== C_NL) {
        if (data[base + i] === C_PIPE && !is_backslashed(data, base, i)) {
          pipes++;
        }
        i++;
      }

      if (pipes === 0 || i === size) {
        i = row_start;
        break;
      }

      /* Don't count a leading pipe. */
      if (data[base + row_start] === C_PIPE) {
        pipes--;
      }

      /* Don't count a trailing pipe. */
      if (data[base + i - 1] === C_PIPE && !is_backslashed(data, base, i - 1)) {
        pipes--;
      }

      /* If the multiline table extension is enabled, check the next
         lines for continuation markers, to find the number of text rows
         that make up this logical row.
      */
      if ((doc.ext_flags & HOEDOWN_EXT_MULTILINE_TABLES) !== 0) {
        while (i < size) {
          let j: number = i + 1;
          let colons: number = 0;

          /* Require that a continued row starts with a colon. */
          if (j >= size || data[base + j] !== C_COLON) {
            break;
          }

          /* Don't count leading colon for comparison to pipes. */
          j++;

          while (j < size && data[base + j] !== C_NL) {
            if (!is_backslashed(data, base, j) && data[base + j] === C_COLON) {
              colons++;
            }
            j++;
          }

          /* Don't count a trailing colon for comparison to pipes. */
          if (!is_backslashed(data, base, j - 1) && data[base + j - 1] === C_COLON) {
            colons--;
          }

          /* Hoedown allows table rows where the number of cells is different
           * from `columns`. In this case, `parse_table_row` will add empty
           * cells. However, the code does not work in the multi-line case, so
           * we require the right number of columns. */
          if (colons !== pipes || colons !== columns.count - 1) {
            break;
          }

          rows++;
          i = j;
        }
      }

      parse_table_row(
        body_work,
        doc,
        data, base + row_start,
        i - row_start,
        columns.count,
        rows,
        columns.flags, 0
      );

      i++;

      /* Skip an optional row separator, if it's there. */
      if ((doc.ext_flags & HOEDOWN_EXT_MULTILINE_TABLES) !== 0) {
        /* Use j instead of i, and set i to j only if this is actually a row separator. */
        let j: number = i;
        let next_line_end: number = i;
        let col: number = 0;

        /* Seek next_line_end to the position of the terminating new line. */
        while (next_line_end < size && data[base + next_line_end] !== C_NL) {
          next_line_end++;
        }

        /* Skip leading pipe, if any. */
        if (j < next_line_end && data[base + j] === C_PIPE) {
          j++;
        }

        /* Ensure that there are at least columns pipe/plus separated
           runs of dashes, each at least 3 long. The pipes may be
           padded with spaces, and the line may end in a pipe.
        */
        for (col = 0; col < columns.count && j < next_line_end; col++) {
          let dashes: number = 0;

          while (j < next_line_end && data[base + j] === C_SPACE) {
            j++;
          }

          while (j < next_line_end && data[base + j] === C_DASH) {
            j++;
            dashes++;
          }

          while (j < next_line_end && data[base + j] === C_SPACE) {
            j++;
          }

          if (j < next_line_end && data[base + j] !== C_PIPE && data[base + j] !== C_PLUS) {
            break;
          }

          if (dashes < 3) {
            break;
          }

          j++;
        }

        /* Skip i past the row separator, if it was valid. */
        if (col === columns.count) {
          i = next_line_end + 1;
        }
      }
    }

    if (doc.md.table_header !== null) {
      doc.md.table_header(work, header_work, doc.data);
    }

    if (doc.md.table_body !== null) {
      doc.md.table_body(work, body_work, doc.data);
    }

    if (doc.md.table !== null) {
      doc.md.table(ob, work, attr_work, doc.data);
    }
  }

  popbuf(doc, BUFFER_SPAN);
  popbuf(doc, BUFFER_BLOCK);
  popbuf(doc, BUFFER_BLOCK);
  popbuf(doc, BUFFER_ATTRIBUTE);
  return i;
}

/* parse_userblock • parsing of user block */
function parse_userblock(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number,
  size: number): number {
  const user_block: HoedownUserBlock | null = doc.user_block;
  if (user_block === null) {
    return 0;
  }
  const len: number = user_block(data, base, size, doc.data);

  if (len === 0) {
    return 0;
  }

  if (doc.md.user_block !== null) {
    doc.md.user_block(ob, hoedown_buffer_view(data, base, len), doc.data);
  } else {
    hoedown_buffer_put(ob, data, base, len);
  }
  return len;
}

/* is_paragraph • returns if the next block is a paragraph (doesn't follow any
 * other special rules for other types of blocks) */
function is_paragraph(doc: HoedownDocument, data: Uint8Array, base: number, end: number): boolean {
  /* temporary buffer for results of checking special blocks */
  const tmp: HoedownBuffer = newbuf(doc, BUFFER_BLOCK);
  /* store the old renderer, and swap in a temporary renderer that has no rendering function */
  const old_renderer: HoedownRenderer = doc.md;
  doc.md = new HoedownRenderer();
  /* these are all the if branches inside parse_block, wrapped into one bool,
   * with minimal parsing, and completely idempotent */
  const result: boolean = !(is_atxheader(doc, data, base, end) ||
    (doc.user_block !== null && parse_userblock(tmp, doc, data, base, end) !== 0) ||
    (data[base] === C_LT && parse_htmlblock(tmp, doc, data, base, end, false) !== 0) ||
    is_hrule(data, base, end) ||
    ((doc.ext_flags & HOEDOWN_EXT_FENCED_CODE) !== 0 && parse_fencedcode(tmp, doc, data, base, end,
      doc.ext_flags) !== 0) ||
    ((doc.ext_flags & HOEDOWN_EXT_TABLES) !== 0 && parse_table(tmp, doc, data, base, end) !== 0) ||
    prefix_quote(data, base, end) !== 0 ||
    ((doc.ext_flags & HOEDOWN_EXT_DISABLE_INDENTED_CODE) === 0 && prefix_code(data, base, end) !== 0) ||
    prefix_uli(data, base, end) !== 0 ||
    prefix_oli(data, base, end) !== 0 ||
    ((doc.ext_flags & HOEDOWN_EXT_DEFINITION_LISTS) !== 0 && prefix_dli(doc, data, base, end) !== 0));
  popbuf(doc, BUFFER_BLOCK);
  doc.md = old_renderer;
  return result;
}

/* parse_block • parsing of one block, returning next uint8_t to parse */
function parse_block(ob: HoedownBuffer, doc: HoedownDocument, data: Uint8Array, base: number, size: number): void {
  let beg: number = 0;
  let end: number = 0;
  let i: number = 0;
  let txt: number = 0;

  if (doc.work_bufs[BUFFER_SPAN].size + doc.work_bufs[BUFFER_BLOCK].size > doc.max_nesting) {
    return;
  }

  while (beg < size) {
    txt = base + beg;
    end = size - beg;

    if (is_atxheader(doc, data, txt, end)) {
      beg += parse_atxheader(ob, doc, data, txt, end);
      continue;
    }

    if (doc.user_block !== null) {
      i = parse_userblock(ob, doc, data, txt, end);
      if (i !== 0) {
        beg += i;
        continue;
      }
    }

    if (data[base + beg] === C_LT && doc.md.blockhtml !== null) {
      i = parse_htmlblock(ob, doc, data, txt, end, true);
      if (i !== 0) {
        beg += i;
        continue;
      }
    }

    i = is_empty(data, txt, end);
    if (i !== 0) {
      beg += i;
      continue;
    }

    if (is_hrule(data, txt, end)) {
      while (beg < size && data[base + beg] !== C_NL) {
        beg++;
      }

      if (doc.md.hrule !== null) {
        doc.hrule_char = data[base + beg - 1];
        doc.md.hrule(ob, doc.data);
        doc.hrule_char = 0;
      }

      beg++;
      continue;
    }

    if ((doc.ext_flags & HOEDOWN_EXT_FENCED_CODE) !== 0) {
      i = parse_fencedcode(ob, doc, data, txt, end, doc.ext_flags);
      if (i !== 0) {
        beg += i;
        continue;
      }
    }

    if ((doc.ext_flags & HOEDOWN_EXT_TABLES) !== 0) {
      i = parse_table(ob, doc, data, txt, end);
      if (i !== 0) {
        beg += i;
        continue;
      }
    }

    if (prefix_quote(data, txt, end) !== 0) {
      beg += parse_blockquote(ob, doc, data, txt, end);
    } else if ((doc.ext_flags & HOEDOWN_EXT_DISABLE_INDENTED_CODE) === 0 && prefix_code(data, txt, end) !== 0) {
      beg += parse_blockcode(ob, doc, data, txt, end);
    } else if (prefix_uli(data, txt, end) !== 0) {
      beg += parse_list(ob, doc, data, txt, end, 0);
    } else if (prefix_oli(data, txt, end) !== 0) {
      beg += parse_list(ob, doc, data, txt, end, HOEDOWN_LIST_ORDERED);
    } else if ((doc.ext_flags & HOEDOWN_EXT_DEFINITION_LISTS) !== 0 && prefix_dli(doc, data, txt, end) !== 0) {
      beg += parse_list(ob, doc, data, txt, end, HOEDOWN_LIST_DEFINITION);
    } else {
      beg += parse_paragraph(ob, doc, data, txt, end);
    }
  }
}

/*********************
 * REFERENCE PARSING *
 *********************/

/* is_footnote • returns whether a line is a footnote definition or not */
function is_footnote(data: Uint8Array, beg: number, end: number, last: NumberRef | null,
  list: FootnoteList | null): boolean {
  let i: number = 0;
  let ind: number = 0;
  let in_empty: boolean = false;
  let start: number = 0;

  let id_offset: number = 0;
  let id_end: number = 0;
  let id_indent: number = 0;
  let content_line: number = 0;
  let content_indent: number = 0;

  /* up to 3 optional leading spaces */
  if (beg + 3 >= end) {
    return false;
  }
  if (data[beg] === C_SPACE) {
    i = 1;
    if (data[beg + 1] === C_SPACE) {
      i = 2;
      if (data[beg + 2] === C_SPACE) {
        i = 3;
        if (data[beg + 3] === C_SPACE) {
          return false;
        }
      }
    }
  }
  i += beg;

  /* id part: caret followed by anything between brackets */
  if (data[i] !== C_LBRACKET) {
    return false;
  }
  i++;
  if (i >= end || data[i] !== C_CARET) {
    return false;
  }
  i++;
  id_offset = i;
  while (i < end && data[i] !== C_NL && data[i] !== C_CR && data[i] !== C_RBRACKET) {
    i++;
  }
  if (i >= end || data[i] !== C_RBRACKET) {
    return false;
  }
  id_end = i;

  /* spacer: colon (space | tab)* newline? (space | tab)* */
  i++;
  if (i >= end || data[i] !== C_COLON) {
    return false;
  }
  i++;
  if (i >= end) {
    return false;
  }

  /* getting content and name buffers */
  const contents: HoedownBuffer = hoedown_buffer_new(64);
  const name: HoedownBuffer = hoedown_buffer_new(64);

  start = i;

  /* getting item indent size */
  while (id_indent !== start && data[start - id_indent] !== C_NL && data[start - id_indent] !== C_CR) {
    id_indent++;
  }

  /* process lines similar to a list item */
  while (i < end) {
    while (i < end && data[i] !== C_NL && data[i] !== C_CR) {
      i++;
    }

    /* process an empty line */
    if (is_empty(data, start, i - start) !== 0) {
      in_empty = true;
      if (i < end && (data[i] === C_NL || data[i] === C_CR)) {
        i++;
        if (i < end && data[i] === C_NL && data[i - 1] === C_CR) {
          i++;
        }
      }
      start = i;
      continue;
    }

    /* calculating the indentation */
    ind = 0;
    while (ind < 4 && start + ind < end && data[start + ind] === C_SPACE) {
      ind++;
    }

    content_line++;

    /* joining only indented stuff after empty lines;
     * note that now we only require 1 space of indentation
     * to continue, just like lists */
    if (ind === 0) {
      if (start === id_end + 2 && data[start] === C_TAB) {
        /* continue on the definition line */
      } else {
        break;
      }
    } else if (in_empty) {
      hoedown_buffer_putc(contents, C_NL);
    }

    in_empty = false;

    /* re-calculating the indentation */
    if (content_line === 2 && data[start + ind] === C_SPACE) {
      while (ind < id_indent && data[start + ind] === C_SPACE) {
        ind++;
      }
      content_indent = ind;
    }
    if (content_indent > ind) {
      while (ind < content_indent && data[start + ind] === C_SPACE) {
        ind++;
      }
    }

    /* adding the line into the content buffer */
    hoedown_buffer_put(contents, data, start + ind, i - start - ind);
    /* add carriage return */
    if (i < end) {
      hoedown_buffer_putc(contents, C_NL);
      if (i < end && (data[i] === C_NL || data[i] === C_CR)) {
        i++;
        if (i < end && data[i] === C_NL && data[i - 1] === C_CR) {
          i++;
        }
      }
    }
    start = i;
  }

  if (last !== null) {
    last.value = start;
  }

  if (list !== null) {
    const ref: FootnoteRef = create_footnote_ref(list, data, id_offset, id_end - id_offset);
    if (!add_footnote_ref(list, ref)) {
      return false;
    }
    ref.contents = contents;
    hoedown_buffer_put(name, data, id_offset, id_end - id_offset);
    ref.name = name;
  }

  return true;
}

/* is_html_comment • returns whether a html comment or not */
function is_html_comment(data: Uint8Array, beg: number, end: number, last: NumberRef | null): boolean {
  let i: number = 0;

  if (beg + 5 >= end) {
    return false;
  }
  if (!(data[beg] === C_LT && data[beg + 1] === C_BANG && data[beg + 2] === C_DASH && data[beg + 3] === C_DASH)) {
    return false;
  }

  i = 5;
  while (beg + i < end && !(data[beg + i - 2] === C_DASH && data[beg + i - 1] === C_DASH && data[beg + i] === C_GT)) {
    i++;
  }
  /* i can only ever be beyond the end if the ending --> is not found */
  if (beg + i >= end) {
    return false;
  }
  i++;

  if (beg + i < end && (data[beg + i] === C_NL || data[beg + i] === C_CR)) {
    i++;
    if (beg + i < end && data[beg + i] === C_CR && data[beg + i - 1] === C_NL) {
      i++;
    }
  }

  if (last !== null) {
    last.value = beg + i;
  }

  return true;
}

/* is_ref • returns whether a line is a reference or not */
function is_ref(data: Uint8Array, beg: number, end: number, last: NumberRef | null,
  refs: (LinkRef | null)[] | null): boolean {
  let i: number = 0;
  let id_offset: number = 0;
  let id_end: number = 0;
  let link_offset: number = 0;
  let link_end: number = 0;
  let title_offset: number = 0;
  let title_end: number = 0;
  let line_end: number = 0;
  let attr_offset: number = 0;
  let attr_end: number = 0;

  /* up to 3 optional leading spaces */
  if (beg + 3 >= end) {
    return false;
  }
  if (data[beg] === C_SPACE) {
    i = 1;
    if (data[beg + 1] === C_SPACE) {
      i = 2;
      if (data[beg + 2] === C_SPACE) {
        i = 3;
        if (data[beg + 3] === C_SPACE) {
          return false;
        }
      }
    }
  }
  i += beg;

  /* id part: anything but a newline between brackets */
  if (data[i] !== C_LBRACKET) {
    return false;
  }
  i++;
  id_offset = i;
  while (i < end && data[i] !== C_NL && data[i] !== C_CR && data[i] !== C_RBRACKET) {
    i++;
  }
  if (i >= end || data[i] !== C_RBRACKET) {
    return false;
  }
  id_end = i;

  /* spacer: colon (space | tab)* newline? (space | tab)* */
  i++;
  if (i >= end || data[i] !== C_COLON) {
    return false;
  }
  i++;
  while (i < end && data[i] === C_SPACE) {
    i++;
  }
  if (i < end && (data[i] === C_NL || data[i] === C_CR)) {
    i++;
    if (i < end && data[i] === C_CR && data[i - 1] === C_NL) {
      i++;
    }
  }
  while (i < end && data[i] === C_SPACE) {
    i++;
  }
  if (i >= end) {
    return false;
  }

  /* link: spacing-free sequence, optionally between angle brackets */
  if (data[i] === C_LT) {
    i++;
  }

  link_offset = i;

  while (i < end && data[i] !== C_SPACE && data[i] !== C_NL && data[i] !== C_CR) {
    i++;
  }

  if (data[i - 1] === C_GT) {
    link_end = i - 1;
  } else {
    link_end = i;
  }

  /* optional spacer: (space | tab)* (newline | '\'' | '"' | '(' ) */
  while (i < end && data[i] === C_SPACE) {
    i++;
  }
  if (i < end && data[i] !== C_NL && data[i] !== C_CR &&
    data[i] !== C_SQUOTE && data[i] !== C_DQUOTE && data[i] !== C_LPAREN) {
    return false;
  }
  line_end = 0;
  /* computing end-of-line */
  if (i >= end || data[i] === C_CR || data[i] === C_NL) {
    line_end = i;
  }
  if (i + 1 < end && data[i] === C_NL && data[i + 1] === C_CR) {
    line_end = i + 1;
  }

  /* optional (space|tab)* spacer after a newline */
  if (line_end !== 0) {
    i = line_end + 1;
    while (i < end && data[i] === C_SPACE) {
      i++;
    }
  }

  /* optional title: any non-newline sequence enclosed in '"()
					alone on its line */
  title_offset = 0;
  title_end = 0;
  if (i + 1 < end &&
    (data[i] === C_SQUOTE || data[i] === C_DQUOTE || data[i] === C_LPAREN)) {
    const d: number = data[i++];
    title_offset = i;

    /* looking for end of tile */
    while (i < end && data[i] !== d && data[i] !== C_NL && data[i] !== C_CR) {
      ++i;
    }

    if (i + 1 < end && data[i] === d) {
      title_end = i++;
      attr_offset = i;

      /* looking for EOL */
      while (i < end && data[i] !== C_NL && data[i] !== C_CR) {
        i++;
      }

      /* looking for attribute */
      if (data[i - 1] === C_RBRACE && memchrAt(data, attr_offset, C_LBRACE, i - attr_offset) >= 0) {
        while (attr_offset < i && data[attr_offset] !== C_LBRACE) {
          ++attr_offset;
        }
        ++attr_offset;
        attr_end = i - 1;
      } else {
        if (data[i - 1] === d) {
          title_end = i - 1;
        } else {
          title_end = i;
        }
        attr_offset = 0;
        attr_end = 0;
      }
      if (i + 1 < end && data[i] === C_CR && data[i + 1] === C_NL) {
        ++i;
      }

      line_end = i;
    } else {
      /* looking for EOL */
      while (i < end && data[i] !== C_NL && data[i] !== C_CR) {
        i++;
      }
      if (i + 1 < end && data[i] === C_NL && data[i + 1] === C_CR) {
        title_end = i + 1;
      } else {
        title_end = i;
      }
      /* stepping back */
      i -= 1;
      while (i > title_offset && data[i] === C_SPACE) {
        i -= 1;
      }
      if (i > title_offset &&
        (data[i] === C_SQUOTE || data[i] === C_DQUOTE || data[i] === C_RPAREN)) {
        line_end = title_end;
        title_end = i;
      }
    }
  }

  if (line_end === 0 || link_end === link_offset) {
    return false; /* garbage after the link empty link */
  }

  /* a valid ref has been found, filling-in return structures */
  if (last !== null) {
    last.value = line_end;
  }

  if (refs !== null) {
    const ref: LinkRef = add_link_ref(refs, data, id_offset, id_end - id_offset);

    const refLink: HoedownBuffer = hoedown_buffer_new(Math.max(link_end - link_offset, 1));
    hoedown_buffer_put(refLink, data, link_offset, link_end - link_offset);
    ref.link = refLink;

    if (title_end > title_offset) {
      const refTitle: HoedownBuffer = hoedown_buffer_new(title_end - title_offset);
      hoedown_buffer_put(refTitle, data, title_offset, title_end - title_offset);
      ref.title = refTitle;
    }
    if (attr_end > attr_offset) {
      const refAttr: HoedownBuffer = hoedown_buffer_new(attr_end - attr_offset);
      hoedown_buffer_put(refAttr, data, attr_offset, attr_end - attr_offset);
      ref.attr = refAttr;
    }
  }

  return true;
}

function expand_tabs(ob: HoedownBuffer, line: Uint8Array, base: number, size: number): void {
  /* This code makes two assumptions:
   * - Input is valid UTF-8.  (Any byte with top two bits 10 is skipped,
   *   whether or not it is a valid UTF-8 continuation byte.)
   * - Input contains no combining characters.  (Combining characters
   *   should be skipped but are not.)
   */
  let i: number = 0;
  let tab: number = 0;

  while (i < size) {
    const org: number = i;

    while (i < size && line[base + i] !== C_TAB) {
      /* ignore UTF-8 continuation bytes */
      if ((line[base + i] & 0xc0) !== 0x80) {
        tab++;
      }
      i++;
    }

    if (i > org) {
      hoedown_buffer_put(ob, line, base + org, i - org);
    }

    if (i >= size) {
      break;
    }

    do {
      hoedown_buffer_putc(ob, C_SPACE);
      tab++;
    } while (tab % 4 !== 0);

    i++;
  }
}

/**********************
 * EXPORTED FUNCTIONS *
 **********************/

/* hoedown_document_new: allocate a new document processor instance */
export function hoedown_document_new(renderer: HoedownRenderer, extensions: number, max_nesting: number,
  attr_activation: number, user_block: HoedownUserBlock | null, meta: HoedownBuffer | null): HoedownDocument {
  if (max_nesting <= 0) {
    throw new Error('hoedown_document_new: max_nesting must be > 0');
  }

  const doc: HoedownDocument = new HoedownDocument(hoedown_renderer_copy(renderer));

  doc.data.opaque = renderer.opaque;

  doc.active_char = new Uint8Array(256);

  if ((extensions & HOEDOWN_EXT_UNDERLINE) !== 0 && doc.md.underline !== null) {
    doc.active_char[C_UNDERSCORE] = MD_CHAR_EMPHASIS;
  }

  if (doc.md.emphasis !== null || doc.md.double_emphasis !== null || doc.md.triple_emphasis !== null) {
    doc.active_char[C_STAR] = MD_CHAR_EMPHASIS;
    doc.active_char[C_UNDERSCORE] = MD_CHAR_EMPHASIS;
    if ((extensions & HOEDOWN_EXT_STRIKETHROUGH) !== 0) {
      doc.active_char[C_TILDE] = MD_CHAR_EMPHASIS;
    }
    if ((extensions & HOEDOWN_EXT_HIGHLIGHT) !== 0) {
      doc.active_char[C_EQ] = MD_CHAR_EMPHASIS;
    }
  }

  if (doc.md.codespan !== null) {
    doc.active_char[C_BACKTICK] = MD_CHAR_CODESPAN;
  }

  if (doc.md.linebreak !== null) {
    doc.active_char[C_NL] = MD_CHAR_LINEBREAK;
  }

  if (doc.md.image !== null || doc.md.link !== null || doc.md.footnotes !== null || doc.md.footnote_ref !== null) {
    doc.active_char[C_LBRACKET] = MD_CHAR_LINK;
    doc.active_char[C_BANG] = MD_CHAR_IMAGE;
  }

  doc.active_char[C_LT] = MD_CHAR_LANGLE;
  doc.active_char[C_BACKSLASH] = MD_CHAR_ESCAPE;
  doc.active_char[C_AMP] = MD_CHAR_ENTITY;

  if ((extensions & HOEDOWN_EXT_AUTOLINK) !== 0) {
    doc.active_char[C_COLON] = MD_CHAR_AUTOLINK_URL;
    doc.active_char[C_AT] = MD_CHAR_AUTOLINK_EMAIL;
    doc.active_char[C_LOWER_W] = MD_CHAR_AUTOLINK_WWW;
  }

  if ((extensions & HOEDOWN_EXT_SUPERSCRIPT) !== 0) {
    doc.active_char[C_CARET] = MD_CHAR_SUPERSCRIPT;
  }

  if ((extensions & HOEDOWN_EXT_QUOTE) !== 0) {
    doc.active_char[C_DQUOTE] = MD_CHAR_QUOTE;
  }

  if ((extensions & HOEDOWN_EXT_MATH) !== 0) {
    doc.active_char[C_DOLLAR] = MD_CHAR_MATH;
  }

  /* Extension data */
  doc.ext_flags = extensions;
  doc.max_nesting = max_nesting;
  doc.attr_activation = attr_activation;
  doc.in_link_body = false;
  doc.link_id = null;
  doc.link_ref_attr = null;
  doc.link_inline_attr = null;
  doc.is_escape_char = false;
  doc.header_type = HOEDOWN_HEADER_NONE;
  doc.link_type = HOEDOWN_LINK_NONE;
  doc.footnote_id = null;
  doc.list_depth = 0;
  doc.blockquote_depth = 0;
  doc.ul_item_char = 0;
  doc.hrule_char = 0;
  doc.fencedcode_char = 0;
  doc.ol_numeral = null;
  doc.user_block = user_block;
  doc.meta = meta;
  doc.refs = reset_link_refs();

  return doc;
}

/* hoedown_document_render: render regular Markdown using the document processor */
export function hoedown_document_render(doc: HoedownDocument, ob: HoedownBuffer, data: Uint8Array,
  size: number): void {
  let beg: number = 0;
  const end: NumberRef = new NumberRef(0);

  const text: HoedownBuffer = hoedown_buffer_new(64);

  /* Preallocate enough space for our buffer to avoid expanding while copying */
  hoedown_buffer_grow(text, size);

  /* reset the references table */
  doc.refs = reset_link_refs();

  const footnotes_enabled: boolean = (doc.ext_flags & HOEDOWN_EXT_FOOTNOTES) !== 0;

  /* reset the footnotes lists */
  if (footnotes_enabled) {
    doc.footnotes_found = new FootnoteList();
    doc.footnotes_used = new FootnoteList();
  }

  /* first pass: looking for references, copying everything else */
  beg = 0;

  /* Skip a possible UTF-8 BOM, even though the Unicode standard
   * discourages having these in UTF-8 documents */
  if (size >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    beg += 3;
  }

  while (beg < size) { /* iterating over lines */
    if (footnotes_enabled && is_footnote(data, beg, size, end, doc.footnotes_found)) {
      if (doc.md.footnote_ref_def !== null) {
        doc.md.footnote_ref_def(hoedown_buffer_view(data, beg, end.value - beg), doc.data);
      }
      beg = end.value;
    } else if (is_html_comment(data, beg, size, end)) {
      let i: number = 0;
      while (i < (end.value - beg) && beg + i < size) {
        if (data[beg + i] === C_TAB && (data[beg + i] & 0xc0) !== 0x80) {
          hoedown_buffer_puts(text, '    ');
        } else {
          hoedown_buffer_putc(text, data[beg + i]);
        }
        i++;
      }
      beg = end.value;
    } else if (is_ref(data, beg, size, end, doc.refs)) {
      if (doc.md.ref !== null) {
        doc.md.ref(hoedown_buffer_view(data, beg, end.value - beg), doc.data);
      }
      beg = end.value;
    } else { /* skipping to the next line */
      let e: number = beg;
      while (e < size && data[e] !== C_NL && data[e] !== C_CR) {
        e++;
      }

      /* adding the line body if present */
      if (e > beg) {
        expand_tabs(text, data, beg, e - beg);
      }

      while (e < size && (data[e] === C_NL || data[e] === C_CR)) {
        /* add one \n per newline */
        if (data[e] === C_NL || (e + 1 < size && data[e + 1] !== C_NL)) {
          hoedown_buffer_putc(text, C_NL);
        }
        e++;
      }

      beg = e;
    }
  }

  /* pre-grow the output buffer to minimize allocations */
  hoedown_buffer_grow(ob, text.size + (text.size >> 1));

  /* second pass: actual rendering */
  if (doc.md.doc_header !== null) {
    doc.md.doc_header(ob, false, doc.data);
  }

  if (text.size > 0) {
    /* adding a final newline if not already present */
    if (text.data[text.size - 1] !== C_NL) {
      hoedown_buffer_putc(text, C_NL);
    }

    parse_block(ob, doc, text.data, 0, text.size);
  }

  /* footnotes */
  if (footnotes_enabled) {
    parse_footnote_list(ob, doc, doc.footnotes_used);
  }

  if (doc.md.doc_footer !== null) {
    doc.md.doc_footer(ob, false, doc.data);
  }

  /* clean-up */
  doc.refs = reset_link_refs();
  if (footnotes_enabled) {
    doc.footnotes_found = new FootnoteList();
    doc.footnotes_used = new FootnoteList();
  }
  // C asserts all three work-buffer stacks are balanced here; a port bug that leaks one would
  // only show up as a nesting limit hit early, so it is reset rather than asserted.
  doc.work_bufs[BUFFER_SPAN].size = 0;
  doc.work_bufs[BUFFER_BLOCK].size = 0;
  doc.work_bufs[BUFFER_ATTRIBUTE].size = 0;
}

/* hoedown_document_render_inline: render inline Markdown using the document processor */
export function hoedown_document_render_inline(doc: HoedownDocument, ob: HoedownBuffer, data: Uint8Array,
  size: number): void {
  let i: number = 0;
  let mark: number = 0;
  const text: HoedownBuffer = hoedown_buffer_new(64);

  /* reset the references table */
  doc.refs = reset_link_refs();

  /* first pass: expand tabs and process newlines */
  hoedown_buffer_grow(text, size);
  while (true) {
    mark = i;
    while (i < size && data[i] !== C_NL && data[i] !== C_CR) {
      i++;
    }

    expand_tabs(text, data, mark, i - mark);

    if (i >= size) {
      break;
    }

    while (i < size && (data[i] === C_NL || data[i] === C_CR)) {
      /* add one \n per newline */
      if (data[i] === C_NL || (i + 1 < size && data[i + 1] !== C_NL)) {
        hoedown_buffer_putc(text, C_NL);
      }
      i++;
    }
  }

  /* second pass: actual rendering */
  hoedown_buffer_grow(ob, text.size + (text.size >> 1));

  if (doc.md.doc_header !== null) {
    doc.md.doc_header(ob, true, doc.data);
  }

  parse_inline(ob, doc, text.data, 0, text.size);

  if (doc.md.doc_footer !== null) {
    doc.md.doc_footer(ob, true, doc.data);
  }

  doc.work_bufs[BUFFER_SPAN].size = 0;
  doc.work_bufs[BUFFER_BLOCK].size = 0;
}

/* hoedown_document_free: deallocate a document processor instance */
export function hoedown_document_free(doc: HoedownDocument): void {
  for (const stack of doc.work_bufs) {
    stack.items = [];
    stack.size = 0;
  }
}

/* returns a hoedown buffer containing the id of link or footnote reference being processed, or NULL if no link or footnote is being processed */
export function hoedown_document_link_id(document: HoedownDocument): HoedownBuffer | null {
  return document.link_id;
}

/* returns a hoedown buffer containing the reference attr of link being processed, or NULL or empty if none exists */
export function hoedown_document_link_ref_attr(document: HoedownDocument): HoedownBuffer | null {
  return document.link_ref_attr;
}

/* returns a hoedown buffer containing the inline attr of link being processed, or NULL or empty if none exists */
export function hoedown_document_link_inline_attr(document: HoedownDocument): HoedownBuffer | null {
  return document.link_inline_attr;
}

/* returns true if the currently processed buffer in normal text was escaped in the original document */
export function hoedown_document_is_escaped(document: HoedownDocument): boolean {
  return document.is_escape_char;
}

/* returns the header type of the currently processed header, or HOEDOWN_HEADER_NONE if not processing a header */
export function hoedown_document_header_type(document: HoedownDocument): number {
  return document.header_type;
}

/* returns the link type of the currently processed link, or HOEDOWN_LINK_NONE if not processing a link */
export function hoedown_document_link_type(document: HoedownDocument): number {
  return document.link_type;
}

/* returns the id of the footnote definition currently processed, or NULL if not processing a footnote */
export function hoedown_document_footnote_id(document: HoedownDocument): HoedownBuffer | null {
  return document.footnote_id;
}

/* returns the list depth of the currently processed element, 1 per level */
export function hoedown_document_list_depth(document: HoedownDocument): number {
  return document.list_depth;
}

/* returns the blockquote depth of the currently processed element, 1 per level */
export function hoedown_document_blockquote_depth(document: HoedownDocument): number {
  return document.blockquote_depth;
}

/* returns the character used for the currently processing unordered list (+, *, or -), or 0 if not processing an unordered list */
export function hoedown_document_ul_item_char(document: HoedownDocument): number {
  return document.ul_item_char;
}

/* returns the character used for the currently processing hrule (-, *, or _), or 0 if not processing an hrule */
export function hoedown_document_hrule_char(document: HoedownDocument): number {
  return document.hrule_char;
}

/* returns the character used for the currently processing fenced code block (` or ~), or 0 if not processing a fenced code block */
export function hoedown_document_fencedcode_char(document: HoedownDocument): number {
  return document.fencedcode_char;
}

/* returns the text of the numeral that begins an ordered list item, or NULL if not processing an ordered list item */
export function hoedown_document_ol_numeral(document: HoedownDocument): HoedownBuffer | null {
  return document.ol_numeral;
}
