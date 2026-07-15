/**
 * Returns the compact Profile label used by both the Popup sidebar and the
 * toolbar badge. Array.from keeps Unicode code points such as emoji intact.
 */
export function profileShortName(name: string): string {
  const compactName = name.trim().replace(/\s+/gu, "");
  return Array.from(compactName || "未命名").slice(0, 3).join("");
}
