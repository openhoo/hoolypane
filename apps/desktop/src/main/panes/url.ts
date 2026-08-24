const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const SPECIAL_SCHEME_WITHOUT_SLASHES = /^(https?|file|ws|wss|ftp):(?!\/\/)/i;

export function isAllowedProtocol(url: string): boolean {
  try { return ALLOWED_PROTOCOLS.has(new URL(url).protocol); } catch { return false; }
}

export function normalizeUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("URL must not be empty");
  const slashlessSpecial = SPECIAL_SCHEME_WITHOUT_SLASHES.exec(value);
  const candidate = slashlessSpecial
    ? `${slashlessSpecial[1]}://${value.slice(slashlessSpecial[0].length).replace(/^\/+/, "")}`
    : /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  let parsed: URL;
  try { parsed = new URL(candidate); } catch { throw new Error("Invalid URL"); }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) throw new Error("Only http and https URLs are allowed");
  // Normalized URLs persist into workspace state (sharedUrl, per-pane urls, workspace.json):
  // strip userinfo so typed credentials never survive, matching redactUrlForMessage.
  if (parsed.username || parsed.password) { parsed.username = ""; parsed.password = ""; }
  return parsed.toString();
}
