import { createHash } from 'node:crypto';

/**
 * Identifier helpers.
 *
 * Conversions must be reproducible: reprocessing the same MT has to yield the
 * same MX, otherwise duplicate detection downstream breaks. Every generated
 * identifier is therefore derived from the message content by hashing rather
 * than drawn from a random source.
 */

const UETR_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A UETR is a version 4 UUID in lower case (SWIFT gpi requirement). */
export function isUetr(value: string): boolean {
  return UETR_PATTERN.test(value.trim());
}

/**
 * Derive a version 4 shaped UUID from `seed`.
 *
 * The value is not random, but it carries the version and variant bits a UUIDv4
 * must have, and the same seed always produces the same identifier.
 */
export function deterministicUuid(seed: string): string {
  const digest = createHash('sha256').update(seed).digest();
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Make a value safe for an ISO 20022 identifier element: the restricted
 * character set forbids leading/trailing spaces and consecutive blanks.
 */
export function sanitiseId(value: string, max = 35): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}
