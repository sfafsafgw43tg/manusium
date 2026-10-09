/**
 * packages/core/src/android-identity.ts
 *
 * Hardware identifiers, model naming, and hardware randomization for Android
 * emulated devices (Android Studio AVD).
 *
 * Provides realistic MAC address, valid 15-digit IMEI with Luhn checksum,
 * 64-bit SSAID (Android ID), hardware serial number, simulated phone number,
 * carrier / operator metadata, and device model identity generators.
 */

export interface AndroidHardwareIdentity {
  brand: string;
  manufacturer: string;
  /** Friendly commercial model name, e.g. "Google Pixel 9 Pro XL" or "Samsung Galaxy S24 Ultra". */
  model: string;
  /** Retail market name, synchronized with model name for user-facing surfaces. */
  marketName: string;
  device: string;
  product: string;
  mac: string;
  imei: string;
  androidId: string;
  serialNumber: string;
  phoneNumber: string;
  operator: string;
  simOperator: string;
  simCountry: string;
  buildId?: string;
  fingerprint?: string;
}

export interface OperatorProfile {
  name: string;
  numeric: string;
  country: string;
}

export const OPERATOR_PROFILES: readonly OperatorProfile[] = [
  { name: 'T-Mobile', numeric: '310260', country: 'us' },
  { name: 'Verizon', numeric: '311480', country: 'us' },
  { name: 'AT&T', numeric: '310410', country: 'us' },
  { name: 'Orange PL', numeric: '26003', country: 'pl' },
  { name: 'Play', numeric: '26006', country: 'pl' },
  { name: 'Plus', numeric: '26001', country: 'pl' },
  { name: 'T-Mobile PL', numeric: '26002', country: 'pl' },
  { name: 'Vodafone UK', numeric: '23415', country: 'gb' },
  { name: 'EE', numeric: '23430', country: 'gb' },
  { name: 'O2 UK', numeric: '23410', country: 'gb' },
  { name: 'Telekom.de', numeric: '26201', country: 'de' },
  { name: 'Vodafone.de', numeric: '26202', country: 'de' },
  { name: 'O2 - de', numeric: '26207', country: 'de' },
] as const;

/**
 * Generate a vendor-faithful or locally administered unicast Wi-Fi MAC address.
 */
export function randomMac(brand?: string): string {
  const b = (brand || '').toLowerCase();
  let prefix = '02';
  if (b.includes('google')) {
    const googleOuis = ['f4:f5:d8', '3c:28:6d', 'd8:3c:69', '54:60:09', '70:3a:51'];
    prefix = googleOuis[Math.floor(Math.random() * googleOuis.length)];
  } else if (b.includes('samsung')) {
    const samsungOuis = ['94:01:c2', '50:01:d9', '34:14:b5', 'a8:91:be', 'e8:50:8b'];
    prefix = samsungOuis[Math.floor(Math.random() * samsungOuis.length)];
  } else if (b.includes('xiaomi')) {
    const xiaomiOuis = ['78:11:dc', '64:cc:2e', '00:9e:c8', '50:64:2b', 'ac:c1:ee'];
    prefix = xiaomiOuis[Math.floor(Math.random() * xiaomiOuis.length)];
  } else if (b.includes('oneplus')) {
    const oneplusOuis = ['70:bf:92', '98:0c:82', 'e8:b2:ac', 'c4:a3:66'];
    prefix = oneplusOuis[Math.floor(Math.random() * oneplusOuis.length)];
  } else {
    // Generate valid locally administered unicast MAC: bit 1 of byte 0 set (2), bit 0 cleared (0).
    const byte0 = ((Math.floor(Math.random() * 256) & 0xfe) | 0x02).toString(16).padStart(2, '0');
    const byte1 = Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
    const byte2 = Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
    prefix = `${byte0}:${byte1}:${byte2}`;
  }
  const b3 = Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  const b4 = Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  const b5 = Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return `${prefix}:${b3}:${b4}:${b5}`.toLowerCase();
}

/**
 * Calculate the Luhn check digit for a 14-digit numeric string.
 */
