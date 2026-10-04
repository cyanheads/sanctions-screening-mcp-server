/**
 * @fileoverview Published country names → ISO 3166-1 alpha-2 codes. Sanctions
 * lists name an identifier's issuing country in their own spelling (OFAC
 * `Korea, North`, the EU's `IRAN (ISLAMIC REPUBLIC OF)`), while GLEIF publishes a
 * legal jurisdiction as a code (`RU`, `US-DE`); the entity cross-reference
 * compares the two through this table. A static table rather than
 * `Intl.DisplayNames`, whose names change with the runtime's ICU data
 * (`Turkey` → `Türkiye`) and whose deprecated codes outrank current ones when
 * iterated (`Germany` → `DD`, `Russia` → `SU`).
 * @module services/screening/country-codes
 */

/**
 * Every ISO 3166-1 alpha-2 code (plus `XK`, which GLEIF uses for Kosovo) with
 * the English names a list publishes it under: the ISO short name, its common
 * form, and each list spelling the cross-reference has met on a published
 * identifier.
 */
const COUNTRY_NAMES: Readonly<Record<string, readonly string[]>> = {
  AD: ['Andorra'],
  AE: ['United Arab Emirates', 'UAE'],
  AF: ['Afghanistan'],
  AG: ['Antigua and Barbuda'],
  AI: ['Anguilla'],
  AL: ['Albania'],
  AM: ['Armenia'],
  AO: ['Angola'],
  AQ: ['Antarctica'],
  AR: ['Argentina'],
  AS: ['American Samoa'],
  AT: ['Austria'],
  AU: ['Australia'],
  AW: ['Aruba'],
  AX: ['Aland Islands'],
  AZ: ['Azerbaijan'],
  BA: ['Bosnia and Herzegovina', 'Bosnia and Herzegowina'],
  BB: ['Barbados'],
  BD: ['Bangladesh'],
  BE: ['Belgium'],
  BF: ['Burkina Faso'],
  BG: ['Bulgaria'],
  BH: ['Bahrain'],
  BI: ['Burundi'],
  BJ: ['Benin'],
  BL: ['Saint Barthelemy'],
  BM: ['Bermuda'],
  BN: ['Brunei', 'Brunei Darussalam'],
  BO: ['Bolivia', 'Bolivia (Plurinational State of)'],
  BQ: ['Bonaire, Sint Eustatius and Saba', 'Caribbean Netherlands'],
  BR: ['Brazil'],
  BS: ['Bahamas', 'Bahamas, The'],
  BT: ['Bhutan'],
  BV: ['Bouvet Island'],
  BW: ['Botswana'],
  BY: ['Belarus'],
  BZ: ['Belize'],
  CA: ['Canada'],
  CC: ['Cocos (Keeling) Islands'],
  CD: [
    'Democratic Republic of the Congo',
    'Congo, Democratic Republic of the',
    'Congo, Democratic Republic of (was Zaire)',
    'Congo (Kinshasa)',
  ],
  CF: ['Central African Republic'],
  CG: ['Congo', 'Republic of the Congo', 'Congo, Republic of the', 'Congo (Brazzaville)'],
  CH: ['Switzerland'],
  CI: ["Cote d'Ivoire", 'Ivory Coast'],
  CK: ['Cook Islands'],
  CL: ['Chile'],
  CM: ['Cameroon'],
  CN: ['China', "People's Republic of China"],
  CO: ['Colombia'],
  CR: ['Costa Rica'],
  CU: ['Cuba'],
  CV: ['Cabo Verde', 'Cape Verde'],
  CW: ['Curacao'],
  CX: ['Christmas Island'],
  CY: ['Cyprus'],
  CZ: ['Czechia', 'Czech Republic'],
  DE: ['Germany'],
  DJ: ['Djibouti'],
  DK: ['Denmark'],
  DM: ['Dominica'],
  DO: ['Dominican Republic'],
  DZ: ['Algeria'],
  EC: ['Ecuador'],
  EE: ['Estonia'],
  EG: ['Egypt'],
  EH: ['Western Sahara'],
  ER: ['Eritrea'],
  ES: ['Spain'],
  ET: ['Ethiopia'],
  FI: ['Finland'],
  FJ: ['Fiji'],
  FK: ['Falkland Islands', 'Falkland Islands (Malvinas)'],
  FM: ['Micronesia', 'Micronesia, Federated States of'],
  FO: ['Faroe Islands'],
  FR: ['France'],
  GA: ['Gabon'],
  GB: ['United Kingdom', 'United Kingdom of Great Britain and Northern Ireland', 'Great Britain'],
  GD: ['Grenada'],
  GE: ['Georgia'],
  GF: ['French Guiana'],
  GG: ['Guernsey'],
  GH: ['Ghana'],
  GI: ['Gibraltar'],
  GL: ['Greenland'],
  GM: ['Gambia', 'Gambia, The', 'The Gambia'],
  GN: ['Guinea'],
  GP: ['Guadeloupe'],
  GQ: ['Equatorial Guinea'],
  GR: ['Greece'],
  GS: ['South Georgia and the South Sandwich Islands'],
  GT: ['Guatemala'],
  GU: ['Guam'],
  GW: ['Guinea-Bissau'],
  GY: ['Guyana'],
  HK: ['Hong Kong'],
  HM: ['Heard Island and McDonald Islands'],
  HN: ['Honduras'],
  HR: ['Croatia'],
  HT: ['Haiti'],
  HU: ['Hungary'],
  ID: ['Indonesia'],
  IE: ['Ireland'],
  IL: ['Israel'],
  IM: ['Isle of Man', 'Man, Isle of'],
  IN: ['India'],
  IO: ['British Indian Ocean Territory'],
  IQ: ['Iraq'],
  IR: ['Iran', 'Iran (Islamic Republic of)'],
  IS: ['Iceland'],
  IT: ['Italy'],
  JE: ['Jersey'],
  JM: ['Jamaica'],
  JO: ['Jordan'],
  JP: ['Japan'],
  KE: ['Kenya'],
  KG: ['Kyrgyzstan'],
  KH: ['Cambodia'],
  KI: ['Kiribati'],
  KM: ['Comoros'],
  KN: ['Saint Kitts and Nevis'],
  KP: [
    'North Korea',
    'Korea, North',
    "Korea, Democratic People's Republic of",
    "Democratic People's Republic of Korea",
  ],
  KR: ['South Korea', 'Korea, South', 'Korea, Republic of', 'Republic of Korea'],
  KW: ['Kuwait'],
  KY: ['Cayman Islands'],
  KZ: ['Kazakhstan'],
  LA: ['Laos', "Lao People's Democratic Republic"],
  LB: ['Lebanon'],
  LC: ['Saint Lucia'],
  LI: ['Liechtenstein'],
  LK: ['Sri Lanka'],
  LR: ['Liberia'],
  LS: ['Lesotho'],
  LT: ['Lithuania'],
  LU: ['Luxembourg'],
  LV: ['Latvia'],
  LY: ['Libya'],
  MA: ['Morocco'],
  MC: ['Monaco'],
  MD: ['Moldova', 'Moldova, Republic of', 'Republic of Moldova'],
  ME: ['Montenegro'],
  MF: ['Saint Martin', 'Saint Martin (French part)'],
  MG: ['Madagascar'],
  MH: ['Marshall Islands'],
  MK: [
    'North Macedonia',
    'North Macedonia, The Republic of',
    'Republic of North Macedonia',
    'Macedonia',
  ],
  ML: ['Mali'],
  MM: ['Myanmar', 'Burma'],
  MN: ['Mongolia'],
  MO: ['Macao', 'Macau'],
  MP: ['Northern Mariana Islands'],
  MQ: ['Martinique'],
  MR: ['Mauritania'],
  MS: ['Montserrat'],
  MT: ['Malta'],
  MU: ['Mauritius'],
  MV: ['Maldives'],
  MW: ['Malawi'],
  MX: ['Mexico'],
  MY: ['Malaysia'],
  MZ: ['Mozambique'],
  NA: ['Namibia'],
  NC: ['New Caledonia'],
  NE: ['Niger'],
  NF: ['Norfolk Island'],
  NG: ['Nigeria'],
  NI: ['Nicaragua'],
  NL: ['Netherlands', 'Netherlands, The', 'The Netherlands'],
  NO: ['Norway'],
  NP: ['Nepal'],
  NR: ['Nauru'],
  NU: ['Niue'],
  NZ: ['New Zealand'],
  OM: ['Oman'],
  PA: ['Panama'],
  PE: ['Peru'],
  PF: ['French Polynesia'],
  PG: ['Papua New Guinea'],
  PH: ['Philippines'],
  PK: ['Pakistan'],
  PL: ['Poland'],
  PM: ['Saint Pierre and Miquelon'],
  PN: ['Pitcairn'],
  PR: ['Puerto Rico'],
  PS: [
    'Palestine',
    'Palestinian',
    'Palestine, State of',
    'State of Palestine',
    'Palestinian Territory, Occupied',
  ],
  PT: ['Portugal'],
  PW: ['Palau'],
  PY: ['Paraguay'],
  QA: ['Qatar'],
  RE: ['Reunion'],
  RO: ['Romania'],
  RS: ['Serbia'],
  RU: ['Russia', 'Russian Federation'],
  RW: ['Rwanda'],
  SA: ['Saudi Arabia'],
  SB: ['Solomon Islands'],
  SC: ['Seychelles'],
  SD: ['Sudan'],
  SE: ['Sweden'],
  SG: ['Singapore'],
  SH: ['Saint Helena', 'Saint Helena, Ascension and Tristan da Cunha'],
  SI: ['Slovenia'],
  SJ: ['Svalbard and Jan Mayen'],
  SK: ['Slovakia'],
  SL: ['Sierra Leone'],
  SM: ['San Marino'],
  SN: ['Senegal'],
  SO: ['Somalia'],
  SR: ['Suriname'],
  SS: ['South Sudan'],
  ST: ['Sao Tome and Principe'],
  SV: ['El Salvador'],
  SX: ['Sint Maarten', 'Sint Maarten (Dutch part)'],
  SY: ['Syria', 'Syrian Arab Republic'],
  SZ: ['Eswatini', 'Swaziland'],
  TC: ['Turks and Caicos Islands'],
  TD: ['Chad'],
  TF: ['French Southern Territories'],
  TG: ['Togo'],
  TH: ['Thailand'],
  TJ: ['Tajikistan'],
  TK: ['Tokelau'],
  TL: ['Timor-Leste', 'East Timor'],
  TM: ['Turkmenistan'],
  TN: ['Tunisia'],
  TO: ['Tonga'],
  TR: ['Turkey', 'Turkiye'],
  TT: ['Trinidad and Tobago'],
  TV: ['Tuvalu'],
  TW: ['Taiwan', 'Taiwan, Province of China'],
  TZ: ['Tanzania', 'Tanzania, United Republic of', 'United Republic of Tanzania'],
  UA: ['Ukraine'],
  UG: ['Uganda'],
  UM: ['United States Minor Outlying Islands'],
  US: ['United States', 'United States of America', 'USA'],
  UY: ['Uruguay'],
  UZ: ['Uzbekistan'],
  VA: ['Holy See', 'Vatican City', 'Holy See (Vatican City State)'],
  VC: ['Saint Vincent and the Grenadines'],
  VE: ['Venezuela', 'Venezuela (Bolivarian Republic of)'],
  VG: ['Virgin Islands, British', 'British Virgin Islands'],
  VI: ['Virgin Islands, U.S.', 'United States Virgin Islands'],
  VN: ['Vietnam', 'Viet Nam'],
  VU: ['Vanuatu'],
  WF: ['Wallis and Futuna'],
  WS: ['Samoa'],
  XK: ['Kosovo'],
  YE: ['Yemen'],
  YT: ['Mayotte'],
  ZA: ['South Africa'],
  ZM: ['Zambia'],
  ZW: ['Zimbabwe'],
};

