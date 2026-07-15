import { DEFAULT_CONFIG, validateAndNormalizeConfig } from "./config";
import type {
  AppConfig,
  RuleSyncState,
  SyncRulesMessage,
  SyncRulesResponse,
} from "./types";

export const CONFIG_STORAGE_KEY = "mockHeaderConfig";
export const RULE_SYNC_STATE_KEY = "mockHeaderRuleSyncState";

export const DEFAULT_RULE_SYNC_STATE: RuleSyncState = {
  status: "idle",
  ruleCount: 0,
  error: null,
  updatedAt: 0,
};

function cloneDefaultConfig(): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    profiles: [],
  };
}

export async function loadConfig(): Promise<AppConfig> {
  const stored = await chrome.storage.local.get(CONFIG_STORAGE_KEY);
  const value = stored[CONFIG_STORAGE_KEY];
  if (value === undefined) {
    return cloneDefaultConfig();
  }
  return validateAndNormalizeConfig(value);
}

export async function saveConfig(config: AppConfig): Promise<void> {
  const normalized = validateAndNormalizeConfig(config);
  await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: normalized });
}

function cloneDefaultRuleSyncState(): RuleSyncState {
  return { ...DEFAULT_RULE_SYNC_STATE };
}

function normalizeRuleSyncState(value: unknown): RuleSyncState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const state = value as Partial<RuleSyncState>;
  if (
    state.status !== "idle" &&
    state.status !== "success" &&
    state.status !== "error"
  ) {
    return null;
  }
  if (
    typeof state.ruleCount !== "number" ||
    !Number.isInteger(state.ruleCount) ||
    state.ruleCount < 0
  ) {
    return null;
  }
  if (state.error !== null && typeof state.error !== "string") {
    return null;
  }
  if (
    typeof state.updatedAt !== "number" ||
    !Number.isFinite(state.updatedAt) ||
    state.updatedAt < 0
  ) {
    return null;
  }

  return {
    status: state.status,
    ruleCount: state.ruleCount,
    error: state.error,
    updatedAt: state.updatedAt,
  };
}

export async function loadRuleSyncState(): Promise<RuleSyncState> {
  const stored = await chrome.storage.local.get(RULE_SYNC_STATE_KEY);
  const value = stored[RULE_SYNC_STATE_KEY];
  if (value === undefined) {
    return cloneDefaultRuleSyncState();
  }

  // This is derived diagnostic state, so corrupted legacy data should not block
  // the Popup or Options page from loading the actual configuration.
  return normalizeRuleSyncState(value) ?? cloneDefaultRuleSyncState();
}

export async function saveRuleSyncState(state: RuleSyncState): Promise<void> {
  const normalized = normalizeRuleSyncState(state);
  if (!normalized) {
    throw new Error("规则同步状态格式无效");
  }
  await chrome.storage.local.set({ [RULE_SYNC_STATE_KEY]: normalized });
}

function isMissingReceiverError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Could not establish connection") ||
    message.includes("Receiving end does not exist") ||
    message.includes("The message port closed before a response was received")
  );
}

/** Requests an immediate rebuild in addition to the storage-change safety net. */
export async function notifyBackgroundSync(): Promise<void> {
  const message: SyncRulesMessage = { type: "SYNC_RULES" };

  try {
    const response = (await chrome.runtime.sendMessage(message)) as
      | SyncRulesResponse
      | undefined;
    if (response && !response.ok) {
      throw new Error(response.error || "后台同步规则失败");
    }
  } catch (error) {
    // During extension install/reload there can briefly be no service worker.
    // The storage-change/startup listeners will reconcile rules later.
    if (!isMissingReceiverError(error)) {
      throw error;
    }
  }
}
