import type pg from 'pg';

/**
 * How a farmer approves an action on their stock (provision e). The record
 * always goes in `farmer_confirmations`, which already supports a pending
 * state and an external reference for two-way SMS/USSD.
 */
export interface FarmerConfirmation {
  readonly mode: 'tablet' | 'sms_two_way';
  /**
   * Records the request inside the caller's transaction. Resolves with the
   * confirmation, approved or pending; throws when it cannot be given.
   */
  request(db: pg.ClientBase, request: ConfirmationRequest): Promise<ConfirmationRecord>;
}

export interface ConfirmationRequest {
  readonly farmerId: string;
  readonly action: 'dispatch' | 'lock' | 'exit';
  readonly subjectId: string;
  /** The tablet's statement that the farmer approved in person. */
  readonly farmerConfirmed: boolean;
}

export interface ConfirmationRecord {
  readonly id: string;
  readonly mode: 'tablet' | 'sms_two_way';
  readonly status: 'pending' | 'approved' | 'rejected' | 'expired';
}
