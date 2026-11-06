import { domainError, fail, ok, type DomainError, type Result } from './errors.js';
import { normaliseNigerianMobile } from './phone.js';

export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 100;

export interface FarmerRegistrationDraft {
  readonly fullName: string;
  readonly phone: string;
  /** Consent to hold the farmer's data (NDPA). Must be true to register. */
  readonly consent: boolean;
  /** Optional consent for lenders to look the farmer up. */
  readonly lookupConsent?: boolean | undefined;
}

export interface ValidFarmerRegistration {
  /** Trimmed, with internal whitespace collapsed. */
  readonly fullName: string;
  /** E.164, e.g. +2348031234567. */
  readonly phone: string;
  readonly lookupConsent: boolean;
}

export function validateFarmerRegistration(
  draft: FarmerRegistrationDraft,
): Result<ValidFarmerRegistration> {
  const errors: DomainError[] = [];

  const fullName = draft.fullName.trim().replace(/\s+/g, ' ');
  if (fullName.length < NAME_MIN_LENGTH || fullName.length > NAME_MAX_LENGTH) {
    errors.push(
      domainError(
        'invalid_name',
        'full_name',
        `Name must be between ${NAME_MIN_LENGTH} and ${NAME_MAX_LENGTH} characters`,
      ),
    );
  }

  const phone = normaliseNigerianMobile(draft.phone);
  if (!phone.ok) errors.push(...phone.errors);

  if (!draft.consent) {
    errors.push(
      domainError(
        'consent_required',
        'consent',
        'The farmer must consent to Farmledge holding their details before they can be registered',
      ),
    );
  }

  if (errors.length > 0 || !phone.ok) return fail(errors);
  return ok({ fullName, phone: phone.value, lookupConsent: draft.lookupConsent ?? false });
}
