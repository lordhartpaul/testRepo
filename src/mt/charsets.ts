/**
 * SWIFT FIN character sets. The regex bodies below are inserted verbatim into
 * character classes, so `-` is always last and `\` / `]` / `^` are escaped.
 */
export type CharsetCode = 'n' | 'a' | 'c' | 'x' | 'y' | 'z' | 'd' | 'e' | 'h';

export const CHARSET_BODY: Readonly<Record<CharsetCode, string>> = Object.freeze({
  /** Digits. */
  n: '0-9',
  /** Uppercase letters. */
  a: 'A-Z',
  /** Uppercase alphanumeric. */
  c: 'A-Z0-9',
  /** SWIFT X character set (the general purpose set used by most text fields). */
  x: "A-Za-z0-9/?:().,'+ \\-",
  /** SWIFT Y character set (EDIFACT level A). */
  y: "A-Z0-9.,()/='+:?!\"%&*<>; \\-",
  /** SWIFT Z character set: X plus the extra characters allowed in narratives. */
  z: "A-Za-z0-9/?:().,'+{}@#=!\"%&*<>;_ \\-",
  /** Decimal digits; the comma is handled by the decimal token, not the class. */
  d: '0-9',
  /** Blank. */
  e: ' ',
  /** Uppercase hexadecimal. */
  h: '0-9A-F',
});

export function isCharsetCode(value: string): value is CharsetCode {
  return Object.prototype.hasOwnProperty.call(CHARSET_BODY, value);
}

/** True when every character of `value` belongs to `charset`. */
export function conformsTo(value: string, charset: CharsetCode): boolean {
  return new RegExp(`^[${CHARSET_BODY[charset]}]*$`).test(value);
}

/**
 * Strip characters that are illegal in the SWIFT X set, which is what MX text
 * has to be squeezed through when a value travels back towards FIN.
 */
export function sanitiseToX(value: string): string {
  return value.replace(new RegExp(`[^${CHARSET_BODY.x}]`, 'g'), ' ');
}
