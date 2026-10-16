// Port of Hoextdown autolink.c / autolink.h (External/Hoextdown). Pure logic, no UI.
// `data[base + x]` here is `data[x]` in C (negative x included — see Buffer.ts).
import {
  HoedownBuffer,
  NumberRef,
  hoedown_buffer_put,
  isAlnum,
  isAlpha,
  isPunct,
  isSpace,
  memeqAt,
  strchrHas,
  strncasecmpAt
} from './Buffer';

/* hoedown_autolink_flags */
export const HOEDOWN_AUTOLINK_SHORT_DOMAINS: number = (1 << 0);

const VALID_URIS: string[] = ['http://', 'https://', '/', '#', 'ftp://', 'mailto:'];

/* hoedown_autolink_is_safe: verify that a URL has a safe protocol */
export function hoedown_autolink_is_safe(data: Uint8Array, base: number, size: number): boolean {
  for (let i = 0; i < VALID_URIS.length; ++i) {
    const len: number = VALID_URIS[i].length;

    if (size > len &&
      strncasecmpAt(data, base, VALID_URIS[i], len) === 0 &&
      isAlnum(data[base + len])) {
      return true;
    }
  }

  return false;
}

function autolink_delim(data: Uint8Array, base: number, linkEnd: number, maxRewind: number, size: number): number {
  let link_end: number = linkEnd;
  let cclose: number = 0;
  let copen: number = 0;

  for (let i = 0; i < link_end; ++i) {
    if (data[base + i] === 0x3c) { /* '<' */
      link_end = i;
      break;
    }
  }

  while (link_end > 0) {
    if (strchrHas('?!.,:', data[base + link_end - 1])) {
      link_end--;
    } else if (data[base + link_end - 1] === 0x3b) { /* ';' */
      let new_end: number = link_end - 2;

      while (new_end > 0 && isAlpha(data[base + new_end])) {
        new_end--;
      }

      if (new_end < link_end - 2 && data[base + new_end] === 0x26) { /* '&' */
        link_end = new_end;
      } else {
        link_end--;
      }
    } else {
      break;
    }
  }

  if (link_end === 0) {
    return 0;
  }

  cclose = data[base + link_end - 1];

  switch (cclose) {
    case 0x22: copen = 0x22; break; /* " */
    case 0x27: copen = 0x27; break; /* ' */
    case 0x29: copen = 0x28; break; /* ) ( */
    case 0x5d: copen = 0x5b; break; /* ] [ */
    case 0x7d: copen = 0x7b; break; /* } { */
    default: break;
  }

  if (copen !== 0) {
    let closing: number = 0;
    let opening: number = 0;
    let i: number = 0;

    /* Try to close the final punctuation sign in this same line;
     * if we managed to close it outside of the URL, that means that it's
     * not part of the URL. If it closes inside the URL, that means it
     * is part of the URL.
     *
     *	foo http://www.pokemon.com/Pikachu_(Electric) bar
     *		=> http://www.pokemon.com/Pikachu_(Electric)
     *	foo (http://www.pokemon.com/Pikachu_(Electric)) bar
     *		=> http://www.pokemon.com/Pikachu_(Electric)
     *	foo http://www.pokemon.com/Pikachu_(Electric)) bar
     *		=> http://www.pokemon.com/Pikachu_(Electric))
     *	(foo http://www.pokemon.com/Pikachu_(Electric)) bar
     *		=> foo http://www.pokemon.com/Pikachu_(Electric)
     */
    while (i < link_end) {
      if (data[base + i] === copen) {
        opening++;
      } else if (data[base + i] === cclose) {
        closing++;
      }
      i++;
    }

    if (closing !== opening) {
      link_end--;
    }
  }

  return link_end;
}

function check_domain(data: Uint8Array, base: number, size: number, allowShort: boolean): number {
  let i: number = 1;
  let np: number = 0;

  if (!isAlnum(data[base])) {
    return 0;
  }

  for (i = 1; i < size - 1; ++i) {
    if (strchrHas('.:', data[base + i])) {
      np++;
    } else if (!isAlnum(data[base + i]) && data[base + i] !== 0x2d) { /* '-' */
      break;
    }
  }

  if (allowShort) {
    /* We don't need a valid domain in the strict sense (with
     * least one dot; so just make sure it's composed of valid
     * domain characters and return the length of the the valid
     * sequence. */
    return i;
  } else {
    /* a valid domain needs to have at least a dot.
     * that's as far as we get */
    return np > 0 ? i : 0;
  }
}

