import type { Mapper } from './mapper.js';
import { mt103ToPacs008 } from './mappers/mt103-pacs008.js';
import { mt200ToPacs009, mt202CovToPacs009, mt202ToPacs009 } from './mappers/mt202-pacs009.js';
import { mt900ToCamt054, mt910ToCamt054 } from './mappers/mt9xx-camt054.js';
import { mt940ToCamt053, mt942ToCamt052 } from './mappers/mt940-camt053.js';
import { mt210ToCamt057 } from './mappers/mt210-camt057.js';
import { mt192ToCamt056, mt196ToCamt029 } from './mappers/mtn9x-exceptions.js';

/** Every mapper the converter knows about. */
export const MAPPERS: readonly Mapper[] = [
  mt103ToPacs008,
  mt202ToPacs009,
  mt202CovToPacs009,
  mt200ToPacs009,
  mt210ToCamt057,
  mt900ToCamt054,
  mt910ToCamt054,
  mt940ToCamt053,
  mt942ToCamt052,
  mt192ToCamt056,
  mt196ToCamt029,
];

/**
 * Pick the mapper for a message type and variant.
 *
 * A variant specific mapper wins; otherwise the base mapper for the type is
 * used, so an unrecognised variant still converts rather than failing.
 */
export function selectMapper(messageType: string, variant?: string): Mapper | undefined {
  if (variant) {
    const exact = MAPPERS.find((m) => m.mtTypes.includes(messageType) && m.variant === variant);
    if (exact) return exact;
  }
  return MAPPERS.find((m) => m.mtTypes.includes(messageType) && m.variant === undefined);
}

export interface SupportedConversion {
  readonly mt: string;
  readonly variant?: string;
  readonly mx: string;
  readonly description: string;
}

/** The conversion catalogue, used by the CLI and the API. */
export function supportedConversions(): SupportedConversion[] {
  return MAPPERS.flatMap((mapper) =>
    mapper.mtTypes.map((mt) => ({
      mt,
      ...(mapper.variant ? { variant: mapper.variant } : {}),
      mx: mapper.mxId,
      description: mapper.description,
    })),
  ).sort((a, b) => (a.mt === b.mt ? (a.variant ?? '').localeCompare(b.variant ?? '') : a.mt.localeCompare(b.mt)));
}

export function isConvertible(messageType: string, variant?: string): boolean {
  return selectMapper(messageType, variant) !== undefined;
}
