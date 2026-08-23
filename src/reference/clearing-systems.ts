/**
 * SWIFT national clearing system prefixes (used inside MT party fields as
 * `//FW021000021`) mapped onto ISO 20022
 * `ExternalClearingSystemIdentification1Code` values.
 *
 * This table is what lets the converter turn an opaque `//SC401234` line into
 * a properly structured `ClrSysMmbId/ClrSysId/Cd=GBDSC` + `MmbId=401234`.
 */
export interface ClearingSystem {
  /** SWIFT two letter prefix as it appears after `//`. */
  readonly swiftPrefix: string;
  /** ISO 20022 external clearing system identification code. */
  readonly isoCode: string;
  readonly name: string;
  /** Country the scheme belongs to, when it is a national scheme. */
  readonly country?: string;
  /** Expected member id shape, used for soft validation only. */
  readonly memberIdPattern?: RegExp;
}

export const CLEARING_SYSTEMS: readonly ClearingSystem[] = [
  { swiftPrefix: 'AT', isoCode: 'ATBLZ', name: 'Austrian Bankleitzahl', country: 'AT', memberIdPattern: /^\d{5}$/ },
  { swiftPrefix: 'AU', isoCode: 'AUBSB', name: 'Australian Bank State Branch', country: 'AU', memberIdPattern: /^\d{6}$/ },
  { swiftPrefix: 'BL', isoCode: 'DEBLZ', name: 'German Bankleitzahl', country: 'DE', memberIdPattern: /^\d{8}$/ },
  { swiftPrefix: 'CC', isoCode: 'CACPA', name: 'Canadian Payments Association routing number', country: 'CA', memberIdPattern: /^\d{9}$/ },
  { swiftPrefix: 'CH', isoCode: 'USCHU', name: 'CHIPS Universal Identifier', country: 'US', memberIdPattern: /^\d{6}$/ },
  { swiftPrefix: 'CN', isoCode: 'CNAPS', name: 'China National Advanced Payment System', country: 'CN' },
  { swiftPrefix: 'CP', isoCode: 'USPID', name: 'CHIPS Participant Identifier', country: 'US', memberIdPattern: /^\d{4}$/ },
  { swiftPrefix: 'ES', isoCode: 'ESNCC', name: 'Spanish domestic interbanking code', country: 'ES' },
  { swiftPrefix: 'FW', isoCode: 'USABA', name: 'Fedwire routing number', country: 'US', memberIdPattern: /^\d{9}$/ },
  { swiftPrefix: 'GR', isoCode: 'GRBIC', name: 'Hellenic Bank Identification Code', country: 'GR' },
  { swiftPrefix: 'HK', isoCode: 'HKNCC', name: 'Hong Kong bank code', country: 'HK', memberIdPattern: /^\d{3}$/ },
  { swiftPrefix: 'IE', isoCode: 'IENSC', name: 'Irish National Sort Code', country: 'IE', memberIdPattern: /^\d{6}$/ },
  { swiftPrefix: 'IN', isoCode: 'INFSC', name: 'Indian Financial System Code', country: 'IN' },
  { swiftPrefix: 'IT', isoCode: 'ITNCC', name: 'Italian domestic identification code', country: 'IT' },
  { swiftPrefix: 'PL', isoCode: 'PLKNR', name: 'Polish national clearing code', country: 'PL', memberIdPattern: /^\d{8}$/ },
  { swiftPrefix: 'PT', isoCode: 'PTNCC', name: 'Portuguese national clearing code', country: 'PT' },
  { swiftPrefix: 'RU', isoCode: 'RUCBC', name: 'Russian Central Bank identification code', country: 'RU', memberIdPattern: /^\d{9}$/ },
  { swiftPrefix: 'SC', isoCode: 'GBDSC', name: 'UK domestic sort code', country: 'GB', memberIdPattern: /^\d{6}$/ },
  { swiftPrefix: 'SL', isoCode: 'CHSIC', name: 'Swiss SIC code', country: 'CH', memberIdPattern: /^\d{6}$/ },
  { swiftPrefix: 'SW', isoCode: 'CHBCC', name: 'Swiss BC number', country: 'CH', memberIdPattern: /^\d{3,5}$/ },
  { swiftPrefix: 'ZA', isoCode: 'ZANCC', name: 'South African national clearing code', country: 'ZA', memberIdPattern: /^\d{6}$/ },
];

const BY_PREFIX = new Map(CLEARING_SYSTEMS.map((c) => [c.swiftPrefix, c]));

export function clearingSystemByPrefix(prefix: string): ClearingSystem | undefined {
  return BY_PREFIX.get(prefix.toUpperCase());
}

/** `//RT` is a routing instruction rather than a member identification. */
export const RTGS_PREFIX = 'RT';
