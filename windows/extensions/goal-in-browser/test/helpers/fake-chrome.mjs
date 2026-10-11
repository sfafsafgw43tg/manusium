/**
 * A fake chrome.* surface that keeps just enough state to check the extension's behaviour in Node.
 * It is a test double, not a model of Chrome's matcher. It records every call so tests can assert on them.
 */
export function installFakeChrome(options = {}) {
  const {
    id = 'testextensionid',
    levels = {},
    enabled = [],
    available = 300000,
    dynamic = [],
    siteAccess = false,
    failDynamicWhen = null,
    failEnableCalls = 0,
    storage = {},
  } = options;

  const log = {
    enableCalls: [],
    dynamicCalls: [],
    set: [],
    cleared: [],
    contentCalls: [],
    badge: null,
    storageWrites: [],
    browsingDataCalls: [],
    permissionRequests: [],
  };
  const state = { enabled: [...enabled], dynamic: [...dynamic], enableFailuresLeft: failEnableCalls };
  const listeners = { installed: [], startup: [], message: [], permissionAdded: [], permissionRemoved: [] };

  const failWith = (callback, message) => {
    globalThis.chrome.runtime.lastError = { message };
    callback?.();
    globalThis.chrome.runtime.lastError = undefined;
  };
  const setting = (name) => ({
    get: (_details, callback) =>
      callback({ value: undefined, levelOfControl: levels[name] ?? 'controllable_by_this_extension' }),
    set: ({ value }, callback) => {
      log.set.push([name, value]);
      callback?.();
    },
    clear: (_details, callback) => {
      log.cleared.push(name);
      callback?.();
    },
  });
  const content = (name) => ({
    get: (_details, callback) =>
      callback({ setting: 'allow', levelOfControl: levels[name] ?? 'controllable_by_this_extension' }),
    set: ({ primaryPattern, setting: value }, callback) => {
      log.contentCalls.push([name, primaryPattern, value]);
      callback?.();
    },
    clear: (_details, callback) => {
      log.cleared.push(name);
      callback?.();
    },
  });

  globalThis.chrome = {
    runtime: {
      id,
      lastError: undefined,
      getURL: (path) => `chrome-extension://${id}/${path}`,
      getManifest: () => ({ version: '0.2.0' }),
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      openOptionsPage: () => Promise.resolve(),
    },
    permissions: {
      onAdded: { addListener: (fn) => listeners.permissionAdded.push(fn) },
      onRemoved: { addListener: (fn) => listeners.permissionRemoved.push(fn) },
      contains: (_query, callback) => callback(siteAccess),
      request: (query, callback) => {
        log.permissionRequests.push(query);
        callback(siteAccess);
      },
      remove: (_query, callback) => callback(true),
    },
    storage: {
      local: {
        get: (keys, callback) => {
          const wanted = Array.isArray(keys) ? keys : [keys];
          callback(Object.fromEntries(wanted.filter((key) => key in storage).map((key) => [key, storage[key]])));
        },
        set: (values, callback) => {
          log.storageWrites.push(values);
          Object.assign(storage, values);
          callback?.();
        },
      },
    },
    declarativeNetRequest: {
      getEnabledRulesets: (callback) => callback([...state.enabled]),
      getAvailableStaticRuleCount: (callback) => callback(available),
      updateEnabledRulesets: ({ enableRulesetIds, disableRulesetIds }, callback) => {
        log.enableCalls.push({ enable: enableRulesetIds, disable: disableRulesetIds });
        if (state.enableFailuresLeft > 0) {
          state.enableFailuresLeft -= 1;
          failWith(callback, 'Static rule limit reached');
          return;
        }
        state.enabled = state.enabled.filter((rulesetId) => !disableRulesetIds.includes(rulesetId)).concat(enableRulesetIds);
        callback?.();
      },
      getDynamicRules: (callback) => callback([...state.dynamic]),
      updateDynamicRules: ({ removeRuleIds, addRules }, callback) => {
        log.dynamicCalls.push({ removed: removeRuleIds, added: addRules });
        if (failDynamicWhen && failDynamicWhen(addRules)) {
          failWith(callback, 'rule limit reached');
          return;
        }
        state.dynamic = state.dynamic.filter((rule) => !removeRuleIds.includes(rule.id)).concat(addRules);
        callback?.();
      },
      setExtensionActionOptions: ({ displayActionCountAsBadgeText }, callback) => {
        log.badge = displayActionCountAsBadgeText;
        callback?.();
      },
    },
    privacy: {
      network: {
        webRTCIPHandlingPolicy: setting('webRTCIPHandlingPolicy'),
        networkPredictionEnabled: setting('networkPredictionEnabled'),
      },
      websites: {
        thirdPartyCookiesAllowed: setting('thirdPartyCookiesAllowed'),
        doNotTrackEnabled: setting('doNotTrackEnabled'),
        referrersEnabled: setting('referrersEnabled'),
        topicsEnabled: setting('topicsEnabled'),
        fledgeEnabled: setting('fledgeEnabled'),
        adMeasurementEnabled: setting('adMeasurementEnabled'),
        hyperlinkAuditingEnabled: setting('hyperlinkAuditingEnabled'),
      },
      services: {
        alternateErrorPagesEnabled: setting('alternateErrorPagesEnabled'),
        searchSuggestEnabled: setting('searchSuggestEnabled'),
        translationServiceEnabled: setting('translationServiceEnabled'),
      },
    },
    contentSettings: { location: content('location'), notifications: content('notifications') },
    browsingData: {
      remove: (removeOptions, dataToRemove, callback) => {
        log.browsingDataCalls.push({ options: removeOptions, types: dataToRemove });
        callback?.();
      },
    },
  };
  return { log, state, listeners, storage };
}

export function uninstallFakeChrome() {
  delete globalThis.chrome;
}
