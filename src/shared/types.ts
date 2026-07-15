export const CONFIG_SCHEMA_VERSION = 1 as const;

export const MATCH_MODES = ["page", "request", "page_and_request"] as const;

export type MatchMode = (typeof MATCH_MODES)[number];

export interface HeaderCandidate {
  id: string;
  enabled: boolean;
  name: string;
  value: string;
  comment: string;
}

/** Kept as a convenient UI-facing alias. */
export type HeaderItem = HeaderCandidate;

export interface Profile {
  id: string;
  name: string;
  matchMode: MatchMode;
  pageDomains: string[];
  requestUrlPatterns: string[];
  headers: HeaderCandidate[];
}

export interface AppConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  enabled: boolean;
  activeProfileId: string | null;
  profiles: Profile[];
}

export interface HeaderGroup {
  /** Lower-cased header name, used for case-insensitive comparisons. */
  key: string;
  /** Header name as written by the first candidate in this group. */
  name: string;
  candidates: HeaderCandidate[];
}

export interface SyncRulesMessage {
  type: "SYNC_RULES";
}

export interface SyncRulesResponse {
  ok: boolean;
  ruleCount?: number;
  error?: string;
}

export type RuleSyncStatus = "idle" | "success" | "error";

export interface RuleSyncState {
  status: RuleSyncStatus;
  ruleCount: number;
  error: string | null;
  /** Unix timestamp in milliseconds. `0` means no sync has completed yet. */
  updatedAt: number;
}

export function isSyncRulesMessage(message: unknown): message is SyncRulesMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "SYNC_RULES"
  );
}