/* hoedown_autolink__www: search for the next www link in data */
export function hoedown_autolink__www(rewind_p: NumberRef, link: HoedownBuffer, data: Uint8Array, base: number,
  max_rewind: number, size: number, flags: number): number {
  let link_end: number = 0;

  if (max_rewind > 0 && !isPunct(data[base - 1]) && !isSpace(data[base - 1])) {
    return 0;
  }

  if (size < 4 || !memeqAt(data, base, 'www.')) {
    return 0;
  }

  link_end = check_domain(data, base, size, false);

  if (link_end === 0) {
    return 0;
  }

  while (link_end < size && !isSpace(data[base + link_end])) {
    link_end++;
  }

  link_end = autolink_delim(data, base, link_end, max_rewind, size);

  if (link_end === 0) {
    return 0;
  }

  hoedown_buffer_put(link, data, base, link_end);
  rewind_p.value = 0;

  return link_end;
}

/* hoedown_autolink__email: search for the next email in data */
export function hoedown_autolink__email(rewind_p: NumberRef, link: HoedownBuffer, data: Uint8Array, base: number,
  max_rewind: number, size: number, flags: number): number {
  let link_end: number = 0;
  let rewind: number = 0;
  let nb: number = 0;
  let np: number = 0;

  for (rewind = 0; rewind < max_rewind; ++rewind) {
    const c: number = data[base - 1 - rewind];

    if (isAlnum(c)) {
      continue;
    }

    if (strchrHas('.+-_', c)) {
      continue;
    }

    break;
  }

  if (rewind === 0) {
    return 0;
  }

  for (link_end = 0; link_end < size; ++link_end) {
    const c: number = data[base + link_end];

    if (isAlnum(c)) {
      continue;
    }

    if (c === 0x40) { /* '@' */
      nb++;
    } else if (c === 0x2e && link_end < size - 1) { /* '.' */
      np++;
    } else if (c !== 0x2d && c !== 0x5f) { /* '-' '_' */
      break;
    }
  }

  if (link_end < 2 || nb !== 1 || np === 0 ||
    !isAlpha(data[base + link_end - 1])) {
    return 0;
  }

  link_end = autolink_delim(data, base, link_end, max_rewind, size);

  if (link_end === 0) {
    return 0;
  }

  hoedown_buffer_put(link, data, base - rewind, link_end + rewind);
  rewind_p.value = rewind;

  return link_end;
}

/* hoedown_autolink__url: search for the next URL in data */
export function hoedown_autolink__url(rewind_p: NumberRef, link: HoedownBuffer, data: Uint8Array, base: number,
  max_rewind: number, size: number, flags: number): number {
  let link_end: number = 0;
  let rewind: number = 0;
  let domain_len: number = 0;

  if (size < 4 || data[base + 1] !== 0x2f || data[base + 2] !== 0x2f) {
    return 0;
  }

  while (rewind < max_rewind && isAlpha(data[base - 1 - rewind])) {
    rewind++;
  }

  if (!hoedown_autolink_is_safe(data, base - rewind, size + rewind)) {
    return 0;
  }

  link_end = 3; /* strlen("://") */

  domain_len = check_domain(
    data,
    base + link_end,
    size - link_end,
    (flags & HOEDOWN_AUTOLINK_SHORT_DOMAINS) !== 0);

  if (domain_len === 0) {
    return 0;
  }

  link_end += domain_len;
  while (link_end < size && !isSpace(data[base + link_end])) {
    link_end++;
  }

  link_end = autolink_delim(data, base, link_end, max_rewind, size);

  if (link_end === 0) {
    return 0;
  }

  hoedown_buffer_put(link, data, base - rewind, link_end + rewind);
  rewind_p.value = rewind;

  return link_end;
}
