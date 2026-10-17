import { describe, expect, it } from 'vitest';
import { base64Url, challengeS256, generateVerifier } from './pkce';

describe('PKCE helpers', () => {
  it('generates a verifier of the requested length from the unreserved charset', () => {
    for (const len of [43, 64, 128]) {
      const v = generateVerifier(len);
      expect(v).toHaveLength(len);
      expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
    }
    expect(generateVerifier()).toHaveLength(64);
  });

  it('rejects out-of-range lengths', () => {
    expect(() => generateVerifier(42)).toThrow(RangeError);
    expect(() => generateVerifier(129)).toThrow(RangeError);
  });

  it('is not constant', () => {
    expect(generateVerifier()).not.toBe(generateVerifier());
  });

  it('computes S256 challenge matching the RFC 7636 appendix B vector', async () => {
    expect(await challengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('base64url has no padding or +/ characters', () => {
    expect(base64Url(new Uint8Array([251, 255, 254]))).toBe('-__-');
  });
});
