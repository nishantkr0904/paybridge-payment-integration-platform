import { describe, it, expect, vi } from 'vitest';
import {
  isPrivateOrReservedIp,
  isAllowedInternalTarget,
  validateWebhookDestination,
  normalizeHostname,
  type DnsLookupFunction
} from '../../utils/ssrf.js';

describe('SSRF Utility — IP Classification (isPrivateOrReservedIp)', () => {
  describe('IPv4 Loopback (127.0.0.0/8)', () => {
    it('blocks 127.0.0.1', () => {
      expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true);
    });

    it('blocks other 127/8 addresses', () => {
      expect(isPrivateOrReservedIp('127.0.0.2')).toBe(true);
      expect(isPrivateOrReservedIp('127.255.255.255')).toBe(true);
    });
  });

  describe('IPv6 Loopback (::1)', () => {
    it('blocks ::1 and expanded loopback', () => {
      expect(isPrivateOrReservedIp('::1')).toBe(true);
      expect(isPrivateOrReservedIp('0:0:0:0:0:0:0:1')).toBe(true);
    });
  });

  describe('RFC 1918 Private IPv4 Ranges', () => {
    it('blocks 10.0.0.0/8', () => {
      expect(isPrivateOrReservedIp('10.0.0.1')).toBe(true);
      expect(isPrivateOrReservedIp('10.255.255.255')).toBe(true);
    });

    it('blocks 172.16.0.0/12', () => {
      expect(isPrivateOrReservedIp('172.16.0.1')).toBe(true);
      expect(isPrivateOrReservedIp('172.31.255.255')).toBe(true);
    });

    it('allows 172.15.x.x and 172.32.x.x (outside RFC 1918)', () => {
      expect(isPrivateOrReservedIp('172.15.255.255')).toBe(false);
      expect(isPrivateOrReservedIp('172.32.0.1')).toBe(false);
    });

    it('blocks 192.168.0.0/16', () => {
      expect(isPrivateOrReservedIp('192.168.1.1')).toBe(true);
      expect(isPrivateOrReservedIp('192.168.254.254')).toBe(true);
    });
  });

  describe('IPv4 Link-Local & Cloud Metadata (169.254.0.0/16)', () => {
    it('blocks 169.254.169.254 (IMDS metadata endpoint)', () => {
      expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
    });

    it('blocks arbitrary 169.254/16 addresses', () => {
      expect(isPrivateOrReservedIp('169.254.1.1')).toBe(true);
    });
  });

  describe('IPv6 Link-Local (fe80::/10)', () => {
    it('blocks fe80::1', () => {
      expect(isPrivateOrReservedIp('fe80::1')).toBe(true);
      expect(isPrivateOrReservedIp('fe80::200:5aee:feaa:20a2')).toBe(true);
    });
  });

  describe('IPv6 Unique Local / ULA (fc00::/7)', () => {
    it('blocks fc00::1 and fd12:3456::1', () => {
      expect(isPrivateOrReservedIp('fc00::1')).toBe(true);
      expect(isPrivateOrReservedIp('fd12:3456::1')).toBe(true);
    });
  });

  describe('Unspecified & Broadcast Addresses', () => {
    it('blocks 0.0.0.0', () => {
      expect(isPrivateOrReservedIp('0.0.0.0')).toBe(true);
    });

    it('blocks :: (IPv6 unspecified)', () => {
      expect(isPrivateOrReservedIp('::')).toBe(true);
    });

    it('blocks 255.255.255.255 (limited broadcast)', () => {
      expect(isPrivateOrReservedIp('255.255.255.255')).toBe(true);
    });
  });

  describe('Multicast & Reserved Addresses', () => {
    it('blocks IPv4 multicast (224.0.0.0/4)', () => {
      expect(isPrivateOrReservedIp('224.0.0.1')).toBe(true);
      expect(isPrivateOrReservedIp('239.255.255.250')).toBe(true);
    });

    it('blocks IPv4 reserved (240.0.0.0/4)', () => {
      expect(isPrivateOrReservedIp('240.0.0.1')).toBe(true);
      expect(isPrivateOrReservedIp('250.1.2.3')).toBe(true);
    });

    it('blocks IPv6 multicast (ff00::/8)', () => {
      expect(isPrivateOrReservedIp('ff02::1')).toBe(true);
      expect(isPrivateOrReservedIp('ff05::2')).toBe(true);
    });
  });

  describe('Carrier-Grade NAT (100.64.0.0/10)', () => {
    it('blocks 100.64.0.1', () => {
      expect(isPrivateOrReservedIp('100.64.0.1')).toBe(true);
      expect(isPrivateOrReservedIp('100.127.255.255')).toBe(true);
    });

    it('allows 100.63.x.x and 100.128.x.x', () => {
      expect(isPrivateOrReservedIp('100.63.255.255')).toBe(false);
      expect(isPrivateOrReservedIp('100.128.0.1')).toBe(false);
    });
  });

  describe('IPv4-Mapped IPv6 Normalization & Evaluation', () => {
    it('unwraps and blocks ::ffff:127.0.0.1', () => {
      expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
    });

    it('unwraps and blocks ::ffff:169.254.169.254', () => {
      expect(isPrivateOrReservedIp('::ffff:169.254.169.254')).toBe(true);
    });

    it('unwraps and blocks ::ffff:10.0.0.1', () => {
      expect(isPrivateOrReservedIp('::ffff:10.0.0.1')).toBe(true);
    });

    it('unwraps and allows public IPv4-mapped IPv6 like ::ffff:93.184.216.34', () => {
      expect(isPrivateOrReservedIp('::ffff:93.184.216.34')).toBe(false);
    });
  });

  describe('IPv4-Compatible IPv6 (::/96 RFC 4291 § 2.5.5.1)', () => {
    it('blocks loopback ::7f00:1 (embedded 127.0.0.1)', () => {
      expect(isPrivateOrReservedIp('::7f00:1')).toBe(true);
    });

    it('blocks private class A ::a00:1 (embedded 10.0.0.1)', () => {
      expect(isPrivateOrReservedIp('::a00:1')).toBe(true);
    });

    it('blocks cloud metadata ::a9fe:a9fe (embedded 169.254.169.254)', () => {
      expect(isPrivateOrReservedIp('::a9fe:a9fe')).toBe(true);
    });

    it('blocks private class B ::ac10:1 (embedded 172.16.0.1)', () => {
      expect(isPrivateOrReservedIp('::ac10:1')).toBe(true);
    });

    it('blocks private class C ::c0a8:1 (embedded 192.168.0.1)', () => {
      expect(isPrivateOrReservedIp('::c0a8:1')).toBe(true);
    });

    it('allows public IPv4-compatible IPv6 like ::5db8:d822 (embedded 93.184.216.34)', () => {
      expect(isPrivateOrReservedIp('::5db8:d822')).toBe(false);
    });
  });

  describe('6to4 Transition Addresses (2002::/16 RFC 3056)', () => {
    it('blocks embedded loopback 2002:7f00:1:: (127.0.0.1)', () => {
      expect(isPrivateOrReservedIp('2002:7f00:1::')).toBe(true);
    });

    it('blocks embedded cloud metadata 2002:a9fe:a9fe:: (169.254.169.254)', () => {
      expect(isPrivateOrReservedIp('2002:a9fe:a9fe::')).toBe(true);
    });

    it('blocks embedded private class A 2002:a00:1:: (10.0.0.1)', () => {
      expect(isPrivateOrReservedIp('2002:a00:1::')).toBe(true);
    });

    it('blocks embedded private class C 2002:c0a8:1:: (192.168.0.1)', () => {
      expect(isPrivateOrReservedIp('2002:c0a8:1::')).toBe(true);
    });

    it('allows public embedded IPv4 like 2002:5db8:d822:: (93.184.216.34)', () => {
      expect(isPrivateOrReservedIp('2002:5db8:d822::')).toBe(false);
    });

    it('allows ordinary non-6to4 IPv6 addresses like 2001:db8::1', () => {
      expect(isPrivateOrReservedIp('2001:db8::1')).toBe(false);
    });
  });

  describe('Public Routable IP Addresses', () => {
    it('allows public IPv4 addresses', () => {
      expect(isPrivateOrReservedIp('93.184.216.34')).toBe(false);
      expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false);
      expect(isPrivateOrReservedIp('1.1.1.1')).toBe(false);
    });

    it('allows public IPv6 addresses', () => {
      expect(isPrivateOrReservedIp('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
      expect(isPrivateOrReservedIp('2001:4860:4860::8888')).toBe(false);
    });
  });
});

