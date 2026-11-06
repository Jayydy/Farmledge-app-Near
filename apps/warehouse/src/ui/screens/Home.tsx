import { useEffect, useState } from 'react';

import type { LocalDeposit, PendingDispatch } from '../../db/schema';
import { dispatchReference } from '../../dispatch/pending';
import { useI18n } from '../../i18n';
import { useApp } from '../services';
import { TodayPanel } from './Summary';

export function Home({
  onNewDeposit,
  onDispatch,
  onBalance,
  onOpenPending,
  onReprint,
  onOpen,
  onSummary,
  onStockCount,
}: {
  onNewDeposit: () => void;
  onDispatch: () => void;
  onBalance: () => void;
  onOpenPending: (dispatchId: string) => void;
  onReprint: () => void;
  onOpen: (depositId: string) => void;
  onSummary: () => void;
  onStockCount: () => void;
}) {
  const app = useApp();
  const { t } = useI18n();
  const [today, setToday] = useState<LocalDeposit[]>([]);
  const [pending, setPending] = useState<PendingDispatch[]>([]);

  useEffect(() => {
    let live = true;
    void app.db.getAll('pendingDispatches').then((all) => {
      if (live) setPending(all.sort((a, b) => a.firstSentAt - b.firstSentAt));
    });
    return () => {
      live = false;
    };
  }, [app.db, app.revision]);

  useEffect(() => {
    let live = true;
    void app.db.getAll('deposits').then((all) => {
      if (!live) return;
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      setToday(
        all
          .filter((d) => Date.parse(d.captured_at) >= start.getTime())
          .sort((a, b) => b.captured_at.localeCompare(a.captured_at)),
      );
    });
    return () => {
      live = false;
    };
  }, [app.db, app.revision]);

  return (
    <main className="screen">
      {pending.length > 0 && (
        <section className="banner" role="status" data-testid="pending-dispatches">
          <strong>{t('pendingDispatchesTitle')}</strong>
          <ul className="list">
            {pending.map((p) => (
              <li key={p.dispatchId}>
                <button
                  type="button"
                  className="btn card"
                  style={{ textAlign: 'left' }}
                  data-testid="pending-dispatch"
                  onClick={() => {
                    onOpenPending(p.dispatchId);
                  }}
                >
                  <span className="card__line" style={{ width: '100%' }}>
                    <span className="card__title">{p.farmerName}</span>
                    <span
                      className="tag"
                      data-tone={
                        p.state === 'recorded' ? 'ok' : p.state === 'unconfirmed' ? 'warn' : 'bad'
                      }
                    >
                      {t(
                        p.state === 'recorded'
                          ? 'pendingRecorded'
                          : p.state === 'unconfirmed'
                            ? 'pendingUnconfirmed'
                            : 'pendingNotRecorded',
                      )}
                    </span>
                  </span>
                  <span className="card__line" style={{ width: '100%' }}>
                    <span>{dispatchReference(p.dispatchId)}</span>
                    <span>{t('bagsCount', { n: p.request.bag_count })}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <button type="button" className="btn btn--primary btn--huge" onClick={onNewDeposit}>
        + {t('newDeposit')}
      </button>
      <div className="choices">
        <button
          type="button"
          className="btn btn--huge"
          data-tone={app.connection === 'online' ? undefined : 'muted'}
          onClick={onDispatch}
        >
          {t('dispatch')}
          {app.connection !== 'online' && <small>{t('needsConnection')}</small>}
        </button>
        <button type="button" className="btn btn--huge" onClick={onBalance}>
          {t('farmerBalance')}
        </button>
      </div>
      <button type="button" className="btn" onClick={onReprint}>
        🖨 {t('reprint')}
      </button>
      <TodayPanel onSummary={onSummary} onStockCount={onStockCount} />
      <h1>{t('todaysDeposits')}</h1>
      {today.length === 0 ? (
        <p className="hint">{t('noDepositsToday')}</p>
      ) : (
        <ul className="list">
          {today.map((d) => (
            <li key={d.deposit_id}>
              <button
                type="button"
                className="btn card"
                style={{ textAlign: 'left' }}
                onClick={() => {
                  onOpen(d.deposit_id);
                }}
              >
                <span className="card__line" style={{ width: '100%' }}>
                  <span className="card__title">{d.farmer.full_name}</span>
                  <span className="tag" data-tone={d.server === null ? 'warn' : 'ok'}>
                    {d.server === null
                      ? t('state_pending')
                      : t('depositNumber', { n: d.server.deposit_no })}
                  </span>
                </span>
                <span className="card__line" style={{ width: '100%' }}>
                  <span>
                    {d.bag_count} × {t(d.commodity)} · {t('grade', { grade: d.grade })}
                  </span>
                  <span>
                    {new Date(d.captured_at).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
