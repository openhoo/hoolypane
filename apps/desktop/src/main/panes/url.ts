const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const SPECIAL_SCHEME_WITHOUT_SLASHES = /^(https?|file|ws|wss|ftp):(?!\/\/)/i;

export function isAllowedProtocol(url: string): boolean {
  try { return ALLOWED_PROTOCOLS.has(new URL(url).protocol); } catch { return false; }
}

/** Strips userinfo in place so typed credentials never persist into URLs or leak into failure messages. */
export function stripUrlCredentials(url: URL): void {
  if (url.username || url.password) { url.username = ""; url.password = ""; }
}

export function normalizeUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("URL must not be empty");
  const slashlessSpecial = SPECIAL_SCHEME_WITHOUT_SLASHES.exec(value);
  // An explicit scheme must not reach the bare-host prefix unless what follows the colon is
  // only a numeric port (`localhost:3000`). Otherwise an "@" would split authority into
  // userinfo + host and the strip below would silently load a different https host; all other
  // scheme-bearing input keeps its original form here and dies on the http(s)-only allowlist,
  // exactly like its `tel:` siblings.
  const schemeShaped = slashlessSpecial ? null : /^([a-z][a-z\d+.-]*):(.+)$/i.exec(value);
  const schemeRemainder = schemeShaped?.[2];
  const candidate = slashlessSpecial
    ? `${slashlessSpecial[1]}://${value.slice(slashlessSpecial[0].length).replace(/^\/+/, "")}`
    : schemeRemainder !== undefined && !/^\d+(?:[/?#].*)?$/.test(schemeRemainder) ? value : `https://${value}`;
  let parsed: URL;
  try { parsed = new URL(candidate); } catch { throw new Error("Invalid URL"); }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) throw new Error("Only http and https URLs are allowed");
  // Normalized URLs persist into workspace state (sharedUrl, per-pane urls, workspace.json);
  // strip userinfo so typed credentials never survive.
  stripUrlCredentials(parsed);
  return parsed.toString();
}
