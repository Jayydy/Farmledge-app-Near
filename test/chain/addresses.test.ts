import { describe, expect, it } from 'vitest';

import {
  addressFor,
  isValidAccount,
  MANAGED_SUBJECT,
  OPERATOR_SUBJECT,
  subjectOf,
} from '../../src/chain/addresses.js';
import type { KeyService } from '../../src/keys/keyService.js';

const SAMPLE_PUB_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const fakeKeys: KeyService = {
  publicKey: () => Promise.resolve(SAMPLE_PUB_HEX),
  sign: () => Promise.resolve('00'.repeat(64)),
};

describe('chain address derivation and validation (test/chain/addresses.test.ts)', () => {
  describe('addressFor', () => {
    it('returns a 56-character Stellar G... address when backend=stellar (default)', async () => {
      const stellarAddr = await addressFor(fakeKeys, OPERATOR_SUBJECT);
      expect(stellarAddr).toMatch(/^G[A-Z2-7]{55}$/);
      expect(await addressFor(fakeKeys, OPERATOR_SUBJECT, 'stellar')).toBe(stellarAddr);
    });

    it('returns the 64-character lowercase hex implicit account ID when backend=near', async () => {
      const nearAddr = await addressFor(fakeKeys, subjectOf.farmer('f-1'), 'near');
      expect(nearAddr).toBe(SAMPLE_PUB_HEX);
      expect(nearAddr).toMatch(/^[0-9a-f]{64}$/);
    });

    it('never exposes a lender subject in MANAGED_SUBJECT (D31)', () => {
      expect(MANAGED_SUBJECT.test(OPERATOR_SUBJECT)).toBe(true);
      expect(MANAGED_SUBJECT.test(subjectOf.farmer('123'))).toBe(true);
      expect(MANAGED_SUBJECT.test(subjectOf.custodian('123'))).toBe(true);
      expect(MANAGED_SUBJECT.test(subjectOf.verifier('123'))).toBe(true);
      expect(MANAGED_SUBJECT.test('lender:123')).toBe(false);
    });
  });

  describe('isValidAccount', () => {
    it('validates Stellar G... public keys when backend=stellar', async () => {
      const validG = await addressFor(fakeKeys, OPERATOR_SUBJECT, 'stellar');
      expect(isValidAccount(validG, 'stellar')).toBe(true);
      expect(isValidAccount('lender.testnet', 'stellar')).toBe(false);
      expect(isValidAccount(SAMPLE_PUB_HEX, 'stellar')).toBe(false);
      expect(isValidAccount('G' + 'A'.repeat(55), 'stellar')).toBe(false); // bad checksum
    });

    it.each([
      ['64-char hex implicit account', SAMPLE_PUB_HEX],
      ['named testnet account', 'lender.testnet'],
      ['subaccount with hyphen and underscore', 'farmledge-receipt.team_1.testnet'],
      ['2-char minimum account', 'ab'],
    ])('accepts valid NEAR account (%s) when backend=near', (_label, account) => {
      expect(isValidAccount(account, 'near')).toBe(true);
    });

    it.each([
      ['Stellar G-address (uppercase)', 'GBW6TA5UJMXJY2VYPJV6WUVWNUP3PKZNPXFMC2CNVCWZDF3SKIT4UAIN'],
      ['uppercase named account', 'Lender.testnet'],
      ['single character', 'a'],
      ['65 characters (too long)', 'a'.repeat(65)],
      ['leading dot', '.lender.testnet'],
      ['trailing hyphen', 'lender-'],
      ['consecutive dots', 'lender..testnet'],
      ['consecutive hyphens', 'lender--1.testnet'],
    ])('rejects invalid NEAR account (%s) when backend=near', (_label, account) => {
      expect(isValidAccount(account, 'near')).toBe(false);
    });
  });
});
