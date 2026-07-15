import { ValidationError } from "./errors";

const MAX_REQUEST_PATTERN_LENGTH = 1_024;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function fail(path: string, message: string): never {
  throw new ValidationError({ path, message });
}

function toAsciiHostname(hostname: string, path: string): string {
  let normalized: string;

  try {
    // URL gives us the same IDN -> punycode normalization Chrome uses for URLs.
    normalized = new URL(`http://${hostname}`).hostname.toLowerCase();
  } catch {
    return fail(path, "不是有效的域名");
  }

  if (normalized.endsWith(".")) {
    normalized = normalized.slice(0, -1);
  }

  if (!normalized || normalized.length > 253 || !/^[\x00-\x7f]+$/.test(normalized)) {
    return fail(path, "域名必须是有效的 ASCII 域名（国际化域名会自动转为 punycode）");
  }

  if (normalized === "localhost") {
    return normalized;
  }

  const labels = normalized.split(".");
  if (labels.some((label) => !DOMAIN_LABEL_PATTERN.test(label))) {
    return fail(path, "域名标签只能包含字母、数字和连字符");
  }

  return normalized;
}

/**
 * Normalizes a page-domain entry for DNR `topDomains`.
 * `*.example.com` and `.example.com` are accepted as friendly input and both
 * become `example.com`, because DNR domain conditions already include subdomains.
 */
export function normalizePageDomain(value: string): string {
  if (typeof value !== "string") {
    return fail("pageDomain", "必须是字符串");
  }

  let domain = value.trim().toLowerCase();
  if (!domain) {
    return fail("pageDomain", "不能为空");
  }

  if (domain.startsWith("*.")) {
    domain = domain.slice(2);
  } else if (domain.startsWith(".")) {
    domain = domain.slice(1);
  }

  if (
    domain.includes("://") ||
    /[/?#@\\%\s]/.test(domain) ||
    domain.includes(":") ||
    domain.includes("*")
  ) {
    return fail(
      "pageDomain",
      "只填写域名，不要包含协议、端口、路径、空白、转义字符或通配符",
    );
  }

  return toAsciiHostname(domain, "pageDomain");
}

interface ParsedRequestPattern {
  scheme: "*" | "http" | "https";
  host: string;
  port: string | null;
  path: string;
}

function splitHostAndPort(
  authority: string,
  path: string,
): { host: string; port: string | null } {
  const separatorIndex = authority.lastIndexOf(":");
  if (separatorIndex === -1) {
    return { host: authority, port: null };
  }

  const host = authority.slice(0, separatorIndex);
  const port = authority.slice(separatorIndex + 1);
  if (!host || !port || (port !== "*" && !/^\d{1,5}$/.test(port))) {
    return fail(path, "端口必须是 1-5 位数字或 *");
  }

  if (port !== "*" && Number(port) > 65_535) {
    return fail(path, "端口不能大于 65535");
  }

  return { host, port };
}

function normalizePatternHost(host: string, path: string): string {
  const lowerHost = host.toLowerCase();
  if (lowerHost === "*") {
    return lowerHost;
  }

  if (lowerHost.startsWith("*.")) {
    return `*.${toAsciiHostname(lowerHost.slice(2), path)}`;
  }

  if (lowerHost.includes("*")) {
    return fail(path, "域名通配符只能使用 * 或 *.example.com 形式");
  }

  return toAsciiHostname(lowerHost, path);
}

function parseRequestPattern(value: string): ParsedRequestPattern {
  if (typeof value !== "string") {
    return fail("requestUrlPattern", "必须是字符串");
  }

  let pattern = value.trim();
  if (!pattern) {
    return fail("requestUrlPattern", "不能为空");
  }

  if (pattern.length > MAX_REQUEST_PATTERN_LENGTH) {
    return fail("requestUrlPattern", `长度不能超过 ${MAX_REQUEST_PATTERN_LENGTH} 个字符`);
  }
  if (/\s/.test(pattern)) {
    return fail("requestUrlPattern", "不能包含空白字符");
  }
  if (!/^[\x00-\x7f]+$/.test(pattern)) {
    return fail("requestUrlPattern", "目前仅支持 ASCII 字符；中文域名请填写 punycode");
  }
  if (pattern.includes("#")) {
    return fail("requestUrlPattern", "请求 URL 不包含 fragment，请移除 # 及其后内容");
  }

  if (!pattern.includes("://")) {
    pattern = `*://${pattern}`;
  }

  const match = /^(\*|https?):\/\/([^/]+)(\/.*)?$/i.exec(pattern);
  if (!match) {
    return fail(
      "requestUrlPattern",
      "格式应类似 *://*.example.com/* 或 http://localhost:3000/*",
    );
  }

  const scheme = match[1].toLowerCase() as ParsedRequestPattern["scheme"];
  const authority = match[2];
  const path = match[3] ?? "/*";

  // URL parsers can reinterpret user-info, query markers and backslashes in
  // the authority. Reject them instead of silently broadening the host scope.
  if (/[?@\\%]/.test(authority)) {
    return fail(
      "requestUrlPattern",
      "域名部分不能包含用户信息、查询参数、反斜杠或百分号编码",
    );
  }

  const hostAndPort = splitHostAndPort(authority, "requestUrlPattern");
  const host = normalizePatternHost(hostAndPort.host, "requestUrlPattern");

  return { scheme, host, port: hostAndPort.port, path };
}

/** Normalizes the supported Chrome-match-pattern-like request syntax. */
export function normalizeRequestPattern(value: string): string {
  const pattern = parseRequestPattern(value);
  const port = pattern.port === null ? "" : `:${pattern.port}`;
  return `${pattern.scheme}://${pattern.host}${port}${pattern.path}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

function globPathToRegex(path: string): string {
  return path
    .split("*")
    .map((part) => escapeRegex(part))
    .join(".*");
}

/** Converts a normalized request pattern to a fully anchored RE2-compatible regex. */
export function requestPatternToRegex(value: string): string {
  const pattern = parseRequestPattern(normalizeRequestPattern(value));
  const scheme = pattern.scheme === "*" ? "https?" : pattern.scheme;

  let host: string;
  if (pattern.host === "*") {
    host = "[^/:]+";
  } else if (pattern.host.startsWith("*.")) {
    const baseDomain = escapeRegex(pattern.host.slice(2));
    // Like Chrome match patterns, *.example.com includes example.com itself.
    // Keep this RE2-friendly: Chrome's validator is stricter than JavaScript's
    // RegExp implementation and may reject non-capturing groups.
    host = `([^./:]+\\.)*${baseDomain}`;
  } else {
    host = escapeRegex(pattern.host);
  }

  let port = "";
  if (pattern.port === "*" || pattern.port === null) {
    // Chrome match patterns do not use the port as part of host matching.
    // Keep an explicit-port extension for power users, while an omitted or
    // wildcard port matches both default and non-default ports.
    port = "(:[0-9]+)?";
  } else if (pattern.port !== null) {
    const isDefaultPort =
      (pattern.scheme === "http" && pattern.port === "80") ||
      (pattern.scheme === "https" && pattern.port === "443");
    port = isDefaultPort ? `(:${pattern.port})?` : `:${pattern.port}`;
  }

  return `^${scheme}:\\/\\/${host}${port}${globPathToRegex(pattern.path)}$`;
}
