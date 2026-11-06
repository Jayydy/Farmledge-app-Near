import type { KeyService } from './keyService.js';

/**
 * Placeholder for a cloud KMS / HSM adapter (design doc §6). Not built;
 * `createKeyService` refuses to start with KEY_SERVICE=kms.
 */
export class KmsKeyService implements KeyService {
  publicKey(): Promise<string> {
    return Promise.reject(new Error('KmsKeyService is not implemented'));
  }

  sign(): Promise<string> {
    return Promise.reject(new Error('KmsKeyService is not implemented'));
  }
}
