import { NotImplementedError } from '../http/errors.js';
import type { LendingService } from './lendingService.js';

const notBuilt = (what: string) =>
  Promise.reject(
    new NotImplementedError(`${what} is not implemented in this build`, {
      code: 'not_implemented',
    }),
  );

/** LENDING_ENABLED=true in this build: requests are validated, then answered 501. */
export class NotImplementedLendingService implements LendingService {
  lock(): Promise<never> {
    return notBuilt('Locking a receipt');
  }

  unlock(): Promise<never> {
    return notBuilt('Unlocking a receipt');
  }

  startRecovery(): Promise<never> {
    return notBuilt('Starting a recovery');
  }

  completeRecovery(): Promise<never> {
    return notBuilt('Completing a recovery');
  }
}
