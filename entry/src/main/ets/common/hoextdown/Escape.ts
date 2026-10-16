// Port of Hoextdown escape.c / escape.h (External/Hoextdown). Pure logic, no UI.
import { HoedownBuffer, hoedown_buffer_put, hoedown_buffer_putc, hoedown_buffer_puts } from './Buffer';

/*
 * The following characters will not be escaped:
 *
 *		-_.+!*'(),%#@?=;:/,+&$ alphanum
 *
 * & (amp) and ' (single quote) are not in the table: they get HTML-entity escaping.
 * All other characters will be escaped to %XX.
 */
const HREF_SAFE: number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 1, 0, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1,
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0
  // 0x80..0xFF: 0
];

const HEX_CHARS: string = '0123456789ABCDEF';

function hrefSafe(c: number): boolean {
  return c < HREF_SAFE.length && HREF_SAFE[c] === 1;
}

/* hoedown_escape_href: escape (part of) a URL inside HTML */
export function hoedown_escape_href(ob: HoedownBuffer, data: Uint8Array, offset: number, size: number): void {
  let i: number = 0;
  let mark: number = 0;

  while (i < size) {
    mark = i;
    while (i < size && hrefSafe(data[offset + i])) {
      i++;
    }

    /* Optimization for cases where there's nothing to escape */
    if (mark === 0 && i >= size) {
      hoedown_buffer_put(ob, data, offset, size);
      return;
    }

    if (i > mark) {
      hoedown_buffer_put(ob, data, offset + mark, i - mark);
    }

    /* escaping */
    if (i >= size) {
      break;
    }

    const c: number = data[offset + i];
    if (c === 0x26) { /* '&' */
      hoedown_buffer_puts(ob, '&amp;');
    } else if (c === 0x27) { /* '\'' */
      hoedown_buffer_puts(ob, '&#x27;');
    } else {
      /* every other character goes with a %XX escaping */
      hoedown_buffer_putc(ob, 0x25);
      hoedown_buffer_putc(ob, HEX_CHARS.charCodeAt((c >> 4) & 0xf));
      hoedown_buffer_putc(ob, HEX_CHARS.charCodeAt(c & 0xf));
    }

    i++;
  }
}

/**
 * According to the OWASP rules:
 *
 * & --> &amp;
 * < --> &lt;
 * > --> &gt;
 * " --> &quot;
 * ' --> &#x27;     &apos; is not recommended
 * / --> &#x2F;     forward slash is included as it helps end an HTML entity
 */
function htmlEscapeIndex(c: number): number {
  switch (c) {
    case 0x22: return 1; /* " */
    case 0x26: return 2; /* & */
    case 0x27: return 3; /* ' */
    case 0x2f: return 4; /* / */
    case 0x3c: return 5; /* < */
    case 0x3e: return 6; /* > */
    default: return 0;
  }
}

const HTML_ESCAPES: string[] = [
  '',
  '&quot;',
  '&amp;',
  '&#39;',
  '&#47;',
  '&lt;',
  '&gt;'
];

/* hoedown_escape_html: escape HTML */
export function hoedown_escape_html(ob: HoedownBuffer, data: Uint8Array, offset: number, size: number,
  secure: boolean): void {
  let i: number = 0;
  let mark: number = 0;

  while (true) {
    mark = i;
    while (i < size && htmlEscapeIndex(data[offset + i]) === 0) {
      i++;
    }

    /* Optimization for cases where there's nothing to escape */
    if (mark === 0 && i >= size) {
      hoedown_buffer_put(ob, data, offset, size);
      return;
    }

    if (i > mark) {
      hoedown_buffer_put(ob, data, offset + mark, i - mark);
    }

    if (i >= size) {
      break;
    }

    /* The forward slash is only escaped in secure mode */
    if (!secure && data[offset + i] === 0x2f) {
      hoedown_buffer_putc(ob, 0x2f);
    } else {
      hoedown_buffer_puts(ob, HTML_ESCAPES[htmlEscapeIndex(data[offset + i])]);
    }

    i++;
  }
}
