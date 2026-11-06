import { useEffect, useState } from 'react';

import type { LocalDeposit } from '../../db/schema';
import { useI18n } from '../../i18n';
import { Slip, useQrSvg } from '../../print/Slip';
import { slipFromLocal, slipQrPayload } from '../../print/slipData';
import { useApp } from '../services';

/** Re-reads one local deposit whenever the outbox changes. */
export function useLocalDeposit(depositId: string): LocalDeposit | null {
  const { db, revision } = useApp();
  const [deposit, setDeposit] = useState<LocalDeposit | null>(null);
  useEffect(() => {
    let live = true;
    void db.get('deposits', depositId).then((found) => {
      if (live) setDeposit(found ?? null);
    });
    return () => {
      live = false;
    };
  }, [db, depositId, revision]);
  return deposit;
}

/**
 * Shown only after the capture is in IndexedDB. Says plainly whether it is
 * saved on the tablet or already received by the server, and updates live.
 */
export function Success({
  depositId,
  onNext,
  onHome,
}: {
  depositId: string;
  onNext: () => void;
  onHome: () => void;
}) {
  const { t } = useI18n();
  const deposit = useLocalDeposit(depositId);
  const svg = useQrSvg(deposit === null ? '' : slipQrPayload(slipFromLocal(deposit)));
  if (deposit === null) return null;
  const sent = deposit.server !== null;

  return (
    <main className="screen" data-testid="success">
      <div className="done-mark" aria-hidden="true">
        ✓
      </div>
      <h1 style={{ textAlign: 'center' }}>{t('savedTitle')}</h1>
      <p
        className="message"
        data-tone={sent ? 'ok' : 'warn'}
        role="status"
        data-testid="save-state"
      >
        {sent ? t('sentToServer') : t('savedOnTablet')}
      </p>
      <div>
        <p className="hint" style={{ textAlign: 'center' }}>
          {sent ? deposit.warehouse.code : t('reference')}
        </p>
        <p className="reference" data-testid="reference">
          {sent ? t('depositNumber', { n: deposit.server?.deposit_no ?? '' }) : deposit.reference}
        </p>
        {sent && (
          <p className="hint" style={{ textAlign: 'center' }}>
            {t('reference')}: {deposit.reference}
          </p>
        )}
      </div>
      {svg !== null && (
        // Generated locally by the qrcode library from our own payload.
        <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
      )}
      <p className="hint" style={{ textAlign: 'center' }}>
        {deposit.slip === null ? t('slipCaptureNote') : t('slipProofNote')}
      </p>
      <div className="actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            window.print();
          }}
        >
          🖨 {t('print')}
        </button>
        <button type="button" className="btn" onClick={onHome}>
          {t('home')}
        </button>
        <button type="button" className="btn btn--primary" onClick={onNext}>
          {t('anotherDeposit')}
        </button>
      </div>
      <Slip slip={slipFromLocal(deposit)} />
    </main>
  );
}