export function luhnChecksumDigit(digits14: string): number {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let digit = parseInt(digits14[i], 10) || 0;
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Generate a valid 15-digit IMEI number with matching TAC and Luhn checksum.
 */
export function randomImei(brand?: string): string {
  const b = (brand || '').toLowerCase();
  let tac = '35';
  if (b.includes('google')) {
    const tacs = ['35891234', '35781209', '35912345', '35678120'];
    tac = tacs[Math.floor(Math.random() * tacs.length)];
  } else if (b.includes('samsung')) {
    const tacs = ['35284910', '35492811', '35619208', '35812903'];
    tac = tacs[Math.floor(Math.random() * tacs.length)];
  } else if (b.includes('xiaomi')) {
    const tacs = ['86812304', '86923405', '86419208', '86192034'];
    tac = tacs[Math.floor(Math.random() * tacs.length)];
  } else if (b.includes('oneplus')) {
    const tacs = ['86491002', '86123403', '86719204', '86290145'];
    tac = tacs[Math.floor(Math.random() * tacs.length)];
  } else {
    tac = `35${Math.floor(100000 + Math.random() * 900000)}`;
  }
  const serial = Math.floor(100000 + Math.random() * 900000).toString();
  const first14 = `${tac.slice(0, 8)}${serial}`;
  const check = luhnChecksumDigit(first14);
  return `${first14}${check}`;
}

/**
 * Generate a 16-character hexadecimal Android ID (SSAID).
 */
export function randomAndroidId(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

/**
 * Generate a hardware serial number.
 */
export function randomSerialNumber(brand?: string): string {
  const chars = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const b = (brand || '').toLowerCase();
  if (b.includes('samsung')) {
    const rest = Array.from({ length: 7 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `R58N${rest}`;
  }
  if (b.includes('google')) {
    return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/**
 * Generate a simulated phone number formatted with international country prefix.
 */
export function randomPhoneNumber(country = 'us'): string {
  const c = country.toLowerCase();
  if (c === 'pl') {
    const prefixes = ['60', '50', '51', '69', '78', '79'];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    const rest = Math.floor(1000000 + Math.random() * 9000000).toString().slice(0, 7);
    return `+48${prefix}${rest}`;
  }
  if (c === 'gb' || c === 'uk') {
    const rest = Math.floor(100000 + Math.random() * 900000).toString();
    return `+4477009${rest}`;
  }
  if (c === 'de') {
    const rest = Math.floor(1000000 + Math.random() * 9000000).toString();
    return `+49151${rest}`;
  }
  const areaCodes = ['202', '312', '415', '650', '917', '212', '310', '512', '702', '206'];
  const area = areaCodes[Math.floor(Math.random() * areaCodes.length)];
  const num = Math.floor(1000 + Math.random() * 9000).toString();
  return `+1${area}555${num}`;
}

/**
 * Pick an operator profile for the given country.
 */
export function randomSimProfile(country?: string): OperatorProfile {
  const filtered = country ? OPERATOR_PROFILES.filter((p) => p.country === country.toLowerCase()) : [];
  const list = filtered.length ? filtered : OPERATOR_PROFILES;
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Generate a complete coherent randomized hardware identity.
 */
export function createRandomHardwareIdentity(
  paramsOrBrand?: string | {
    brand?: string;
    manufacturer?: string;
    model?: string;
    marketName?: string;
    device?: string;
    product?: string;
    country?: string;
  },
  countryParam?: string,
): AndroidHardwareIdentity {
  const params = typeof paramsOrBrand === 'object' && paramsOrBrand !== null
    ? paramsOrBrand
    : { brand: paramsOrBrand, country: countryParam };

  const brand = params.brand || 'google';
  const manufacturer = params.manufacturer || (brand.charAt(0).toUpperCase() + brand.slice(1));
  const model = params.model || (brand === 'google' ? 'Google Pixel 9 Pro XL' : `${manufacturer} Device`);
  const marketName = params.marketName || model;
  const device = params.device || 'komodo';
  const product = params.product || device;
  const operatorProfile = randomSimProfile(params.country || 'us');

  return {
    brand,
    manufacturer,
    model,
    marketName,
    device,
    product,
    mac: randomMac(brand),
    imei: randomImei(brand),
    androidId: randomAndroidId(),
    serialNumber: randomSerialNumber(brand),
    phoneNumber: randomPhoneNumber(operatorProfile.country),
    operator: operatorProfile.name,
    simOperator: operatorProfile.numeric,
    simCountry: operatorProfile.country,
  };
}
