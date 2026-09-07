import net from 'node:net';
import dns from 'node:dns/promises';

export type SsrValidationResult =
  | { status: 'ALLOWED' }
  | { status: 'BLOCKED'; reason: string }
  | { status: 'DNS_ERROR'; error: Error };

/**
 * Parse an IPv4 string into numeric octets [a, b, c, d].
 * Returns null if the string is not a valid dotted-quad IPv4.
 */
function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const num = parseInt(part, 10);
    if (num < 0 || num > 255) return null;
    octets.push(num);
  }
  return octets as [number, number, number, number];
}

/**
 * Parse an IPv6 string into eight 16-bit numeric words.
 * Handles standard, compressed (::), and embedded IPv4-mapped representations.
 * Returns null if invalid.
 */
function parseIpv6(ip: string): number[] | null {
  const cleanIp = ip.toLowerCase();

  // Handle embedded IPv4-mapped IPv6 in dotted-decimal format: ::ffff:192.168.1.1
  if (cleanIp.startsWith('::ffff:')) {
    const rest = cleanIp.slice(7);
    if (net.isIPv4(rest)) {
      const octets = parseIpv4(rest);
      if (!octets) return null;
      return [0, 0, 0, 0, 0, 0xffff, (octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    }
  }

  const doubleColonParts = cleanIp.split('::');
  if (doubleColonParts.length > 2) return null;

  const words: number[] = [];

  if (doubleColonParts.length === 1) {
    const parts = doubleColonParts[0].split(':');
    if (parts.length !== 8) return null;
    for (const p of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
      words.push(parseInt(p, 16));
    }
  } else {
    const leftParts = doubleColonParts[0] ? doubleColonParts[0].split(':') : [];
    const rightParts = doubleColonParts[1] ? doubleColonParts[1].split(':') : [];
    const missingCount = 8 - (leftParts.length + rightParts.length);
    if (missingCount < 1) return null;

    for (const p of leftParts) {
      if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
      words.push(parseInt(p, 16));
    }
    for (let i = 0; i < missingCount; i++) {
      words.push(0);
    }
    for (const p of rightParts) {
      if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
      words.push(parseInt(p, 16));
    }
  }

  return words.length === 8 ? words : null;
}

/**
 * Check whether an IP address (IPv4, IPv6, or IPv4-mapped IPv6) belongs to
 * private, loopback, link-local, multicast, or reserved ranges.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const octets = parseIpv4(ip);
    if (!octets) return true; // Fail closed if unparseable
    const [a, b] = octets;

    // 127.0.0.0/8 — Loopback
    if (a === 127) return true;

    // 10.0.0.0/8 — RFC 1918 Private Class A
    if (a === 10) return true;

    // 172.16.0.0/12 — RFC 1918 Private Class B (172.16 - 172.31)
    if (a === 172 && b >= 16 && b <= 31) return true;

    // 192.168.0.0/16 — RFC 1918 Private Class C
    if (a === 192 && b === 168) return true;

    // 169.254.0.0/16 — Link-Local & Cloud Metadata (169.254.169.254)
    if (a === 169 && b === 254) return true;

    // 0.0.0.0/8 — Current Network / Unspecified
    if (a === 0) return true;

    // 100.64.0.0/10 — Carrier-Grade NAT (100.64 - 100.127)
    if (a === 100 && b >= 64 && b <= 127) return true;

    // 224.0.0.0/4 — Multicast (224 - 239)
    if (a >= 224 && a <= 239) return true;

    // 240.0.0.0/4 — Reserved for future use & 255.255.255.255/32 broadcast (240 - 255)
    if (a >= 240 && a <= 255) return true;

    return false;
  }

  if (net.isIPv6(ip)) {
    const words = parseIpv6(ip);
    if (!words) return true; // Fail closed

    // Check for IPv4-mapped IPv6: ::ffff:x.x.x.x (RFC 4291 § 2.5.5.2)
    if (
      words[0] === 0 &&
      words[1] === 0 &&
      words[2] === 0 &&
      words[3] === 0 &&
      words[4] === 0 &&
      words[5] === 0xffff
    ) {
      const octet0 = words[6] >> 8;
      const octet1 = words[6] & 0xff;
      const octet2 = words[7] >> 8;
      const octet3 = words[7] & 0xff;
      return isPrivateOrReservedIp(`${octet0}.${octet1}.${octet2}.${octet3}`);
    }

    // Check for IPv4-compatible IPv6: ::x.x.x.x (RFC 4291 § 2.5.5.1, ::/96)
    // Exclude :: (unspecified) and ::1 (loopback), which are evaluated explicitly below
    if (
      words[0] === 0 &&
      words[1] === 0 &&
      words[2] === 0 &&
      words[3] === 0 &&
      words[4] === 0 &&
      words[5] === 0 &&
      !(words[6] === 0 && words[7] <= 1)
    ) {
      const octet0 = words[6] >> 8;
      const octet1 = words[6] & 0xff;
      const octet2 = words[7] >> 8;
      const octet3 = words[7] & 0xff;
      return isPrivateOrReservedIp(`${octet0}.${octet1}.${octet2}.${octet3}`);
    }

    // Check for 6to4 transition: 2002::/16 (RFC 3056)
    // Words 1 and 2 encode the embedded IPv4 address (bits 16-47)
    if (words[0] === 0x2002) {
      const octet0 = words[1] >> 8;
      const octet1 = words[1] & 0xff;
      const octet2 = words[2] >> 8;
      const octet3 = words[2] & 0xff;
      return isPrivateOrReservedIp(`${octet0}.${octet1}.${octet2}.${octet3}`);
    }

    // ::/128 — Unspecified
    if (words.every((w) => w === 0)) return true;

    // ::1/128 — Loopback
    if (
      words[0] === 0 &&
      words[1] === 0 &&
      words[2] === 0 &&
      words[3] === 0 &&
      words[4] === 0 &&
      words[5] === 0 &&
      words[6] === 0 &&
      words[7] === 1
    ) {
      return true;
    }

    // fe80::/10 — Link-Local Unicast (fe80 - febf)
    if ((words[0] & 0xffc0) === 0xfe80) return true;

    // fc00::/7 — Unique Local Address / ULA (fc00 - fdff)
    if ((words[0] & 0xfe00) === 0xfc00) return true;

    // ff00::/8 — Multicast
    if ((words[0] & 0xff00) === 0xff00) return true;

    return false;
  }

  // Not valid IPv4 or IPv6 -> fail closed
  return true;
}

/**
 * Normalize hostname by stripping enclosing square brackets for IPv6 literals (e.g. "[::1]" -> "::1").
 * Node URL parser preserves brackets in `url.hostname`.
 */
export function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  if (lower.startsWith('[') && lower.endsWith(']')) {
    return lower.slice(1, -1);
  }
  return lower;
}

/**
 * Check if the URL's authority (host:port) exactly matches an allowlisted internal target.
 * Allowed targets are configured via WEBHOOK_ALLOWED_INTERNAL_TARGETS (e.g. "paybridge-api:4000").
 */
export function isAllowedInternalTarget(urlObj: URL, allowedTargetsConfig = ''): boolean {
  if (!allowedTargetsConfig.trim()) return false;

  const allowedList = allowedTargetsConfig
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  // urlObj.host includes port if explicitly specified (e.g. "paybridge-api:4000")
  // For standard HTTP without explicit port, host is "paybridge-api".
  // Normalize authority to include port when matching if needed.
  const hostWithPort = urlObj.port
    ? `${urlObj.hostname.toLowerCase()}:${urlObj.port}`
    : `${urlObj.hostname.toLowerCase()}:${urlObj.protocol === 'https:' ? '443' : '80'}`;

  const directHost = urlObj.host.toLowerCase();

  return allowedList.includes(directHost) || allowedList.includes(hostWithPort);
}

export type DnsLookupFunction = (
  hostname: string,
  options: { all: true }
) => Promise<Array<{ address: string; family: number }> | { address: string; family: number }>;

/**
 * Validate webhook destination URL at delivery time.
 * Enforces protocol policy, internal authority allowlist, and resolves DNS
 * to ensure no resolved IP address belongs to a prohibited/private class.
 */
export async function validateWebhookDestination(
  destinationUrl: string,
  allowedTargetsConfig = '',
  dnsLookupFn?: DnsLookupFunction
): Promise<SsrValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(destinationUrl);
  } catch {
    return { status: 'BLOCKED', reason: 'Invalid URL syntax' };
  }

  // 1. Protocol Scheme Check
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      status: 'BLOCKED',
      reason: `Unsupported protocol scheme '${parsed.protocol}'. Only HTTP and HTTPS are supported.`
    };
  }

  // 2. Exact Internal Authority Exception (e.g. paybridge-api:4000)
  if (isAllowedInternalTarget(parsed, allowedTargetsConfig)) {
    return { status: 'ALLOWED' };
  }

  // 3. For all non-allowlisted targets, plain HTTP is strictly forbidden
  if (parsed.protocol === 'http:') {
    return {
      status: 'BLOCKED',
      reason: 'Plain HTTP is only permitted for configured internal destinations. Public destinations must use HTTPS.'
    };
  }

  // 4. Obvious Hostname Disallowlist (localhost, 127.0.0.1, [::1])
  const rawHostname = parsed.hostname.toLowerCase();
  const hostname = normalizeHostname(rawHostname);

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return {
      status: 'BLOCKED',
      reason: 'Destination hostname localhost is prohibited'
    };
  }

  // If hostname is already an IP literal, evaluate directly without DNS
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      return {
        status: 'BLOCKED',
        reason: `Destination IP address '${rawHostname}' is in a prohibited or private range`
      };
    }
    return { status: 'ALLOWED' };
  }

  // 5. DNS Resolution & Classification
  const lookup = dnsLookupFn ?? dns.lookup;
  let addresses: Array<{ address: string; family: number }>;

  try {
    const res = await lookup(hostname, { all: true });
    addresses = Array.isArray(res) ? res : [res];
  } catch (err: unknown) {
    return {
      status: 'DNS_ERROR',
      error: err instanceof Error ? err : new Error(String(err))
    };
  }

  if (!addresses || addresses.length === 0) {
    return {
      status: 'DNS_ERROR',
      error: new Error(`DNS resolution returned no addresses for host '${hostname}'`)
    };
  }

  for (const entry of addresses) {
    if (isPrivateOrReservedIp(entry.address)) {
      return {
        status: 'BLOCKED',
        reason: `Destination host '${hostname}' resolved to prohibited IP address: ${entry.address}`
      };
    }
  }

  return { status: 'ALLOWED' };
}
