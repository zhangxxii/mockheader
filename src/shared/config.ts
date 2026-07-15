import { ValidationError, type ValidationIssue } from "./errors";
import { normalizeHeaderName } from "./headers";
import { normalizePageDomain, normalizeRequestPattern } from "./matching";
import {
  CONFIG_SCHEMA_VERSION,
  MATCH_MODES,
  type AppConfig,
  type HeaderCandidate,
  type MatchMode,
  type Profile,
} from "./types";

export const DEFAULT_CONFIG: AppConfig = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
  enabled: false,
  activeProfileId: null,
  profiles: [],
};

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(issues: ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function readRequiredString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): string {
  const value = record[key];
  if (typeof value !== "string") {
    issue(issues, path, "必须是字符串");
    return "";
  }

  const normalized = value.trim();
  if (!normalized) {
    issue(issues, path, "不能为空");
  }
  return normalized;
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): string {
  const value = record[key];
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    issue(issues, path, "必须是字符串");
    return "";
  }
  return value.trim();
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    issue(issues, path, "必须是布尔值");
    return false;
  }
  return value;
}

function extractNormalizationMessage(error: unknown): string {
  if (error instanceof ValidationError && error.issues.length > 0) {
    return error.issues.map((entry) => entry.message).join("；");
  }
  return error instanceof Error ? error.message : "格式无效";
}

function normalizeStringList(
  value: unknown,
  path: string,
  normalizer: (entry: string) => string,
  issues: ValidationIssue[],
): string[] {
  if (!Array.isArray(value)) {
    issue(issues, path, "必须是数组");
    return [];
  }

  const output: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      issue(issues, `${path}[${index}]`, "必须是字符串");
      return;
    }

    try {
      const normalized = normalizer(entry);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        output.push(normalized);
      }
    } catch (error) {
      issue(issues, `${path}[${index}]`, extractNormalizationMessage(error));
    }
  });

  return output;
}

function normalizeHeaderCandidate(
  input: unknown,
  path: string,
  issues: ValidationIssue[],
): HeaderCandidate {
  if (!isRecord(input)) {
    issue(issues, path, "必须是对象");
    return { id: "", enabled: false, name: "", value: "", comment: "" };
  }

  const id = readRequiredString(input, "id", `${path}.id`, issues);
  const enabled = readBoolean(input, "enabled", `${path}.enabled`, issues);
  const name = readRequiredString(input, "name", `${path}.name`, issues);
  const value = readRequiredString(input, "value", `${path}.value`, issues);
  const comment = readOptionalString(input, "comment", `${path}.comment`, issues);

  if (name && !HEADER_NAME_PATTERN.test(name)) {
    issue(issues, `${path}.name`, "不是有效的 HTTP Header 名称");
  }
  if (/\r|\n|\0/.test(value)) {
    issue(issues, `${path}.value`, "不能包含换行符或 NUL 字符");
  }

  return { id, enabled, name, value, comment };
}

