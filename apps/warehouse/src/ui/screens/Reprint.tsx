import { useEffect, useState } from 'react';

import { useI18n } from '../../i18n';
import { parseWholeCount } from '../../lib/numbers';
import { normaliseNigerianMobile } from '../../lib/phone';
import { Slip } from '../../print/Slip';
import type { SlipData } from '../../print/slipData';
import { findDeposits, loadSlip, type ReprintCandidate, type Search } from '../../reprint/find';
import { Keypad } from '../components/Keypad';
import { useApp } from '../services';

type Step = 'choose' | 'phone' | 'number' | 'results';

/**
 * Reprint a lost or faded slip (API D46): any signed-in staff member, any
 * time, no request step. Three taps after the search: find, Print, print.
 */
export function Reprint({ onHome }: { onHome: () => void }) {
  const app = useApp();
  const { t } = useI18n();
  const [step, setStep] = useState<Step>('choose');
  const [phone, setPhone] = useState('');
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ReprintCandidate[]>([]);
  const [localOnly, setLocalOnly] = useState(false);
  const [printing, setPrinting] = useState<SlipData | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  // Print once the slip (and its QR code) is on the page.
  useEffect(() => {
    if (printing === null) return;
    const timer = setTimeout(() => {
      window.print();
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [printing]);

  const search = async (query: Search) => {
    setBusy(true);
    setError(null);
    const result = await findDeposits(
      app.db,
      app.api,
      app.session,
      query,
      app.connection === 'online',
    );
    setBusy(false);
    setResults(result.candidates);
    setLocalOnly(result.localOnly);
    setStep('results');
  };

  const print = async (candidate: ReprintCandidate) => {
    setLoadingId(candidate.depositId);
    setError(null);
    const slip = await loadSlip(
      app.db,
      app.api,
      app.session,
      candidate.depositId,
      app.connection === 'online',
    );
    setLoadingId(null);
    if (slip === null) {
      setError(t('reprintFailed'));
      return;
    }
    setPrinting({ ...slip, reprint: { at: new Date(), by: app.session.custodian.full_name } });
  };

  const back = (
    <button
      type="button"
      className="btn"
      onClick={() => {
        setError(null);
        if (step === 'choose') onHome();
        else setStep('choose');
      }}
    >
      {step === 'choose' ? t('home') : t('back')}
    </button>
  );

  return (
    <main className="screen" data-testid="reprint">
      <h1>{t('reprintTitle')}</h1>
      {error !== null && (
        <p className="message" data-tone="bad" role="alert">
          {error}
        </p>
      )}
      {step === 'choose' && (
        <>
          <p className="hint">{t('reprintHint')}</p>
          <div className="choices">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setStep('phone');
              }}
            >
              {t('findByPhone')}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setStep('number');
              }}
            >
              {t('findByNumber')}
            </button>
          </div>
          <div className="actions">{back}</div>
        </>
      )}
      {step === 'phone' && (
        <>
          <Keypad
            label={t('farmerPhoneTitle')}
            placeholder={t('farmerPhoneTitle')}
            value={phone}
            onChange={setPhone}
            maxLength={14}
          />
          <div className="actions">
            {back}
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || normaliseNigerianMobile(phone) === null}
              onClick={() => void search({ by: 'phone', phone })}
            >
              {busy ? t('searching') : t('next')}
            </button>
          </div>
        </>
      )}
      {step === 'number' && (
        <>
          <Keypad
            label={t('depositNumberTitle')}
            placeholder={t('depositNumberTitle')}
            value={number}
            onChange={setNumber}
            maxLength={9}
          />
          <div className="actions">
            {back}
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || parseWholeCount(number) === null}
              onClick={() => void search({ by: 'number', depositNo: Number(number) })}
            >
              {busy ? t('searching') : t('next')}
            </button>
          </div>
        </>
      )}
      {step === 'results' && (
        <>
          {localOnly && (
            <p className="message" data-tone="warn">
              {t('reprintLocalOnly')}
            </p>
          )}
          {results.length === 0 ? (
            <p className="message">{t('noMatches')}</p>
          ) : (
            <ul className="list">
              {results.map((c) => (
                <li key={c.depositId} className="card" data-testid="reprint-result">
                  <div className="card__line">
                    <span className="card__title">{c.farmerName}</span>
                    <span className="tag" data-tone={c.depositNo === null ? 'warn' : 'ok'}>
                      {c.depositNo === null
                        ? t('notYetSent')
                        : t('depositNumber', { n: c.depositNo })}
                    </span>
                  </div>
                  <div className="card__line">
                    <span>
                      {c.bags} × {t(c.commodity)} · {new Date(c.capturedAt).toLocaleDateString()}
                    </span>
                    <span>{c.reference}</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={loadingId !== null}
                    onClick={() => void print(c)}
                  >
                    🖨 {loadingId === c.depositId ? t('preparingPrint') : t('printThis')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="actions">{back}</div>
        </>
      )}
      {printing !== null && <Slip slip={printing} />}
    </main>
  );
}
