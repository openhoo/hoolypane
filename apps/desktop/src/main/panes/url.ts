export function normalizeUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("URL must not be empty");
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  let parsed: URL;
  try { parsed = new URL(candidate); } catch { throw new Error("Invalid URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only http and https URLs are allowed");
  return parsed.toString();
}
