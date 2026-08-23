import type { XmlElement } from '../mx/xml.js';
import type { MappingContext } from './context.js';

/** A mapper turns one MT message type (and variant) into one MX message body. */
export interface Mapper {
  /** MT message types this mapper accepts, e.g. `['103']`. */
  readonly mtTypes: readonly string[];
  /** Variant discriminator, e.g. `COV` or `STP`; undefined is the base variant. */
  readonly variant?: string;
  /** ISO 20022 message identifier produced, e.g. `pacs.008.001.08`. */
  readonly mxId: string;
  readonly description: string;
  /** Build the message root that goes inside `<Document>`. */
  map(context: MappingContext): XmlElement;
}
