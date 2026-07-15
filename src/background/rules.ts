import {
  loadConfig,
  requestPatternToRegex,
  type AppConfig,
  type HeaderCandidate,
  type Profile,
} from "../shared";

// Every request-pattern rule uses regexFilter. Chrome permits at most 1,000
// regex rules in each dynamic ruleset, below the general dynamic-rule limit.
const MAX_GENERATED_RULES = 1_000;
const FIRST_RULE_ID = 1;

const ALL_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other",
] as chrome.declarativeNetRequest.ResourceType[];

type RuleConditionWithTopDomains = chrome.declarativeNetRequest.RuleCondition & {
  /** Available in Chrome 145+, newer than some published @types/chrome versions. */
  topDomains?: string[];
};

function enabledHeaders(profile: Profile): HeaderCandidate[] {
  return profile.headers.filter((header) => header.enabled);
}

function createAction(
  headers: readonly HeaderCandidate[],
): chrome.declarativeNetRequest.RuleAction {
  return {
    type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
    requestHeaders: headers.map((header) => ({
      header: header.name,
      operation: chrome.declarativeNetRequest.HeaderOperation.SET,
      value: header.value,
    })),
  };
}

function activeProfile(config: AppConfig): Profile | null {
  if (!config.enabled || config.activeProfileId === null) {
    return null;
  }
  return config.profiles.find((profile) => profile.id === config.activeProfileId) ?? null;
}

/** Builds all dynamic rules for the one active Profile. */
export function buildDynamicRules(config: AppConfig): chrome.declarativeNetRequest.Rule[] {
  const profile = activeProfile(config);
  if (!profile) {
    return [];
  }

  const headers = enabledHeaders(profile);
  if (headers.length === 0) {
    return [];
  }

  const action = createAction(headers);
  const conditions: RuleConditionWithTopDomains[] = [];

  if (profile.matchMode === "page") {
    conditions.push({
      topDomains: profile.pageDomains,
      resourceTypes: ALL_RESOURCE_TYPES,
    });
  } else {
    for (const pattern of profile.requestUrlPatterns) {
      const condition: RuleConditionWithTopDomains = {
        regexFilter: requestPatternToRegex(pattern),
        isUrlFilterCaseSensitive: false,
        resourceTypes: ALL_RESOURCE_TYPES,
      };
      if (profile.matchMode === "page_and_request") {
        condition.topDomains = profile.pageDomains;
      }
      conditions.push(condition);
    }
  }

  if (conditions.length > MAX_GENERATED_RULES) {
    throw new Error(
      `当前 Profile 将生成 ${conditions.length} 条规则，超过上限 ${MAX_GENERATED_RULES}`,
    );
  }

  return conditions.map((condition, index) => ({
    id: FIRST_RULE_ID + index,
    priority: 1,
    action,
    condition,
  }));
}

async function assertRegexesSupported(
  rules: readonly chrome.declarativeNetRequest.Rule[],
): Promise<void> {
  const regexes = [
    ...new Set(
      rules
        .map((rule) => rule.condition.regexFilter)
        .filter((regex): regex is string => typeof regex === "string"),
    ),
  ];

  const results = await Promise.all(
    regexes.map(async (regex) => ({
      regex,
      result: await chrome.declarativeNetRequest.isRegexSupported({
        regex,
        isCaseSensitive: false,
        requireCapturing: false,
      }),
    })),
  );

  const unsupported = results.find(({ result }) => !result.isSupported);
  if (unsupported) {
    const reason = unsupported.result.reason ?? "unknown";
    throw new Error(`请求 URL 规则无法被 Chrome 执行（${reason}）：${unsupported.regex}`);
  }
}

async function currentRuleIds(): Promise<number[]> {
  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  return currentRules.map((rule) => rule.id);
}

async function clearDynamicRules(ruleIds?: readonly number[]): Promise<void> {
  const ids = ruleIds ? [...ruleIds] : await currentRuleIds();
  if (ids.length === 0) {
    return;
  }
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
}

async function clearDynamicRulesBestEffort(ruleIds?: readonly number[]): Promise<void> {
  try {
    await clearDynamicRules(ruleIds);
  } catch (clearError) {
    // Preserve the triggering error for callers while still making the safety
    // cleanup observable in the extension service-worker console.
    console.error("[Mock Header] 清理旧动态规则失败", clearError);
  }
}

/** Loads storage and atomically replaces the extension's dynamic rules. */
export async function rebuildDynamicRules(): Promise<number> {
  let config: AppConfig;
  try {
    config = await loadConfig();
  } catch (error) {
    // A malformed import must never leave stale, potentially sensitive headers active.
    await clearDynamicRulesBestEffort();
    throw error;
  }

  let removeRuleIds: number[];
  try {
    removeRuleIds = await currentRuleIds();
  } catch (error) {
    await clearDynamicRulesBestEffort();
    throw error;
  }

  let rules: chrome.declarativeNetRequest.Rule[];
  try {
    rules = buildDynamicRules(config);
    await assertRegexesSupported(rules);
  } catch (error) {
    // Unsupported new rules must not leave the previous mock identity active.
    await clearDynamicRulesBestEffort(removeRuleIds);
    throw error;
  }

  if (removeRuleIds.length === 0 && rules.length === 0) {
    return 0;
  }

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules: rules,
    });
  } catch (error) {
    // updateDynamicRules is atomic; explicitly remove the old rules after a failed
    // replacement so a bad new configuration cannot keep the previous identity active.
    await clearDynamicRulesBestEffort();
    throw error;
  }

  return rules.length;
}
