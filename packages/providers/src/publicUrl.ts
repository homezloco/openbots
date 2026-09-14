import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * The boundary for tools that must reach ARBITRARY hosts (web_fetch,
 * web_search results) — the exact inverse of http_request's model.
 *
 * `http_request` is safe because an operator allowlists specific hosts.
 * Research can't work that way: the whole point is fetching pages nobody
 * enumerated in advance. So the boundary flips from "allow these" to
 * "deny everything internal", which is strictly weaker and has to be
 * implemented carefully rather than assumed.
 *
 * Three distinct things are checked, because each defeats a different
 * attack:
 *  1. Scheme — only http(s). Blocks file://, gopher://, etc.
 *  2. Literal-IP targets — a URL can name a private range directly.
 *  3. RESOLVED address — the important one. `evil.example.com` can have
 *     an A record pointing at 127.0.0.1 or 169.254.169.254, so checking
 *     the hostname string alone proves nothing. We resolve first and
 *     check every returned address.
 *
 * Deliberately NOT claimed: this does not close DNS-rebinding, where a
 * name resolves to a public address here and a private one when the HTTP
 * client resolves it again microseconds later. Fully closing that
 * requires pinning the checked IP through to connect time (a custom
 * agent/socket factory). Callers additionally pass `redirect: "error"`,
 * which removes the much easier redirect-to-internal path.
 */

/** Reserved/internal IPv4 ranges, as [start, end] of the leading octets we reject. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local INCLUDING cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598) — Tailscale et al.
  if (a === 192 && b === 0) return true; // IETF protocol assignments (192.0.0.0/16 — includes TEST-NET-1)
  if (a === 192 && b === 88 && parts[2] === 99) return true; // deprecated 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking (RFC2544) — never routable
  if (a === 198 && b === 51 && parts[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0]; // strip zone id
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  if (addr.startsWith("fe80")) return true; // link-local
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // unique local
  if (addr.startsWith("2001:db8") || addr.startsWith("2001:0db8")) return true; // documentation range

  // IPv4-mapped addresses must defer to the v4 rules, or ::ffff:127.0.0.1
  // sails through as "some opaque v6 address" and reaches loopback.
  //
  // Both spellings have to be handled, which is the part that actually
  // bit: `new URL("http://[::ffff:127.0.0.1]").hostname` NORMALIZES to the
  // hex form `::ffff:7f00:1`, so a dotted-quad-only regex never matched
  // the string this function actually receives. Caught by a live test of
  // the guard, not by reading it.
  if (addr.startsWith("::ffff:")) {
    const tail = addr.slice("::ffff:".length);
    if (tail.includes(".")) return isPrivateIPv4(tail);
    const groups = tail.split(":");
    if (groups.length === 2) {
      const hi = Number.parseInt(groups[0], 16);
      const lo = Number.parseInt(groups[1], 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        const dotted = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join(".");
        return isPrivateIPv4(dotted);
      }
    }
    return true; // unparseable mapped form — fail closed
  }
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true; // not a parseable IP — fail closed
}

export interface PublicUrlCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Resolves the URL's hostname and rejects it if ANY resolved address is
 * internal. Fails closed on resolution errors — an unresolvable host is
 * not worth fetching anyway, and treating "I couldn't check" as "allowed"
 * is how these guards get bypassed.
 */
export async function assertPublicUrl(raw: string): Promise<PublicUrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `unsupported scheme "${url.protocol}"` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "URLs with embedded credentials are not fetched" };
  }

  const host = url.hostname.replace(/^\[|\]$/g, ""); // unwrap bracketed IPv6
  if (isIP(host)) {
    return isPrivateAddress(host)
      ? { ok: false, reason: `${host} is a private or reserved address` }
      : { ok: true };
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return { ok: false, reason: `could not resolve ${host}` };
  }
  if (addresses.length === 0) return { ok: false, reason: `no addresses for ${host}` };

  // EVERY address must be public: a host with one public and one private
  // A record would otherwise be reachable on a retry.
  const priv = addresses.find((a) => isPrivateAddress(a.address));
  if (priv) return { ok: false, reason: `${host} resolves to the private address ${priv.address}` };

  return { ok: true };
}