function normalizeProfileAt(input: unknown, path: string, issues: ValidationIssue[]): Profile {
  if (!isRecord(input)) {
    issue(issues, path, "必须是对象");
    return {
      id: "",
      name: "",
      matchMode: "page",
      pageDomains: [],
      requestUrlPatterns: [],
      headers: [],
    };
  }

  const id = readRequiredString(input, "id", `${path}.id`, issues);
  const name = readRequiredString(input, "name", `${path}.name`, issues);

  let matchMode: MatchMode = "page";
  if (
    typeof input.matchMode !== "string" ||
    !MATCH_MODES.includes(input.matchMode as MatchMode)
  ) {
    issue(issues, `${path}.matchMode`, "必须是 page、request 或 page_and_request");
  } else {
    matchMode = input.matchMode as MatchMode;
  }

  const pageDomains = normalizeStringList(
    input.pageDomains,
    `${path}.pageDomains`,
    normalizePageDomain,
    issues,
  );
  const requestUrlPatterns = normalizeStringList(
    input.requestUrlPatterns,
    `${path}.requestUrlPatterns`,
    normalizeRequestPattern,
    issues,
  );

  let headers: HeaderCandidate[] = [];
  if (!Array.isArray(input.headers)) {
    issue(issues, `${path}.headers`, "必须是数组");
  } else {
    headers = input.headers.map((header, index) =>
      normalizeHeaderCandidate(header, `${path}.headers[${index}]`, issues),
    );
  }

  if ((matchMode === "page" || matchMode === "page_and_request") && pageDomains.length === 0) {
    issue(issues, `${path}.pageDomains`, "当前匹配模式至少需要一个页面域名");
  }
  if (
    (matchMode === "request" || matchMode === "page_and_request") &&
    requestUrlPatterns.length === 0
  ) {
    issue(issues, `${path}.requestUrlPatterns`, "当前匹配模式至少需要一个请求 URL");
  }

  const candidateIds = new Map<string, number>();
  const enabledHeaderNames = new Map<string, number>();
  headers.forEach((header, index) => {
    if (header.id) {
      const existingIndex = candidateIds.get(header.id);
      if (existingIndex !== undefined) {
        issue(
          issues,
          `${path}.headers[${index}].id`,
          `与 headers[${existingIndex}] 的 id 重复`,
        );
      } else {
        candidateIds.set(header.id, index);
      }
    }

    if (!header.enabled || !header.name) {
      return;
    }
    const normalizedName = normalizeHeaderName(header.name);
    const existingIndex = enabledHeaderNames.get(normalizedName);
    if (existingIndex !== undefined) {
      issue(
        issues,
        `${path}.headers[${index}].enabled`,
        `同名 Header（忽略大小写）最多启用一个，已在 headers[${existingIndex}] 启用`,
      );
    } else {
      enabledHeaderNames.set(normalizedName, index);
    }
  });

  return { id, name, matchMode, pageDomains, requestUrlPatterns, headers };
}

export function validateAndNormalizeProfile(input: unknown): Profile {
  const issues: ValidationIssue[] = [];
  const profile = normalizeProfileAt(input, "profile", issues);
  if (issues.length > 0) {
    throw new ValidationError(issues);
  }
  return profile;
}

export function validateAndNormalizeConfig(input: unknown): AppConfig {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) {
    throw new ValidationError({ path: "config", message: "必须是对象" });
  }

  if (input.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    issue(
      issues,
      "config.schemaVersion",
      `仅支持版本 ${CONFIG_SCHEMA_VERSION}`,
    );
  }

  const enabled = readBoolean(input, "enabled", "config.enabled", issues);

  let activeProfileId: string | null = null;
  if (input.activeProfileId === null) {
    activeProfileId = null;
  } else if (typeof input.activeProfileId === "string") {
    activeProfileId = input.activeProfileId.trim();
    if (!activeProfileId) {
      issue(issues, "config.activeProfileId", "空字符串无效，请使用 null");
    }
  } else {
    issue(issues, "config.activeProfileId", "必须是 Profile id 或 null");
  }

  let profiles: Profile[] = [];
  if (!Array.isArray(input.profiles)) {
    issue(issues, "config.profiles", "必须是数组");
  } else {
    profiles = input.profiles.map((profile, index) =>
      normalizeProfileAt(profile, `config.profiles[${index}]`, issues),
    );
  }

  const profileIds = new Map<string, number>();
  profiles.forEach((profile, index) => {
    if (!profile.id) {
      return;
    }
    const existingIndex = profileIds.get(profile.id);
    if (existingIndex !== undefined) {
      issue(
        issues,
        `config.profiles[${index}].id`,
        `与 profiles[${existingIndex}] 的 id 重复`,
      );
    } else {
      profileIds.set(profile.id, index);
    }
  });

  if (activeProfileId !== null && !profileIds.has(activeProfileId)) {
    issue(issues, "config.activeProfileId", "对应的 Profile 不存在");
  }
  if (enabled && activeProfileId === null) {
    issue(issues, "config.activeProfileId", "启用插件前必须选择一个 Profile");
  }

  if (issues.length > 0) {
    throw new ValidationError(issues);
  }

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    enabled,
    activeProfileId,
    profiles,
  };
}

function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function createEmptyHeaderCandidate(name = ""): HeaderCandidate {
  return {
    id: createId("header"),
    enabled: false,
    name,
    value: "",
    comment: "",
  };
}

/** Returns an editable draft. A page domain must be filled before it can be saved. */
export function createEmptyProfile(): Profile {
  return {
    id: createId("profile"),
    name: "新 Profile",
    matchMode: "page",
    pageDomains: [],
    requestUrlPatterns: [],
    headers: [],
  };
}
