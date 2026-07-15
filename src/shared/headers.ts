import type { HeaderCandidate, HeaderGroup } from "./types";

export function normalizeHeaderName(name: string): string {
  return name.trim().toLowerCase();
}

/** Groups candidates case-insensitively while preserving their source order. */
export function groupHeaders(headers: readonly HeaderCandidate[]): HeaderGroup[] {
  const groups = new Map<string, HeaderGroup>();

  for (const candidate of headers) {
    const key = normalizeHeaderName(candidate.name);
    const existing = groups.get(key);
    if (existing) {
      existing.candidates.push(candidate);
      continue;
    }

    groups.set(key, {
      key,
      name: candidate.name,
      candidates: [candidate],
    });
  }

  return [...groups.values()];
}