describe('SSRF Utility — Internal Target Authority (isAllowedInternalTarget)', () => {
  const allowedConfig = 'paybridge-api:4000';

  it('allows exact match for paybridge-api:4000', () => {
    const url = new URL('http://paybridge-api:4000/api/webhooks/test-listener');
    expect(isAllowedInternalTarget(url, allowedConfig)).toBe(true);
  });

  it('blocks paybridge-api on port 3306', () => {
    const url = new URL('http://paybridge-api:3306/');
    expect(isAllowedInternalTarget(url, allowedConfig)).toBe(false);
  });

  it('blocks paybridge-api on port 6379', () => {
    const url = new URL('http://paybridge-api:6379/');
    expect(isAllowedInternalTarget(url, allowedConfig)).toBe(false);
  });

  it('blocks paybridge-api without explicit port (defaults to port 80)', () => {
    const url = new URL('http://paybridge-api/api/webhooks/test-listener');
    expect(isAllowedInternalTarget(url, allowedConfig)).toBe(false);
  });

  it('blocks paybridge-mysql:3306', () => {
    const url = new URL('http://paybridge-mysql:3306/');
    expect(isAllowedInternalTarget(url, allowedConfig)).toBe(false);
  });

  it('blocks paybridge-redis:6379', () => {
    const url = new URL('http://paybridge-redis:6379/');
    expect(isAllowedInternalTarget(url, allowedConfig)).toBe(false);
  });

  it('blocks paybridge-rabbitmq:5672', () => {
    const url = new URL('http://paybridge-rabbitmq:5672/');
    expect(isAllowedInternalTarget(url, allowedConfig)).toBe(false);
  });

  it('blocks localhost:4000', () => {
    const url = new URL('http://localhost:4000/api/webhooks/test-listener');
    expect(isAllowedInternalTarget(url, allowedConfig)).toBe(false);
  });

  it('blocks when allowedTargetsConfig is empty', () => {
    const url = new URL('http://paybridge-api:4000/api/webhooks/test-listener');
    expect(isAllowedInternalTarget(url, '')).toBe(false);
  });
});

