import { useEffect, useState } from 'react';

import type { LocalDeposit, OutboxItem, StoredSession } from '../../db/schema';
import { errorText, useI18n, type Translate } from '../../i18n';
import { useApp } from '../services';

interface Group {
  key: string;
  deposit: LocalDeposit | null;
  items: OutboxItem[];
}

const HOUR_MS = 3600_000;

function stateOf(
  item: OutboxItem,
  all: Map<string, OutboxItem>,
  sessions: Map<string, StoredSession>,
  t: Translate,
) {
  if (item.status === 'failed') return { text: t('state_failed'), tone: 'bad' };
  if (item.status === 'sending') return { text: t('state_sending'), tone: 'warn' };
  if (item.lastError?.kind === 'needs_sign_in') {
    const name = sessions.get(item.sessionId)?.custodian.full_name ?? '…';
    return { text: t('state_needs_sign_in', { name }), tone: 'warn' };
  }
  if (item.dependsOn.some((id) => all.get(id)?.status === 'failed')) {
    return { text: t('state_blocked'), tone: 'bad' };
  }
  return { text: t('state_pending'), tone: 'warn' };
}

function wait(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** Everything not yet sent, grouped by deposit, with why and a retry. */
export function Queue() {
  const app = useApp();
  const { t, language } = useI18n();
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [deposits, setDeposits] = useState<Map<string, LocalDeposit>>(new Map());
  const [sessions, setSessions] = useState<Map<string, StoredSession>>(new Map());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    void Promise.all([
      app.db.getAll('outbox'),
      app.db.getAll('deposits'),
      app.db.getAll('sessions'),
    ]).then(([outbox, local, stored]) => {
      if (!live) return;
      setItems(outbox.filter((item) => item.status !== 'done'));
      setDeposits(new Map(local.map((d) => [d.deposit_id, d])));
      setSessions(new Map(stored.map((s) => [s.id, s])));
      setNow(Date.now());
    });
    return () => {
      live = false;
    };
  }, [app.db, app.revision]);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 5_000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const all = new Map(items.map((item) => [item.opId, item]));
  const groups: Group[] = [];
  for (const item of [...items].sort((a, b) => a.createdAt - b.createdAt)) {
    // A farmer registration is shown with the first deposit waiting on it.
    const depositId =
      item.depositId ??
      items.find((other) => other.kind === 'deposit' && other.dependsOn.includes(item.opId))
        ?.depositId ??
      null;
    const key = depositId ?? item.opId;
    let group = groups.find((g) => g.key === key);
    if (group === undefined) {
      group = {
        key,
        deposit: depositId === null ? null : (deposits.get(depositId) ?? null),
        items: [],
      };
      groups.push(group);
    }
    group.items.push(item);
  }

  const retry = async (opIds?: string[]) => {
    await app.engine.retry(opIds);
    await app.syncNow();
  };
  const failedIds = items.filter((item) => item.status === 'failed').map((item) => item.opId);
  const { offline_review_after_hours: reviewHours, offline_reject_after_hours: rejectHours } =
    app.features.intake;

  return (
    <main className="screen" data-testid="queue">
      <h1>{t('queueTitle')}</h1>
      {groups.length === 0 ? (
        <p className="message" data-tone="ok">
          {t('queueEmpty')}
        </p>
      ) : (
        <>
          <div className="actions" style={{ marginTop: 0 }}>
            <button
              type="button"
              className="btn btn--primary"
              disabled={app.connection === 'offline'}
              onClick={() =>
                void retry(items.filter((i) => i.status === 'pending').map((i) => i.opId))
              }
            >
              {t('sendNow')}
            </button>
            {failedIds.length > 0 && (
              <button type="button" className="btn" onClick={() => void retry(failedIds)}>
                {t('retryAll')}
              </button>
            )}
          </div>
          <ul className="list">
            {groups.map((group) => {
              const ageHours =
                group.deposit === null
                  ? 0
                  : (now - Date.parse(group.deposit.captured_at)) / HOUR_MS;
              const anyFailed = group.items.some((item) => item.status === 'failed');
              return (
                <li
                  key={group.key}
                  className="card"
                  data-tone={anyFailed ? 'bad' : undefined}
                  data-testid="queue-group"
                >
                  <div className="card__line">
                    <span className="card__title">
                      {group.deposit?.farmer.full_name ??
                        t(
                          group.items[0]?.kind === 'dispatchBlocked'
                            ? 'kind_dispatchBlocked'
                            : 'kind_farmer',
                        )}
                    </span>
                    <span>{group.deposit?.reference}</span>
                  </div>
                  {ageHours > reviewHours && (
                    <p
                      className="message"
                      data-tone={ageHours > rejectHours * 0.75 ? 'bad' : 'warn'}
                    >
                      {ageHours > rejectHours * 0.75
                        ? t('ageReject', { hours: Math.floor(ageHours), max: rejectHours })
                        : t('ageReview', { hours: Math.floor(ageHours) })}
                    </p>
                  )}
                  {group.items.map((item) => {
                    const state = stateOf(item, all, sessions, t);
                    return (
                      <div key={item.opId} className="card__line">
                        <span>{t(`kind_${item.kind}`)}</span>
                        <span>
                          <span className="tag" data-tone={state.tone}>
                            {state.text}
                          </span>{' '}
                          {item.status === 'pending' &&
                            item.attempts > 0 &&
                            item.nextAttemptAt > now && (
                              <small>
                                {t('nextTryIn', { time: wait(item.nextAttemptAt - now) })} ·{' '}
                                {t('attempts', { n: item.attempts })}
                              </small>
                            )}
                        </span>
                        {item.status === 'failed' && item.lastError !== null && (
                          <div style={{ width: '100%' }}>
                            <p className="hint">
                              {errorText(language, item.lastError.code, item.lastError.message)}
                            </p>
                            <p className="hint">{t('failedHelp')}</p>
                            <button
                              type="button"
                              className="btn"
                              onClick={() => void retry([item.opId])}
                            >
                              {t('retry')}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </main>
  );
}
