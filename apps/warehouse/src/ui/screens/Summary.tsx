import { useEffect, useState } from 'react';

import { HttpError } from '../../api/client';
import { openCount } from '../../audit/count';
import type { OpenAudit } from '../../db/schema';
import { apiErrorText, useI18n } from '../../i18n';
import { formatKg } from '../../lib/numbers';
import { SummarySlip } from '../../print/ReportSlips';
import {
  businessDate,
  loadDaySummary,
  localToday,
  shiftDate,
  type DaySummary,
} from '../../summary/day';
import type { Commodity, StockSummary } from '../../types/api';
import { useApp } from '../services';

const timeOf = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Home's Today panel (D57). Online: the warehouse's day from the API, every
 * tablet's deposits and dispatches, with the two figures that warn:
 * dispatches out not weighed, and dispatches blocked offline anywhere in the
 * warehouse. Bag-estimated deposits are the trial's normal case, so they are
 * a plain figure, never a warning. Offline: only this tablet's own deposits,
 * said as such; no old warehouse figures are ever shown as current.
 */
export function TodayPanel({
  onSummary,
  onStockCount,
}: {
  onSummary: () => void;
  onStockCount: () => void;
}) {
  const app = useApp();
  const { t } = useI18n();
  const online = app.connection === 'online';
  const timeZone = app.features.business_timezone;
  const [live, setLive] = useState<DaySummary | null>(null);
  const [local, setLocal] = useState<{ deposits: number; bags: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<OpenAudit | null>(null);

  useEffect(() => {
    let current = true;
    void openCount(app.db, app.session).then((found) => {
      if (current) setOpen(found);
    });
    return () => {
      current = false;
    };
  }, [app.db, app.session, app.revision]);

  useEffect(() => {
    let current = true;
    if (online) {
      loadDaySummary(app.api, app.session, businessDate(Date.now(), timeZone))
        .then((summary) => {
          if (!current) return;
          setLive(summary);
          setFailed(false);
        })
        .catch(() => {
          if (current) setFailed(true);
        });
    } else {
      void localToday(app.db, app.session, timeZone).then((mine) => {
        if (current) setLocal(mine);
      });
    }
    return () => {
      current = false;
    };
  }, [app.api, app.db, app.session, app.revision, online, timeZone]);

  return (
    <section className="card today" data-testid="today">
      <span className="card__line" style={{ width: '100%' }}>
        <span className="card__title">{t('todayTitle')}</span>
        {online && live !== null && (
          <span className="hint">{t('asOfTime', { time: timeOf(live.fetchedAt) })}</span>
        )}
      </span>
      {online && live !== null && (
        <>
          <span className="card__line" style={{ width: '100%' }} data-testid="today-in">
            <span>{t('todayIn')}</span>
            <span>
              {t('todayInLine', {
                n: live.in.deposits,
                bags: live.in.bags,
                kg: formatKg(live.in.kg),
              })}
              {live.in.bagEstimated > 0 &&
                ` (${t('todayBagEstimated', { n: live.in.bagEstimated })})`}
            </span>
          </span>
          <span className="card__line" style={{ width: '100%' }} data-testid="today-out">
            <span>{t('todayOut')}</span>
            <span>
              {t('todayOutLine', {
                n: live.out.dispatches,
                bags: live.out.bags,
                kg: formatKg(live.out.kg),
              })}
            </span>
          </span>
          {live.out.notWeighed > 0 && (
            <p className="message" data-tone="warn" data-testid="today-not-weighed">
              ⚠ {t('todayNotWeighed', { n: live.out.notWeighed })}
            </p>
          )}
          {live.blocked > 0 && (
            <p className="message" data-tone="warn" data-testid="today-blocked">
              ⚠ {t('todayBlocked', { n: live.blocked })}
            </p>
          )}
        </>
      )}
      {online && live === null && failed && <p className="hint">{t('todayLoadFailed')}</p>}
      {!online && local !== null && (
        <>
          <p className="hint" data-testid="today-local">
            {t('todayThisTablet', { n: local.deposits, bags: local.bags })}
          </p>
          <p className="hint">{t('todayNeedsConnection')}</p>
        </>
      )}
      <div className="choices">
        <button
          type="button"
          className="btn"
          data-tone={online ? undefined : 'muted'}
          onClick={onSummary}
        >
          {t('dailySummary')}
        </button>
        <button
          type="button"
          className="btn"
          data-tone={online ? undefined : 'muted'}
          onClick={onStockCount}
        >
          {open !== null ? t('continueStockCount') : t('stockCount')}
        </button>
      </div>
    </section>
  );
}

/**
 * One business day at the warehouse, any day back from today: deposits in,
 * dispatches out (each with its weight or its recorded reason for none),
 * stock now (today only) and the warehouse-wide blocked count. Online only.
 */
export function DailySummary({ onHome }: { onHome: () => void }) {
  const app = useApp();
  const { t, language } = useI18n();
  const online = app.connection === 'online';
  const { api, session } = app;
  // Fixed for the screen's life: a summary left open past midnight keeps its day.
  const [today] = useState(() => businessDate(Date.now(), app.features.business_timezone));
  const [date, setDate] = useState(today);
  // What was loaded, and for which day: another day's result is never shown as this one's.
  const [loaded, setLoaded] = useState<
    | { date: string; summary: DaySummary; stock: StockSummary | null }
    | { date: string; error: string }
    | null
  >(null);

  useEffect(() => {
    if (!online) return;
    let current = true;
    Promise.all([
      loadDaySummary(api, session, date),
      date === today
        ? api<StockSummary>('GET', `/warehouses/${session.warehouse.id}/stock`, {
            token: session.token,
          }).then((res) => res.data)
        : Promise.resolve(null),
    ])
      .then(([summary, stock]) => {
        if (current) setLoaded({ date, summary, stock });
      })
      .catch((err: unknown) => {
        if (!current) return;
        setLoaded({
          date,
          error: err instanceof HttpError ? apiErrorText(language, err) : t('todayLoadFailed'),
        });
      });
    return () => {
      current = false;
    };
  }, [api, session, date, language, online, t, today]);
  const result = loaded?.date === date ? loaded : null;
  const summary = result !== null && 'summary' in result ? result.summary : null;
  const stock = result !== null && 'summary' in result ? result.stock : null;
  const error = result !== null && 'error' in result ? result.error : null;

  const homeButton = (
    <button type="button" className="btn" onClick={onHome}>
      {t('home')}
    </button>
  );

  if (!online) {
    return (
      <main className="screen" data-testid="daily-summary">
        <h1>{t('dailySummary')}</h1>
        <p className="message" data-tone="warn" role="status">
          {t('summaryNeedsConnection')}
        </p>
        <div className="actions">{homeButton}</div>
      </main>
    );
  }

  return (
    <main className="screen" data-testid="daily-summary">
      <h1>{t('dailySummary')}</h1>
      <div className="actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            setDate((d) => shiftDate(d, -1));
          }}
        >
          {t('previousDay')}
        </button>
        <strong data-testid="summary-date">{date}</strong>
        <button
          type="button"
          className="btn"
          disabled={date >= today}
          onClick={() => {
            setDate((d) => shiftDate(d, 1));
          }}
        >
          {t('nextDay')}
        </button>
      </div>
      {error !== null && (
        <p className="message" data-tone="bad" role="alert">
          {error}
        </p>
      )}
      {summary === null && error === null && <p className="hint">{t('lookingUp')}</p>}
      {summary !== null && (
        <>
          <p className="hint">{t('asOfTime', { time: timeOf(summary.fetchedAt) })}</p>
          <h2>{t('todayIn')}</h2>
          <p data-testid="summary-in">
            {t('todayInLine', {
              n: summary.in.deposits,
              bags: summary.in.bags,
              kg: formatKg(summary.in.kg),
            })}
            {summary.in.bagEstimated > 0 &&
              ` (${t('todayBagEstimated', { n: summary.in.bagEstimated })})`}
          </p>
          {summary.deposits.length === 0 ? (
            <p className="hint">{t('noDeposits')}</p>
          ) : (
            <ul className="list" data-testid="summary-deposits">
              {[...summary.deposits].reverse().map((d) => (
                <li key={d.deposit_id} className="card">
                  <span className="card__line">
                    <span className="card__title">{t('depositNumber', { n: d.deposit_no })}</span>
                    <span>
                      {d.bag_count} × {t(d.commodity as Commodity)} ·{' '}
                      {t('grade', { grade: d.grade })}
                    </span>
                  </span>
                  <span className="card__line">
                    <span>{timeOf(Date.parse(d.captured_at))}</span>
                    <span>
                      {d.weight_source === 'bag_estimate'
                        ? t('estimatedKg', {
                            kg: formatKg(d.weight_kg ?? d.bag_count * d.bag_size_kg),
                          })
                        : formatKg(d.weight_kg ?? 0)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <h2>{t('todayOut')}</h2>
          <p data-testid="summary-out">
            {t('todayOutLine', {
              n: summary.out.dispatches,
              bags: summary.out.bags,
              kg: formatKg(summary.out.kg),
            })}
          </p>
          {summary.out.notWeighed > 0 && (
            <p className="message" data-tone="warn">
              ⚠ {t('todayNotWeighed', { n: summary.out.notWeighed })}
            </p>
          )}
          {summary.dispatches.length === 0 ? (
            <p className="hint">{t('noDispatches')}</p>
          ) : (
            <ul className="list" data-testid="summary-dispatches">
              {[...summary.dispatches].reverse().map((d) => (
                <li
                  key={d.dispatch_id}
                  className="card"
                  data-tone={d.exit_weight_kg === null ? 'bad' : undefined}
                >
                  <span className="card__line">
                    <span className="card__title">
                      {t('deliveryNoteNumber', { n: d.delivery_note_no })}
                    </span>
                    <span>
                      {d.bag_count} × {t(d.commodity)} · {t('grade', { grade: d.grade })}
                    </span>
                  </span>
                  <span className="card__line">
                    <span>{timeOf(Date.parse(d.dispatched_at))}</span>
                    <span>
                      {d.exit_weight_kg === null
                        ? t('notWeighedWithReason', { reason: d.not_weighed_reason ?? '' })
                        : formatKg(d.exit_weight_kg)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {summary.dispatchesTruncated && (
            <p className="hint">{t('dispatchesTruncated', { n: summary.dispatches.length })}</p>
          )}
          <p
            className="message"
            data-tone={summary.blocked > 0 ? 'warn' : undefined}
            data-testid="summary-blocked"
          >
            {t('todayBlocked', { n: summary.blocked })}
          </p>
          <p className="hint">{t('blockedLater')}</p>
          {stock !== null && (
            <>
              <h2>{t('stockNow')}</h2>
              {stock.lines.length === 0 ? (
                <p className="hint">{t('noStock')}</p>
              ) : (
                <ul className="list" data-testid="summary-stock">
                  {stock.lines.map((line) => (
                    <li key={`${line.commodity}-${line.grade}`} className="card">
                      <span className="card__line">
                        <span className="card__title">
                          {t(line.commodity)} · {t('grade', { grade: line.grade })}
                        </span>
                        <span>{t('bagsKg', { bags: line.bags, kg: formatKg(line.kg) })}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <SummarySlip warehouse={app.session.warehouse} summary={summary} stock={stock} />
        </>
      )}
      <div className="actions">
        {homeButton}
        <button
          type="button"
          className="btn"
          disabled={summary === null}
          onClick={() => {
            window.print();
          }}
        >
          🖨 {t('printSummary')}
        </button>
      </div>
    </main>
  );
}
