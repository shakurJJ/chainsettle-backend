/**
 * Masks the last octet of an IPv4 address for privacy.
 * Examples:
 *   '192.168.1.42'        -> '192.168.1.xxx'
 *   '::ffff:192.168.1.42' -> '::ffff:192.168.1.xxx'
 *   '2001:db8::1'         -> '2001:db8::1'
 *   null / undefined      -> null
 */
export function maskIpAddress(ip?: string | null): string | null {
  if (!ip) return null;
  const trimmed = ip.trim();
  if (!trimmed) return null;

  const ipv4Regex = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/;
  if (ipv4Regex.test(trimmed)) {
    return trimmed.replace(ipv4Regex, '$1.xxx');
  }

  const ipv4MappedRegex = /^(::ffff:)(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/i;
  if (ipv4MappedRegex.test(trimmed)) {
    return trimmed.replace(ipv4MappedRegex, '$1$2.xxx');
  }

  return trimmed;
}
