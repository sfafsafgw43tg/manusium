// Shape of dist/lists-info.js, which scripts/build.mjs writes from the pinned upstream list and the generated rulesets.
export interface RulesetInfo {
  id: string;
  rules: number;
}

export interface ListInfo {
  adRulesets: RulesetInfo[];
  adDomains: number;
  trackerRules: number;
  fingerprintRules: number;
  upstream: {
    name: string;
    repo: string;
    commit: string;
    license: string;
    homepage: string;
  };
}

export declare const LIST_INFO: ListInfo;