describe('SSRF Utility — Destination Validation (validateWebhookDestination)', () => {
  const allowedConfig = 'paybridge-api:4000';

  it('allows public HTTPS endpoint when DNS resolves to public IP', async () => {
    const mockLookup: DnsLookupFunction = vi.fn().mockResolvedValue([
      { address: '93.184.216.34', family: 4 }
    ]);

    const result = await validateWebhookDestination(
      'https://api.merchant.com/webhook',
      allowedConfig,
      mockLookup
    );

    expect(result.status).toBe('ALLOWED');
    expect(mockLookup).toHaveBeenCalledWith('api.merchant.com', { all: true });
  });

  it('blocks plain HTTP public endpoint without DNS lookup', async () => {
    const mockLookup: DnsLookupFunction = vi.fn();

    const result = await validateWebhookDestination(
      'http://api.merchant.com/webhook',
      allowedConfig,
      mockLookup
    );

    expect(result.status).toBe('BLOCKED');
    if (result.status === 'BLOCKED') {
      expect(result.reason).toContain('Plain HTTP is only permitted');
    }
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('blocks unsupported schemes (ftp:, file:, gopher:)', async () => {
    const mockLookup: DnsLookupFunction = vi.fn();

    const result = await validateWebhookDestination(
      'ftp://api.merchant.com/webhook',
      allowedConfig,
      mockLookup
    );

    expect(result.status).toBe('BLOCKED');
    if (result.status === 'BLOCKED') {
      expect(result.reason).toContain('Unsupported protocol scheme');
    }
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('allows exact internal destination http://paybridge-api:4000 without DNS check', async () => {
    const mockLookup: DnsLookupFunction = vi.fn();

    const result = await validateWebhookDestination(
      'http://paybridge-api:4000/api/webhooks/test-listener',
      allowedConfig,
      mockLookup
    );

    expect(result.status).toBe('ALLOWED');
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('blocks paybridge-api on port 3306', async () => {
    const mockLookup: DnsLookupFunction = vi.fn();

    const result = await validateWebhookDestination(
      'http://paybridge-api:3306/',
      allowedConfig,
      mockLookup
    );

    expect(result.status).toBe('BLOCKED');
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('blocks localhost:4000 even if HTTP', async () => {
    const mockLookup: DnsLookupFunction = vi.fn();

    const result = await validateWebhookDestination(
      'http://localhost:4000/webhook',
      allowedConfig,
      mockLookup
    );

    expect(result.status).toBe('BLOCKED');
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('blocks hostname resolving to a private IP (10.0.0.1)', async () => {
    const mockLookup: DnsLookupFunction = vi.fn().mockResolvedValue([
      { address: '10.0.0.1', family: 4 }
    ]);

    const result = await validateWebhookDestination(
      'https://internal.merchant.com/webhook',
      allowedConfig,
      mockLookup
    );

    expect(result.status).toBe('BLOCKED');
    if (result.status === 'BLOCKED') {
      expect(result.reason).toContain('prohibited IP address: 10.0.0.1');
    }
  });

  it('blocks hostname resolving to multiple IPs when ANY IP is private', async () => {
    const mockLookup: DnsLookupFunction = vi.fn().mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 }
    ]);

    const result = await validateWebhookDestination(
      'https://dual-homed.merchant.com/webhook',
      allowedConfig,
      mockLookup
    );

    expect(result.status).toBe('BLOCKED');
    if (result.status === 'BLOCKED') {
      expect(result.reason).toContain('prohibited IP address: 127.0.0.1');
    }
  });

  it('returns DNS_ERROR on resolver failure (transient network failure)', async () => {
    const dnsError = Object.assign(new Error('getaddrinfo EAI_AGAIN api.merchant.com'), {
      code: 'EAI_AGAIN'
    });
    const mockLookup: DnsLookupFunction = vi.fn().mockRejectedValue(dnsError);

    const result = await validateWebhookDestination(
      'https://api.merchant.com/webhook',
      allowedConfig,
      mockLookup
    );

    expect(result.status).toBe('DNS_ERROR');
    if (result.status === 'DNS_ERROR') {
      expect(result.error).toBe(dnsError);
    }
  });

  it('blocks literal private IP addresses directly without DNS lookup', async () => {
    const mockLookup: DnsLookupFunction = vi.fn();

    const result = await validateWebhookDestination(
      'https://169.254.169.254/latest/meta-data',
      allowedConfig,
      mockLookup
    );

    expect(result.status).toBe('BLOCKED');
    expect(mockLookup).not.toHaveBeenCalled();
  });

  describe('Bracketed IPv6 Destination Validation (normalizeHostname)', () => {
    it('blocks bracketed loopback https://[::1]/webhook without DNS lookup', async () => {
      const mockLookup: DnsLookupFunction = vi.fn();
      const result = await validateWebhookDestination(
        'https://[::1]/webhook',
        allowedConfig,
        mockLookup
      );
      expect(result.status).toBe('BLOCKED');
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('blocks bracketed link-local https://[fe80::1]/webhook without DNS lookup', async () => {
      const mockLookup: DnsLookupFunction = vi.fn();
      const result = await validateWebhookDestination(
        'https://[fe80::1]/webhook',
        allowedConfig,
        mockLookup
      );
      expect(result.status).toBe('BLOCKED');
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('blocks bracketed IPv4-mapped loopback https://[::ffff:127.0.0.1]/webhook', async () => {
      const mockLookup: DnsLookupFunction = vi.fn();
      const result = await validateWebhookDestination(
        'https://[::ffff:127.0.0.1]/webhook',
        allowedConfig,
        mockLookup
      );
      expect(result.status).toBe('BLOCKED');
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('blocks bracketed IPv4-mapped metadata https://[::ffff:169.254.169.254]/webhook', async () => {
      const mockLookup: DnsLookupFunction = vi.fn();
      const result = await validateWebhookDestination(
        'https://[::ffff:169.254.169.254]/webhook',
        allowedConfig,
        mockLookup
      );
      expect(result.status).toBe('BLOCKED');
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('blocks bracketed IPv4-compatible loopback https://[::7f00:1]/webhook', async () => {
      const mockLookup: DnsLookupFunction = vi.fn();
      const result = await validateWebhookDestination(
        'https://[::7f00:1]/webhook',
        allowedConfig,
        mockLookup
      );
      expect(result.status).toBe('BLOCKED');
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('blocks bracketed 6to4 loopback https://[2002:7f00:1::]/webhook', async () => {
      const mockLookup: DnsLookupFunction = vi.fn();
      const result = await validateWebhookDestination(
        'https://[2002:7f00:1::]/webhook',
        allowedConfig,
        mockLookup
      );
      expect(result.status).toBe('BLOCKED');
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('allows bracketed public IPv6 address https://[2606:4700:4700::1111]/webhook', async () => {
      const mockLookup: DnsLookupFunction = vi.fn();
      const result = await validateWebhookDestination(
        'https://[2606:4700:4700::1111]/webhook',
        allowedConfig,
        mockLookup
      );
      expect(result.status).toBe('ALLOWED');
      expect(mockLookup).not.toHaveBeenCalled();
    });
  });
});

describe('SSRF Utility — Hostname Normalization (normalizeHostname)', () => {
  it('strips enclosing brackets from IPv6 literal', () => {
    expect(normalizeHostname('[::1]')).toBe('::1');
    expect(normalizeHostname('[fe80::1]')).toBe('fe80::1');
    expect(normalizeHostname('[::ffff:127.0.0.1]')).toBe('::ffff:127.0.0.1');
  });

  it('preserves unbracketed hostname and IPv4 literals', () => {
    expect(normalizeHostname('example.com')).toBe('example.com');
    expect(normalizeHostname('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeHostname('paybridge-api')).toBe('paybridge-api');
  });

  it('handles lowercase conversion', () => {
    expect(normalizeHostname('[FE80::1]')).toBe('fe80::1');
    expect(normalizeHostname('EXAMPLE.COM')).toBe('example.com');
  });
});
