import type pg from 'pg';

import { ValidationError } from '../http/errors.js';
import type {
  ConfirmationRecord,
  ConfirmationRequest,
  FarmerConfirmation,
} from './farmerConfirmation.js';

/**
 * CONFIRMATION_MODE=tablet_only. The farmer approves on the custodian's
 * tablet, which sends `farmer_confirmed: true`; the confirmation is
 * approved at once. Without it the request is refused.
 */
export class TabletConfirmation implements FarmerConfirmation {
  readonly mode = 'tablet';

  async request(db: pg.ClientBase, request: ConfirmationRequest): Promise<ConfirmationRecord> {
    if (!request.farmerConfirmed) {
      throw new ValidationError('The farmer has not confirmed', {
        details: [
          {
            code: 'farmer_confirmation_required',
            field: 'farmer_confirmed',
            message: 'The farmer must confirm on the tablet; send farmer_confirmed: true',
          },
        ],
      });
    }
    const { rows } = await db.query<ConfirmationRecord>(
      `INSERT INTO farmer_confirmations (farmer_id, action, subject_id, mode, status, decided_at)
       VALUES ($1, $2, $3, 'tablet', 'approved', now())
       RETURNING id, mode, status`,
      [request.farmerId, request.action, request.subjectId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('confirmation insert returned no row');
    return row;
  }
}
