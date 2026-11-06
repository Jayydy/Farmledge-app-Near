/**
 * Lending against receipts (design doc §3-5). Provided for, not built: the
 * routes exist so the tablet and lender portal can be wired against them.
 * Pledge eligibility lives in `domain/weightPolicy.ts` (`assertPledgeable`).
 */
export interface LendingService {
  lock(request: LockRequest): Promise<never>;
  unlock(lockId: string, request: { readonly requestedBy: string }): Promise<never>;
  startRecovery(lockId: string, request: { readonly requestedBy: string }): Promise<never>;
  completeRecovery(recoveryId: string, request: { readonly requestedBy: string }): Promise<never>;
}

export interface LockRequest {
  readonly depositId: string;
  readonly lenderRef: string;
  readonly amountNgn: number;
  readonly requestedBy: string;
}
