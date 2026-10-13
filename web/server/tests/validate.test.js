const { validateTargetUrl, isPrivateOrReservedIP } = require('../src/middleware/validate');

describe('Security & URL Validation', () => {
  describe('isPrivateOrReservedIP', () => {
    test('identifies loopback addresses', () => {
      expect(isPrivateOrReservedIP('127.0.0.1')).toBe(true);
      expect(isPrivateOrReservedIP('127.10.20.30')).toBe(true);
      expect(isPrivateOrReservedIP('::1')).toBe(true);
    });

    test('identifies RFC 1918 private IPv4 ranges', () => {
      expect(isPrivateOrReservedIP('10.0.0.1')).toBe(true);
      expect(isPrivateOrReservedIP('10.254.254.254')).toBe(true);
      expect(isPrivateOrReservedIP('172.16.0.1')).toBe(true);
      expect(isPrivateOrReservedIP('172.31.255.255')).toBe(true);
      expect(isPrivateOrReservedIP('192.168.1.1')).toBe(true);
      expect(isPrivateOrReservedIP('192.168.100.50')).toBe(true);
    });

    test('identifies cloud metadata link-local address', () => {
      expect(isPrivateOrReservedIP('169.254.169.254')).toBe(true);
      expect(isPrivateOrReservedIP('169.254.1.1')).toBe(true);
    });

    test('allows public IPs', () => {
      expect(isPrivateOrReservedIP('8.8.8.8')).toBe(false);
      expect(isPrivateOrReservedIP('1.1.1.1')).toBe(false);
      expect(isPrivateOrReservedIP('142.250.190.46')).toBe(false);
    });
  });

  describe('validateTargetUrl', () => {
    test('rejects missing or empty URLs', () => {
      expect(validateTargetUrl('').valid).toBe(false);
      expect(validateTargetUrl(null).valid).toBe(false);
      expect(validateTargetUrl(undefined).valid).toBe(false);
    });

    test('rejects non-HTTP/HTTPS protocols', () => {
      expect(validateTargetUrl('ftp://example.com').valid).toBe(false);
      expect(validateTargetUrl('file:///etc/passwd').valid).toBe(false);
      expect(validateTargetUrl('javascript:alert(1)').valid).toBe(false);
    });

    test('rejects cloud metadata hosts', () => {
      expect(validateTargetUrl('http://169.254.169.254/latest/meta-data/').valid).toBe(false);
      expect(validateTargetUrl('http://metadata.google.internal/').valid).toBe(false);
    });

    test('blocks localhost when allowLocalTargets is false', () => {
      const res = validateTargetUrl('http://localhost:3000', false);
      expect(res.valid).toBe(false);
      expect(res.error).toMatch(/restricted/i);
    });

    test('permits localhost when allowLocalTargets is true', () => {
      const res = validateTargetUrl('http://localhost:3000', true);
      expect(res.valid).toBe(true);
      expect(res.url).toBe('http://localhost:3000/');
    });

    test('blocks private IPs when allowLocalTargets is false', () => {
      expect(validateTargetUrl('http://192.168.1.100/admin', false).valid).toBe(false);
      expect(validateTargetUrl('http://10.0.0.5/', false).valid).toBe(false);
    });

    test('accepts valid public domain URLs', () => {
      const res = validateTargetUrl('https://example.com/shop');
      expect(res.valid).toBe(true);
      expect(res.url).toBe('https://example.com/shop');
    });
  });
});
