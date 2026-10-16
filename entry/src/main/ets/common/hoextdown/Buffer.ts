// Port of Hoextdown buffer.c / buffer.h / stack.c (External/Hoextdown) plus the <ctype.h> /
// <string.h> primitives the C engine leans on. Pure logic, no UI.
//
// Pointer model: C passes `uint8_t *data` and indexes it relative to the pointer, including
// negative indexes (data[-1]). This port keeps the underlying byte array and passes an explicit
// base index instead, so `data[x]` in C is `data[base + x]` here. Reads past the logical size hit
// the same backing store the C code would read, which keeps the engine's behaviour byte-exact.
import { util } from '@kit.ArkTS';

/* hoedown_buffer: growable byte buffer. `data` is the backing store (capacity = asize). */
export class HoedownBuffer {
  data: Uint8Array = new Uint8Array(0);
  size: number = 0;
  asize: number = 0;
  unit: number = 0;

  constructor(unit: number) {
    this.unit = unit;
  }
}

/* A single out-parameter (`size_t *`, `uint8_t *`, `int *` in C). */
export class NumberRef {
  value: number = 0;

  constructor(value: number) {
    this.value = value;
  }
}

/* hoedown_buffer_new: allocate a new buffer */
export function hoedown_buffer_new(unit: number): HoedownBuffer {
  return new HoedownBuffer(unit);
}

/*
 * Read-only buffer that aliases bytes of another array — the C code's stack-built
 * `hoedown_buffer work = { data + i, size }`. unit 0 marks it read-only, as in C.
 */
export function hoedown_buffer_view(data: Uint8Array, offset: number, size: number): HoedownBuffer {
  const view: HoedownBuffer = new HoedownBuffer(0);
  view.data = offset === 0 ? data : data.subarray(offset);
  view.size = size;
  view.asize = 0;
  return view;
}

/* hoedown_buffer_free: free the buffer */
export function hoedown_buffer_free(buf: HoedownBuffer | null): void {
  if (buf === null) {
    return;
  }
  buf.data = new Uint8Array(0);
  buf.size = 0;
  buf.asize = 0;
}

/* hoedown_buffer_reset: free internal data of the buffer */
export function hoedown_buffer_reset(buf: HoedownBuffer): void {
  buf.data = new Uint8Array(0);
  buf.size = 0;
  buf.asize = 0;
}

/* hoedown_buffer_grow: increase the allocated size to the given value */
export function hoedown_buffer_grow(buf: HoedownBuffer, neosz: number): void {
  if (buf.asize >= neosz) {
    return;
  }
  const unit: number = buf.unit > 0 ? buf.unit : 64;
  let neoasz: number = buf.asize + unit;
  while (neoasz < neosz) {
    neoasz += unit;
  }
  const grown: Uint8Array = new Uint8Array(neoasz);
  if (buf.size > 0) {
    grown.set(buf.data.subarray(0, Math.min(buf.size, buf.data.length)), 0);
  }
  buf.data = grown;
  buf.asize = neoasz;
}

/* hoedown_buffer_put: append raw data to a buffer (src[offset .. offset+size)) */
export function hoedown_buffer_put(buf: HoedownBuffer, src: Uint8Array, offset: number, size: number): void {
  if (size <= 0) {
    return;
  }
  if (buf.size + size > buf.asize) {
    hoedown_buffer_grow(buf, buf.size + size);
  }
  // TypedArray.set clones the source first when it shares buf.data's storage, so aliasing is safe
  buf.data.set(src.subarray(offset, offset + size), buf.size);
  buf.size += size;
}

