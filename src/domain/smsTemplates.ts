/**
 * Outbound SMS texts. English only for now (docs/decisions.md Q13); each
 * template is a pure function so wording can be tested and translated
 * without touching the services.
 */

export type SmsTemplate =
  'deposit_recorded' | 'dispatch_recorded' | 'fee_statement' | 'proof_ready' | 'balance_statement';

const ngn = (amount: number) =>
  `NGN ${amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function depositRecordedSms(input: {
  warehouseName: string;
  bags: number;
  commodity: string;
  grade: string;
}): string {
  return `Farmledge: ${input.warehouseName} received ${input.bags} bags of ${commodityName(input.commodity)} grade ${input.grade} from you.`;
}

export function dispatchRecordedSms(input: {
  warehouseName: string;
  bags: number;
  commodity: string;
  grade: string;
  deliveryNoteNo: string;
  /** Free bags of this grade left. */
  bagsRemaining: number;
  /** Lot numbers the bags came from. */
  lotsDrawn?: readonly number[];
  /** Bags of this grade pledged or being pledged, which no dispatch can take. */
  bagsHeldOnChain?: number;
}): string {
  const lots =
    input.lotsDrawn === undefined || input.lotsDrawn.length === 0
      ? ''
      : ` from lot${input.lotsDrawn.length > 1 ? 's' : ''} ${input.lotsDrawn.map((n) => `#${n}`).join(', ')}`;
  const held =
    input.bagsHeldOnChain === undefined || input.bagsHeldOnChain === 0
      ? ''
      : ` ${input.bagsHeldOnChain} more are pledged.`;
  return `Farmledge: ${input.bags} bags of ${commodityName(input.commodity)} grade ${input.grade} left ${input.warehouseName}${lots} (note ${input.deliveryNoteNo}). You have ${input.bagsRemaining} bags free there.${held}`;
}

export function proofReadySms(input: {
  warehouseName: string;
  what: string;
  link: string;
}): string {
  return `Farmledge: your proof for ${input.what} at ${input.warehouseName} is ready. Keep it; anyone can check it on the Stellar network: ${input.link}`;
}

export function balanceStatementSms(input: {
  warehouseName: string;
  lots: number;
  link: string;
}): string {
  return `Farmledge: your monthly statement for ${input.warehouseName} (${input.lots} lot${input.lots === 1 ? '' : 's'}) with fresh proofs: ${input.link}`;
}

export function feeStatementSms(input: {
  warehouseName: string;
  outstandingNgn: number;
  accruedThrough: string | null;
}): string {
  const asOf = input.accruedThrough === null ? '' : ` as of ${input.accruedThrough}`;
  return `Farmledge: your storage fees at ${input.warehouseName}${asOf}: ${ngn(input.outstandingNgn)} outstanding.`;
}

function commodityName(commodity: string): string {
  return commodity === 'MAIZE_WHITE'
    ? 'white maize'
    : commodity === 'MAIZE_YELLOW'
      ? 'yellow maize'
      : commodity;
}
