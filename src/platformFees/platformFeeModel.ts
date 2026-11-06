/**
 * What Farmledge charges a warehouse (provision g; design doc §13). Not the
 * storage fees a warehouse charges its farmers: the two never mix.
 */
export type PlatformFeeModelName = 'none' | 'per_bag' | 'revenue_share' | 'subscription';
export const PLATFORM_FEE_MODELS: readonly PlatformFeeModelName[] = [
  'none',
  'per_bag',
  'revenue_share',
  'subscription',
];

export interface PlatformFeeTerms {
  readonly model: PlatformFeeModelName;
  readonly perBagRateNgn: number | null;
}

/** Activity a model may charge on, for one period under one set of terms. */
export interface PlatformFeeActivity {
  readonly bagsIn: number;
}

export interface PlatformFeeAmount {
  /** Null when the model is not built yet. */
  readonly amountNgn: number | null;
  readonly implemented: boolean;
}

export interface PlatformFeeModel {
  readonly name: PlatformFeeModelName;
  compute(terms: PlatformFeeTerms, activity: PlatformFeeActivity): PlatformFeeAmount;
}

const noFee: PlatformFeeModel = {
  name: 'none',
  compute: () => ({ amountNgn: 0, implemented: true }),
};

/** A fixed fee per bag deposited (design doc §11.4: intake fee). */
const perBag: PlatformFeeModel = {
  name: 'per_bag',
  compute: (terms, activity) => ({
    amountNgn: Math.round(activity.bagsIn * (terms.perBagRateNgn ?? 0) * 100) / 100,
    implemented: true,
  }),
};

const stub = (name: PlatformFeeModelName): PlatformFeeModel => ({
  name,
  compute: () => ({ amountNgn: null, implemented: false }),
});

const MODELS: Readonly<Record<PlatformFeeModelName, PlatformFeeModel>> = {
  none: noFee,
  per_bag: perBag,
  revenue_share: stub('revenue_share'),
  subscription: stub('subscription'),
};

export function platformFeeModel(name: PlatformFeeModelName): PlatformFeeModel {
  return MODELS[name];
}
