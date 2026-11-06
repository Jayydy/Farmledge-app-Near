import { NotImplementedError } from '../http/errors.js';
import type { ConfirmationRecord, FarmerConfirmation } from './farmerConfirmation.js';

/**
 * CONFIRMATION_MODE=sms_two_way. Not built: it would record a `pending`
 * confirmation with the SMS/USSD session as `external_ref`, and complete
 * the action when the farmer replies. Until then, actions that need it
 * answer 501.
 */
export class SmsTwoWayConfirmation implements FarmerConfirmation {
  readonly mode = 'sms_two_way';

  request(): Promise<ConfirmationRecord> {
    return Promise.reject(
      new NotImplementedError('Two-way SMS confirmation is not available yet', {
        code: 'not_implemented',
      }),
    );
  }
}
