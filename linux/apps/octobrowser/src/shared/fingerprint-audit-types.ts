export type FingerprintAuditStatus = 'match' | 'mismatch' | 'observed' | 'unavailable' | 'unsupported' | 'not-configured';

export interface FingerprintAuditRow {
  key: string;
  labelKey: string;
  configured: string;
  applied: string;
  received: string;
  status: FingerprintAuditStatus;
  noteKey?: string;
}

export interface FingerprintAuditReport {
  profileId: string;
  profileName: string;
  capturedAt: string;
  summary: 'mismatches' | 'no-mismatch' | 'incomplete';
  rows: FingerprintAuditRow[];
  limitations: string[];
  errors: string[];
  errorFile?: string;
}

export interface FingerprintAuditResponse {
  ok: boolean;
  status: string;
  message?: string;
  profileName?: string;
  report?: FingerprintAuditReport;
  errorFile?: string;
  urls?: string[];
  sites?: string[];
}
