/** Build a stable, filesystem-safe stem for a locally downloaded artifact. */
export function safeDownloadStem(value: string, fallback = "jazzboard"): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}
