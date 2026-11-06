import { useState } from 'react';

import { signIn, unlock, type SignInOutcome } from '../../auth/sessions';
import type { StoredSession } from '../../db/schema';
import { useI18n, type Translate } from '../../i18n';
import { PIN_LENGTH_DIGITS } from '../../lib/pin';
import { normaliseNigerianMobile } from '../../lib/phone';
import type { Services } from '../services';
import { Keypad } from '../components/Keypad';

function failureText(t: Translate, outcome: Extract<SignInOutcome, { ok: false }>): string {
  switch (outcome.reason) {
    case 'invalid_phone':
      return t('signInInvalidPhone');
    case 'invalid_credentials':
      return t('signInInvalid');
    case 'locked_out':
      return t('signInLockedOut');
    case 'offline_unknown':
      return t('signInOfflineUnknown');
    case 'offline_locked':
      return t('signInOfflineLocked');
    case 'server':
      return t('signInServer');
  }
}

/** Phone, then PIN: one thing per screen. */
export function SignIn({
  services,
  online,
  onSignedIn,
}: {
  services: Services;
  online: boolean;
  onSignedIn: (session: StoredSession) => void;
}) {
  const { t } = useI18n();
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [step, setStep] = useState<'phone' | 'pin'>('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const outcome = await signIn(services.db, services.api, phone, pin, online);
    setBusy(false);
    if (outcome.ok) {
      onSignedIn(outcome.session);
    } else {
      setError(failureText(t, outcome));
      setPin('');
      if (outcome.reason === 'invalid_phone') setStep('phone');
    }
  };

  return (
    <main className="screen">
      <h1>{t('signInTitle')}</h1>
      {error !== null && (
        <p className="message" data-tone="bad" role="alert">
          {error}
        </p>
      )}
      {step === 'phone' ? (
        <>
          <Keypad
            label={t('yourPhone')}
            placeholder={t('yourPhone')}
            value={phone}
            onChange={setPhone}
            maxLength={14}
          />
          <div className="actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={normaliseNigerianMobile(phone) === null}
              onClick={() => {
                setError(null);
                setStep('pin');
              }}
            >
              {t('next')}
            </button>
          </div>
        </>
      ) : (
        <>
          <Keypad
            label={t('yourPin')}
            placeholder={t('yourPin')}
            value={pin}
            onChange={setPin}
            maxLength={PIN_LENGTH_DIGITS}
            masked
          />
          <div className="actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setPin('');
                setStep('phone');
              }}
            >
              {t('back')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={pin.length !== PIN_LENGTH_DIGITS || busy}
              onClick={() => void submit()}
            >
              {busy ? t('signingIn') : t('signIn')}
            </button>
          </div>
        </>
      )}
    </main>
  );
}

/** The idle lock: the same custodian's PIN unlocks, offline too. */
export function LockScreen({
  services,
  session,
  onUnlocked,
  onSwitchUser,
  hasDraft,
}: {
  services: Services;
  session: StoredSession;
  onUnlocked: (session: StoredSession) => void;
  onSwitchUser: () => void;
  hasDraft: boolean;
}) {
  const { t } = useI18n();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    const outcome = await unlock(services.db, session.id, pin);
    setBusy(false);
    setPin('');
    if (outcome.ok) onUnlocked(outcome.session);
    else setError(failureText(t, outcome));
  };

  return (
    <main className="screen">
      <h1>{t('lockedTitle')}</h1>
      <p className="hint">{t('lockedFor', { name: session.custodian.full_name })}</p>
      {error !== null && (
        <p className="message" data-tone="bad" role="alert">
          {error}
        </p>
      )}
      <Keypad
        label={t('yourPin')}
        placeholder={t('yourPin')}
        value={pin}
        onChange={setPin}
        maxLength={PIN_LENGTH_DIGITS}
        masked
      />
      {hasDraft && (
        <p className="message" data-tone="warn">
          {t('switchUserWarning')}
        </p>
      )}
      <div className="actions">
        <button type="button" className="btn" onClick={onSwitchUser}>
          {t('switchUser')}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={pin.length !== PIN_LENGTH_DIGITS || busy}
          onClick={() => void submit()}
        >
          {t('unlock')}
        </button>
      </div>
    </main>
  );
}
