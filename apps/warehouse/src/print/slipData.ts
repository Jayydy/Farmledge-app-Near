import type { LocalDeposit } from '../db/schema';
import { shortReference } from '../lib/numbers';
import type { Commodity, DepositSlip } from '../types/api';

/** Everything a printed slip shows, from this tablet's record or from the API. */
export interface SlipData {
  depositId: string;
  reference: string;
  /** Null until the API has the deposit: then it is a capture receipt, not proof. */
  depositNo: number | null;
  warehouse: { code: string; name: string };
  capturedAt: string;
  farmer: { full_name: string; phone: string };
  commodity: Commodity;
  grade: string;
  moisturePct: number;
  bags: number;
  custodian: string;
  verifier: string;
  /** The API's slip QR payload (provisional encoding, API D45); null before sync. */
  proofPayload: string | null;
  /** Set when this print replaces an earlier slip (API D46). */
  reprint: { at: Date; by: string } | null;
}

export function slipFromLocal(deposit: LocalDeposit): SlipData {
  return {
    depositId: deposit.deposit_id,
    reference: deposit.reference,
    depositNo: deposit.server?.deposit_no ?? null,
    warehouse: { code: deposit.warehouse.code, name: deposit.warehouse.name },
    capturedAt: deposit.captured_at,
    farmer: deposit.farmer,
    commodity: deposit.commodity,
    grade: deposit.grade,
    moisturePct: deposit.moisture_pct,
    bags: deposit.bag_count,
    custodian: deposit.custodian.full_name,
    verifier: deposit.verifier.full_name,
    proofPayload: deposit.slip?.qr_payload ?? null,
    reprint: null,
  };
}

export function slipFromServer(slip: DepositSlip): SlipData {
  const { deposit, printable } = slip;
  return {
    depositId: deposit.deposit_id,
    reference: shortReference(deposit.deposit_id),
    depositNo: deposit.deposit_no,
    warehouse: printable.warehouse,
    capturedAt: deposit.captured_at,
    farmer: printable.farmer,
    commodity: deposit.commodity as Commodity,
    grade: deposit.grade,
    moisturePct: deposit.moisture_pct,
    bags: deposit.bag_count,
    custodian: printable.custodian.full_name,
    verifier: printable.verifier.full_name,
    proofPayload: slip.proofs[0]?.qr_payload ?? null,
    reprint: null,
  };
}

/** What the slip's QR carries: the proof payload, or a capture receipt before sync. */
export function slipQrPayload(slip: SlipData): string {
  return slip.proofPayload ?? `farmledge:capture:${slip.depositId}`;
}
