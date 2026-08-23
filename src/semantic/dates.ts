/**
 * SWIFT dates are written as `YYMMDD` (or `YYYYMMDD`) and times as `HHMM`.
 * ISO 20022 wants ISO 8601, so every date crosses this module on its way out.
 */

export interface DateResolutionOptions {
  /**
   * Year used to place a two digit year on the calendar. A two digit year is
   * resolved to whichever century puts it closest to this reference, so `98`
   * reads as 1998 and `27` as 2027 rather than being cut at a fixed pivot.
   */
  readonly referenceYear?: number;
}

export function resolveTwoDigitYear(yy: number, options: DateResolutionOptions = {}): number {
  const reference = options.referenceYear ?? new Date().getUTCFullYear();
  const century = Math.floor(reference / 100) * 100;
  const candidates = [century - 100 + yy, century + yy, century + 100 + yy];
  return candidates.reduce((best, candidate) =>
    Math.abs(candidate - reference) < Math.abs(best - reference) ? candidate : best,
  );
}

/** `240115` -> `2024-01-15`. Returns undefined when the date is not a real day. */
export function parseDate6(value: string, options: DateResolutionOptions = {}): string | undefined {
  const match = /^(\d{2})(\d{2})(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const year = resolveTwoDigitYear(Number(match[1]), options);
  return buildIsoDate(year, Number(match[2]), Number(match[3]));
}

/** `0115` -> `01-15`, used by the MMDD form in field 61. */
export function parseMonthDay(value: string, year: number): string | undefined {
  const match = /^(\d{2})(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  return buildIsoDate(year, Number(match[1]), Number(match[2]));
}

/** `1230` -> `12:30:00`. */
export function parseTime4(value: string): string | undefined {
  const match = /^(\d{2})(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return `${pad(hours)}:${pad(minutes)}:00`;
}

/** Combine an ISO date and time into an ISO 8601 date-time with an offset. */
export function isoDateTime(date: string, time = '00:00:00', offset = 'Z'): string {
  return `${date}T${time}${offset}`;
}

/**
 * Turn an MT time offset (`1200+0100`, as carried in field 13C) into the
 * `+01:00` form ISO 20022 expects.
 */
export function parseUtcOffset(sign: string, offset: string): string | undefined {
  const match = /^(\d{2})(\d{2})$/.exec(offset);
  if (!match || (sign !== '+' && sign !== '-')) return undefined;
  return `${sign}${match[1]}:${match[2]}`;
}

function buildIsoDate(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