const COMBINING_MARKS = /\p{M}/gu;

/**
 * A country name reduced to its letters: marks dropped, `&` read as `and`,
 * lowercase, and every character but `a`–`z` removed, so `IRAN (ISLAMIC
 * REPUBLIC OF)` and `Iran, Islamic Republic of` both read `iranislamicrepublicof`.
 * Marks are stripped before `normalize()` too, as `fold()` does: NFKD reorders a
 * run of combining marks with an insertion sort, quadratic in the run's length.
 */
function foldCountryName(name: string): string {
  return name
    .replace(COMBINING_MARKS, '')
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/&/g, 'and')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

/** Folded name → code. Two codes claiming one folded name is a table error, caught at load. */
const CODE_BY_NAME: ReadonlyMap<string, string> = (() => {
  const byName = new Map<string, string>();
  for (const [code, names] of Object.entries(COUNTRY_NAMES)) {
    for (const name of names) {
      const folded = foldCountryName(name);
      const claimed = byName.get(folded);
      if (claimed && claimed !== code) {
        throw new Error(`Country name "${name}" folds to one already mapped to ${claimed}.`);
      }
      byName.set(folded, code);
    }
  }
  return byName;
})();

/**
 * The ISO 3166-1 alpha-2 code a published country name or code stands for, or
 * undefined when the table does not know it — never a guess. A two-letter value
 * resolves only when it is itself a code in the table.
 */
export function countryCodeOf(published: string): string | undefined {
  const trimmed = published.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    const code = trimmed.toUpperCase();
    return Object.hasOwn(COUNTRY_NAMES, code) ? code : undefined;
  }
  return CODE_BY_NAME.get(foldCountryName(trimmed));
}
