/**
 * swift-mt-mx-converter
 *
 * An MT to ISO 20022 (MX) message converter with automatic message type
 * detection, semantic field resolution, validation on both sides of the
 * translation and a confidence score for every conversion.
 */

export { convert, formatReport } from './pipeline/converter.js';
export type { ConversionReport, ConvertOptions, CoverageReport } from './pipeline/converter.js';
export { convertBatch, splitMessages } from './pipeline/batch.js';
export type { BatchItem, BatchSummary } from './pipeline/batch.js';

export { parseMt } from './mt/parser.js';
export type { ParseResult } from './mt/parser.js';
export type { Block1, Block2, MtField, MtMessage } from './mt/message.js';
export { field, fieldByNumber, fieldsByNumber, hasField } from './mt/message.js';
export { matchPattern, compilePattern, extract, matches } from './mt/pattern.js';
export { FIELD_FORMATS, fieldFormat } from './mt/formats.js';
export { MT_SCHEMAS, schemaFor, supportedTypes, isSupportedType } from './mt/schemas.js';

export { detect, scoreCandidates } from './intelligence/detector.js';
export type { Detection, DetectionCandidate } from './intelligence/detector.js';
export { scoreConfidence } from './intelligence/confidence.js';
export type { ConfidenceBand, ConfidenceReport } from './intelligence/confidence.js';

export { MAPPERS, selectMapper, supportedConversions, isConvertible } from './mapping/registry.js';
export type { Mapper } from './mapping/mapper.js';
export { MappingContext } from './mapping/context.js';

export { resolveParty, inferGeography } from './semantic/party.js';
export type { SemanticParty, PartyKind } from './semantic/party.js';
export { parseAccountIdentification } from './semantic/account.js';
export type { AccountIdentification } from './semantic/account.js';
export { parseCurrencyAmount, parseValueDateAmount, swiftToIsoDecimal } from './semantic/amount.js';
export { parseStatementLine, parseBalance } from './semantic/statement.js';
export { parseNarrative, parseRegulatoryReporting } from './semantic/codes.js';

export { validateMt } from './validation/mt-rules.js';
export { validateMx } from './validation/mx-rules.js';
export { validateBic, isBic, toBic11 } from './validation/bic.js';
export { validateIban, looksLikeIban } from './validation/iban.js';

export { serialise, find, findAll, textOf, walk } from './mx/xml.js';
export type { XmlElement } from './mx/xml.js';
export { MX_DEFINITIONS, definitionFor } from './mx/documents.js';

export { resolveOptions, DEFAULT_BUSINESS_SERVICE } from './core/options.js';
export type { ConversionOptions, ResolvedOptions } from './core/options.js';
export { formatDiagnostic } from './core/diagnostics.js';
export type { Diagnostic, Severity } from './core/diagnostics.js';
export { deterministicUuid, isUetr } from './core/ids.js';

export { CURRENCY_MINOR_UNITS, isKnownCurrency, minorUnits } from './reference/currencies.js';
export { COUNTRY_CODES, isCountryCode, resolveCountry } from './reference/countries.js';
export { CLEARING_SYSTEMS, clearingSystemByPrefix } from './reference/clearing-systems.js';
