/** ISO 3166-1 alpha-2 country codes, used for address and IBAN validation. */
export const COUNTRY_CODES: ReadonlySet<string> = new Set([
  'AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AS','AT','AU','AW','AX','AZ',
  'BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ',
  'CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CU','CV','CW','CX','CY','CZ',
  'DE','DJ','DK','DM','DO','DZ',
  'EC','EE','EG','EH','ER','ES','ET',
  'FI','FJ','FK','FM','FO','FR',
  'GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY',
  'HK','HM','HN','HR','HT','HU',
  'ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT',
  'JE','JM','JO','JP',
  'KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ',
  'LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY',
  'MA','MC','MD','ME','MF','MG','MH','MK','ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ',
  'NA','NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ',
  'OM',
  'PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PW','PY',
  'QA',
  'RE','RO','RS','RU','RW',
  'SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SY','SZ',
  'TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ',
  'UA','UG','UM','US','UY','UZ',
  'VA','VC','VE','VG','VI','VN','VU',
  'WF','WS',
  'YE','YT',
  'ZA','ZM','ZW',
]);

export function isCountryCode(code: string): boolean {
  return COUNTRY_CODES.has(code.toUpperCase());
}

/**
 * Country names commonly written on the last line of an MT address block,
 * mapped to their ISO 3166-1 alpha-2 code. Used to lift a country out of an
 * unstructured address so it can populate `PstlAdr/Ctry`.
 */
export const COUNTRY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'ARGENTINA': 'AR', 'AUSTRALIA': 'AU', 'AUSTRIA': 'AT', 'BAHRAIN': 'BH',
  'BANGLADESH': 'BD', 'BELGIUM': 'BE', 'BRAZIL': 'BR', 'BULGARIA': 'BG',
  'CANADA': 'CA', 'CHILE': 'CL', 'CHINA': 'CN', 'COLOMBIA': 'CO',
  'CROATIA': 'HR', 'CYPRUS': 'CY', 'CZECH REPUBLIC': 'CZ', 'CZECHIA': 'CZ',
  'DENMARK': 'DK', 'EGYPT': 'EG', 'ESTONIA': 'EE', 'FINLAND': 'FI',
  'FRANCE': 'FR', 'GERMANY': 'DE', 'GREECE': 'GR', 'HONG KONG': 'HK',
  'HUNGARY': 'HU', 'ICELAND': 'IS', 'INDIA': 'IN', 'INDONESIA': 'ID',
  'IRELAND': 'IE', 'ISRAEL': 'IL', 'ITALY': 'IT', 'JAPAN': 'JP',
  'JORDAN': 'JO', 'KENYA': 'KE', 'KUWAIT': 'KW', 'LATVIA': 'LV',
  'LEBANON': 'LB', 'LITHUANIA': 'LT', 'LUXEMBOURG': 'LU', 'MALAYSIA': 'MY',
  'MALTA': 'MT', 'MEXICO': 'MX', 'MOROCCO': 'MA', 'NETHERLANDS': 'NL',
  'NEW ZEALAND': 'NZ', 'NIGERIA': 'NG', 'NORWAY': 'NO', 'OMAN': 'OM',
  'PAKISTAN': 'PK', 'PERU': 'PE', 'PHILIPPINES': 'PH', 'POLAND': 'PL',
  'PORTUGAL': 'PT', 'QATAR': 'QA', 'ROMANIA': 'RO', 'SAUDI ARABIA': 'SA',
  'SERBIA': 'RS', 'SINGAPORE': 'SG', 'SLOVAKIA': 'SK', 'SLOVENIA': 'SI',
  'SOUTH AFRICA': 'ZA', 'SOUTH KOREA': 'KR', 'KOREA': 'KR', 'SPAIN': 'ES',
  'SRI LANKA': 'LK', 'SWEDEN': 'SE', 'SWITZERLAND': 'CH', 'TAIWAN': 'TW',
  'THAILAND': 'TH', 'TUNISIA': 'TN', 'TURKEY': 'TR', 'TURKIYE': 'TR',
  'UAE': 'AE', 'UNITED ARAB EMIRATES': 'AE', 'UK': 'GB',
  'UNITED KINGDOM': 'GB', 'GREAT BRITAIN': 'GB', 'ENGLAND': 'GB',
  'USA': 'US', 'U.S.A.': 'US', 'UNITED STATES': 'US',
  'UNITED STATES OF AMERICA': 'US', 'URUGUAY': 'UY', 'VIETNAM': 'VN',
});

/** Resolve a free text country name or code to an ISO 3166-1 alpha-2 code. */
export function resolveCountry(text: string): string | undefined {
  const cleaned = text.trim().toUpperCase().replace(/[.,]+$/, '');
  if (cleaned.length === 2 && COUNTRY_CODES.has(cleaned)) return cleaned;
  return COUNTRY_NAMES[cleaned];
}