/* hoedown_buffer_puts: append a string (UTF-8 encoded) to a buffer */
export function hoedown_buffer_puts(buf: HoedownBuffer, str: string): void {
  let ascii: boolean = true;
  for (let k = 0; k < str.length; k++) {
    if (str.charCodeAt(k) >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (!ascii) {
    const bytes: Uint8Array = hoedown_utf8_encode(str);
    hoedown_buffer_put(buf, bytes, 0, bytes.length);
    return;
  }
  if (buf.size + str.length > buf.asize) {
    hoedown_buffer_grow(buf, buf.size + str.length);
  }
  for (let k = 0; k < str.length; k++) {
    buf.data[buf.size + k] = str.charCodeAt(k);
  }
  buf.size += str.length;
}

/* hoedown_buffer_putc: append a single char to a buffer */
export function hoedown_buffer_putc(buf: HoedownBuffer, c: number): void {
  if (buf.size >= buf.asize) {
    hoedown_buffer_grow(buf, buf.size + 1);
  }
  buf.data[buf.size] = c & 0xff;
  buf.size += 1;
}

/* hoedown_buffer_set: replace the buffer's contents with raw data */
export function hoedown_buffer_set(buf: HoedownBuffer, src: Uint8Array, offset: number, size: number): void {
  const copy: Uint8Array = src.slice(offset, offset + size); // src may be buf.data, which grow replaces
  if (size > buf.asize) {
    hoedown_buffer_grow(buf, size);
  }
  buf.data.set(copy, 0);
  buf.size = size;
}

/* hoedown_buffer_sets: replace the buffer's contents with a string */
export function hoedown_buffer_sets(buf: HoedownBuffer, str: string): void {
  const bytes: Uint8Array = hoedown_utf8_encode(str);
  hoedown_buffer_set(buf, bytes, 0, bytes.length);
}

/* hoedown_buffer_eq: compare a buffer's data with other data for equality */
export function hoedown_buffer_eq(buf: HoedownBuffer, src: Uint8Array, offset: number, size: number): boolean {
  if (buf.size !== size) {
    return false;
  }
  for (let k = 0; k < size; k++) {
    if (buf.data[k] !== src[offset + k]) {
      return false;
    }
  }
  return true;
}

/* hoedown_buffer_eqs: compare a buffer's data with a string for equality */
export function hoedown_buffer_eqs(buf: HoedownBuffer, str: string): boolean {
  const bytes: Uint8Array = hoedown_utf8_encode(str);
  return hoedown_buffer_eq(buf, bytes, 0, bytes.length);
}

/* hoedown_buffer_prefix: compare the beginning of a buffer with an ASCII string */
export function hoedown_buffer_prefix(buf: HoedownBuffer, prefix: string): number {
  for (let i = 0; i < buf.size; ++i) {
    if (i >= prefix.length) {
      return 0;
    }
    const p: number = prefix.charCodeAt(i);
    if (buf.data[i] !== p) {
      return buf.data[i] - p;
    }
  }
  return 0;
}

/* hoedown_buffer_slurp: remove a given number of bytes from the head of the buffer */
export function hoedown_buffer_slurp(buf: HoedownBuffer, size: number): void {
  if (size >= buf.size) {
    buf.size = 0;
    return;
  }
  buf.size -= size;
  buf.data.copyWithin(0, size, size + buf.size);
}

/* hoedown_buffer_cstr: the buffer's bytes decoded as a UTF-8 string */
export function hoedown_buffer_cstr(buf: HoedownBuffer): string {
  return hoedown_utf8_decode(buf.data, 0, buf.size);
}

/* hoedown_buffer_put_utf8: put a Unicode character encoded as UTF-8 */
export function hoedown_buffer_put_utf8(buf: HoedownBuffer, c: number): void {
  if (c < 0x80) {
    hoedown_buffer_putc(buf, c);
  } else if (c < 0x800) {
    hoedown_buffer_putc(buf, 192 + Math.floor(c / 64));
    hoedown_buffer_putc(buf, 128 + (c % 64));
  } else if (c - 0xd800 >= 0 && c - 0xd800 < 0x800) {
    hoedown_buffer_puts(buf, '�');
  } else if (c < 0x10000) {
    hoedown_buffer_putc(buf, 224 + Math.floor(c / 4096));
    hoedown_buffer_putc(buf, 128 + Math.floor(c / 64) % 64);
    hoedown_buffer_putc(buf, 128 + (c % 64));
  } else if (c < 0x110000) {
    hoedown_buffer_putc(buf, 240 + Math.floor(c / 262144));
    hoedown_buffer_putc(buf, 128 + Math.floor(c / 4096) % 64);
    hoedown_buffer_putc(buf, 128 + Math.floor(c / 64) % 64);
    hoedown_buffer_putc(buf, 128 + (c % 64));
  } else {
    hoedown_buffer_puts(buf, '�');
  }
}

/*************************
 * UTF-8 <-> string glue *
 *************************/

let encoder: util.TextEncoder | null = null;
let decoder: util.TextDecoder | null = null;

export function hoedown_utf8_encode(str: string): Uint8Array {
  // encodeInto('') / undefined yields undefined on device; an empty document is an empty buffer.
  if (str === undefined || str === null || str.length === 0) {
    return new Uint8Array(0);
  }
  if (encoder === null) {
    encoder = util.TextEncoder.create('utf-8');
  }
  return encoder.encodeInto(str);
}

export function hoedown_utf8_decode(data: Uint8Array, offset: number, size: number): string {
  if (size <= 0) {
    return '';
  }
  if (decoder === null) {
    const options: util.TextDecoderOptions = { ignoreBOM: true };
    decoder = util.TextDecoder.create('utf-8', options);
  }
  return decoder.decodeToString(data.slice(offset, offset + size));
}

/*********************************************************
 * <ctype.h> in the "C" locale — ASCII only, as in C      *
 *********************************************************/

export function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

export function isAlpha(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

export function isAlnum(c: number): boolean {
  return isAlpha(c) || isDigit(c);
}

export function isSpace(c: number): boolean {
  return c === 0x20 || (c >= 0x09 && c <= 0x0d);
}

export function isPunct(c: number): boolean {
  return (c >= 0x21 && c <= 0x2f) || (c >= 0x3a && c <= 0x40) ||
    (c >= 0x5b && c <= 0x60) || (c >= 0x7b && c <= 0x7e);
}

export function isAscii(c: number): boolean {
  return c >= 0 && c <= 0x7f;
}

export function toLower(c: number): number {
  return (c >= 0x41 && c <= 0x5a) ? c + 32 : c;
}

/*********************************************************
 * <string.h> primitives over (bytes, offset) vs a C literal
 *********************************************************/

/* strchr(set, c) != NULL — note strchr also finds the terminating NUL, so c == 0 matches */
export function strchrHas(set: string, c: number): boolean {
  if (c === 0) {
    return true;
  }
  for (let k = 0; k < set.length; k++) {
    if (set.charCodeAt(k) === c) {
      return true;
    }
  }
  return false;
}

/* strncasecmp(data + offset, literal, n) */
export function strncasecmpAt(data: Uint8Array, offset: number, literal: string, n: number): number {
  for (let k = 0; k < n; k++) {
    const c1: number = toLower(offset + k < data.length ? data[offset + k] : 0);
    const c2: number = k < literal.length ? toLower(literal.charCodeAt(k)) : 0;
    if (c1 !== c2) {
      return c1 - c2;
    }
    if (c1 === 0) {
      return 0;
    }
  }
  return 0;
}

/* strncmp(data + offset, literal, n) */
export function strncmpAt(data: Uint8Array, offset: number, literal: string, n: number): number {
  for (let k = 0; k < n; k++) {
    const c1: number = offset + k < data.length ? data[offset + k] : 0;
    const c2: number = k < literal.length ? literal.charCodeAt(k) : 0;
    if (c1 !== c2) {
      return c1 - c2;
    }
    if (c1 === 0) {
      return 0;
    }
  }
  return 0;
}

/* memcmp(data + offset, literal, literal.length) == 0 */
export function memeqAt(data: Uint8Array, offset: number, literal: string): boolean {
  for (let k = 0; k < literal.length; k++) {
    if (data[offset + k] !== literal.charCodeAt(k)) {
      return false;
    }
  }
  return true;
}

/* memchr(data + offset, c, len): index relative to offset, or -1 */
export function memchrAt(data: Uint8Array, offset: number, c: number, len: number): number {
  for (let k = 0; k < len; k++) {
    if (data[offset + k] === c) {
      return k;
    }
  }
  return -1;
}
