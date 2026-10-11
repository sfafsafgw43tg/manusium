export const FINGERPRINT_TEST_SITES = {
  browsercheck: { labelKey: 'fp.verify.browsercheck', url: 'https://browsercheck.net/' },
  browserleaks: { labelKey: 'fp.verify.browserleaks', url: 'https://browserleaks.com/' },
  creepjs: { labelKey: 'fp.verify.creepjs', url: 'https://abrahamjuliot.github.io/creepjs/' },
  pixelscan: { labelKey: 'fp.verify.pixelscan', url: 'https://pixelscan.net/' },
} as const;

export type FingerprintTestSiteId = keyof typeof FINGERPRINT_TEST_SITES;
