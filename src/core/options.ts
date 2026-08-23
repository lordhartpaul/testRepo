/** Options that steer a conversion. Every field has a documented default. */
export interface ConversionOptions {
  /**
   * How to render a postal address that came from unstructured MT lines.
   *  - `hybrid` (default): ISO country code plus the original address lines.
   *  - `unstructured`: address lines only.
   *  - `structured`: attempt town, post code and country as separate elements.
   */
  readonly addressFormat?: 'hybrid' | 'unstructured' | 'structured';
  /** Wrap the document in a business message envelope with a head.001 header. */
  readonly envelope?: 'document' | 'business-message';
  /** ISO 8601 timestamp used for creation dates; fixed input gives fixed output. */
  readonly now?: string;
  /** What to do when the source has no UETR in `{3:{121:}}`. */
  readonly uetr?: 'derive' | 'omit';
  /** Year used to resolve two digit years; defaults to the current year. */
  readonly referenceYear?: number;
  /** Pretty print the XML. */
  readonly pretty?: boolean;
  /** Treat warnings as blocking. */
  readonly strict?: boolean;
  /** Override the target MX message identifier for a given MT type. */
  readonly targets?: Readonly<Record<string, string>>;
  /** Business service written into the business application header. */
  readonly businessService?: string;
}

export interface ResolvedOptions {
  readonly addressFormat: 'hybrid' | 'unstructured' | 'structured';
  readonly envelope: 'document' | 'business-message';
  readonly now: string;
  readonly uetr: 'derive' | 'omit';
  readonly referenceYear: number;
  readonly pretty: boolean;
  readonly strict: boolean;
  readonly targets: Readonly<Record<string, string>>;
  readonly businessService?: string;
}

export const DEFAULT_BUSINESS_SERVICE = 'swift.cbprplus.02';

export function resolveOptions(options: ConversionOptions = {}): ResolvedOptions {
  return {
    addressFormat: options.addressFormat ?? 'hybrid',
    envelope: options.envelope ?? 'business-message',
    now: options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    uetr: options.uetr ?? 'derive',
    referenceYear: options.referenceYear ?? new Date().getUTCFullYear(),
    pretty: options.pretty ?? true,
    strict: options.strict ?? false,
    targets: options.targets ?? {},
    ...(options.businessService ? { businessService: options.businessService } : {}),
  };
}
