/**
 * The optional all-sites permission. It is needed only for the header and redirect features listed in the README.
 * Chrome grants it only from a user gesture, so requestSiteAccess() must be called before any await in a click handler.
 */
export const SITE_ORIGIN = '<all_urls>';

export function siteAccessGranted(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    chrome.permissions.contains({ origins: [SITE_ORIGIN] }, (granted) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message ?? 'The permission check failed'));
      else resolve(granted);
    });
  });
}

export function requestSiteAccess(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    chrome.permissions.request({ origins: [SITE_ORIGIN] }, (granted) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message ?? 'The permission request failed'));
      else resolve(granted);
    });
  });
}

export function removeSiteAccess(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    chrome.permissions.remove({ origins: [SITE_ORIGIN] }, (removed) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message ?? 'The permission could not be removed'));
      else resolve(removed);
    });
  });
}
