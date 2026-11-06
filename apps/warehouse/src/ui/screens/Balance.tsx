import { useEffect, useState } from 'react';

import type { CachedBalance } from '../../db/schema';
import { findFarmer } from '../../farmers/cache';
import {
  lookUpBalance,
  recentLookups,
  type BalanceLookup,
  type Farmer,
} from '../../farmers/balances';
import { errorText, useI18n } from '../../i18n';
import { HttpError } from '../../api/client';
import { ageOf, formatKg, formatNaira } from '../../lib/numbers';
import { formatLocalPhone, normaliseNigerianMobile } from '../../lib/phone';
import { BalanceSlip, type BalanceSlipLine } from '../../print/BalanceSlip';
import { Keypad } from '../components/Keypad';
import { useApp } from '../services';

/**
 * Farmer balance lookup. Online: current bags and kg by commodity and grade,
 * free versus held on-chain, storage fees owed and the last 30 days of
 * deposits and dispatches. Offline: only what this tablet saw online in the
 * last 24 hours (D43 as amended), shown greyed under its age, never as
 * current, and without fees or movements. Farmers looked up recently are
 * one tap away, so a repeat visit is two taps from Home.
 */
export function Balance({ onHome }: { onHome: () => void }) {
  const app = useApp();
  const { t, language } = useI18n();
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<CachedBalance[]>([]);
  const [shown, setShown] = useState<{ farmer: Farmer; lookup: BalanceLookup } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const online = app.connection === 'online';

  useEffect(() => {
    let live = true;
    void recentLookups(app.db, app.session.warehouse.id).then((entries) => {
      if (live) setRecent(entries);
    });
    return () => {
      live = false;
    };
  }, [app.db, app.session.warehouse.id, app.revision, shown]);

  // The age shown on cached figures keeps counting.
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const open = async (farmer: Farmer) => {
    setBusy(true);
    setError(null);
    try {
      const lookup = await lookUpBalance(app.db, app.api, app.session, farmer, online);
      // Live figures are "now"; cached ones age from the clock the interval keeps.
      if (lookup.source === 'live') setNow(lookup.fetchedAt);
      setShown({ farmer, lookup });
    } catch (err) {
      setError(
        err instanceof HttpError ? errorText(language, err.code, err.message) : t('saveFailed'),
      );
    } finally {
      setBusy(false);
    }
  };

  const find = async () => {
    const normalised = normaliseNigerianMobile(phone);
    if (normalised === null) {
      setError(t('signInInvalidPhone'));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await findFarmer(app.db, app.api, app.session, normalised, online);
    setBusy(false);
    if (result?.kind === 'found' && result.farmer.id !== null) {
      await open({ id: result.farmer.id, full_name: result.farmer.full_name, phone: normalised });
    } else if (result?.kind === 'found') {
      setError(t('balanceFarmerQueued'));
    } else {
      setError(
        result?.kind === 'not_found' ? t('balanceFarmerNotFound') : t('farmerUnknownOffline'),
      );
    }
  };

  if (shown !== null) {
    return (
      <BalanceView
        farmer={shown.farmer}
        lookup={shown.lookup}
        now={now}
        onDone={() => {
          setShown(null);
          setPhone('');
        }}
        onHome={onHome}
      />
    );
  }

  return (
    <main className="screen" data-testid="balance-lookup">
      <h1>{t('balanceTitle')}</h1>
      {error !== null && (
        <p className="message" data-tone="bad" role="alert">
          {error}
        </p>
      )}
      {recent.length > 0 && (
        <>
          <h2>{t('recentlyLookedUp')}</h2>
          <ul className="list">
            {recent.map((entry) => (
              <li key={entry.farmerId}>
                <button
                  type="button"
                  className="btn card"
                  style={{ textAlign: 'left' }}
                  data-testid="recent-farmer"
                  disabled={busy}
                  onClick={() =>
                    void open({
                      id: entry.farmerId,
                      full_name: entry.full_name,
                      phone: entry.phone,
                    })
                  }
                >
                  <span className="card__line" style={{ width: '100%' }}>
                    <span className="card__title">{entry.full_name}</span>
                    <span>{formatLocalPhone(entry.phone)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <h2>{t('farmerPhoneTitle')}</h2>
      <Keypad
        label={t('farmerPhoneTitle')}
        placeholder="0803 123 4567"
        value={phone}
        onChange={setPhone}
        maxLength={14}
      />
      <div className="actions">
        <button type="button" className="btn" onClick={onHome}>
          {t('home')}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || normaliseNigerianMobile(phone) === null}
          onClick={() => void find()}
        >
          {busy ? t('lookingUp') : t('find')}
        </button>
      </div>
    </main>
  );
}

function BalanceView({
  farmer,
  lookup,
  now,
  onDone,
  onHome,
}: {
  farmer: Farmer;
  lookup: BalanceLookup;
  now: number;
  onDone: () => void;
  onHome: () => void;
}) {
  const app = useApp();
  const { t } = useI18n();

  if (lookup.source === 'none') {
    return (
      <main className="screen" data-testid="balance">
        <h1>{farmer.full_name}</h1>
        <p className="message" data-tone="warn" role="status">
          {t('balanceNoneOffline')}
        </p>
        <div className="actions">
          <button type="button" className="btn" onClick={onDone}>
            {t('back')}
          </button>
        </div>
      </main>
    );
  }

  const current = lookup.source === 'live';
  const lines: BalanceSlipLine[] = current
    ? lookup.lines.map((l) => ({
        commodity: l.commodity,
        grade: l.grade,
        bags: l.bags,
        kg: l.kg,
        free_bags: l.free_bags,
        free_kg: l.free_kg,
        held_bags: l.held_on_chain_bags,
        held_kg: l.held_on_chain_kg,
      }))
    : lookup.balance.lines;
  const heldLots = (commodity: string, grade: string): number[] =>
    current
      ? (lookup.lines.find((l) => l.commodity === commodity && l.grade === grade)
          ?.held_on_chain_lots ?? [])
      : [];
  const statement = current ? lookup.statement : null;
  const age = ageOf(lookup.fetchedAt, now);
  const fetched = new Date(lookup.fetchedAt);
  const time = fetched.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // Up to 24 hours old: say which day when it isn't today.
  const asOf =
    fetched.toDateString() === new Date(now).toDateString()
      ? time
      : `${fetched.toLocaleDateString()} ${time}`;

  return (
    <main className="screen" data-testid="balance" data-current={current}>
      <h1>{farmer.full_name}</h1>
      <p className="hint">{formatLocalPhone(farmer.phone)}</p>
      {current ? (
        <p className="message" data-tone="ok" role="status" data-testid="balance-age">
          {t('currentAsOf', { time: asOf })}
        </p>
      ) : (
        <p className="message" data-tone="bad" role="status" data-testid="balance-age">
          {'minutes' in age
            ? t('cachedAsOfMinutes', { time: asOf, n: age.minutes })
            : t('cachedAsOfHours', { time: asOf, n: age.hours })}
        </p>
      )}
      {lines.length === 0 ? (
        <p className="hint">{t('noStock')}</p>
      ) : (
        <ul className="list" data-stale={!current}>
          {lines.map((line) => {
            const lots = heldLots(line.commodity, line.grade);
            return (
              <li
                key={`${line.commodity}-${line.grade}`}
                className="card"
                data-testid="balance-line"
                style={current ? undefined : { opacity: 0.55 }}
              >
                <span className="card__line">
                  <span className="card__title">
                    {t(line.commodity)} · {t('grade', { grade: line.grade })}
                  </span>
                  <span>{t('bagsKg', { bags: line.bags, kg: formatKg(line.kg) })}</span>
                </span>
                <span className="card__line">
                  <span>{t('free')}</span>
                  <span data-testid="free">
                    {t('bagsKg', { bags: line.free_bags, kg: formatKg(line.free_kg) })}
                  </span>
                </span>
                {line.held_bags > 0 && (
                  <span className="card__line">
                    <span>
                      {t('heldOnChain')}
                      {lots.length > 0 && ` (${t('lotsList', { lots: lots.join(', ') })})`}
                    </span>
                    <span data-testid="held">
                      {t('bagsKg', { bags: line.held_bags, kg: formatKg(line.held_kg) })}
                    </span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {current && statement !== null && (
        <>
          <dl className="review">
            <div className="review__row">
              <dt>{t('feesOwed')}</dt>
              <dd data-testid="fees-owed">{formatNaira(statement.fees.closing_outstanding_ngn)}</dd>
            </div>
            {statement.accrued_through !== null && (
              <div className="review__row">
                <dt>{t('feesCountedTo')}</dt>
                <dd>{statement.accrued_through}</dd>
              </div>
            )}
          </dl>
          <h2>{t('recentMovements')}</h2>
          {statement.stock.movements.length === 0 ? (
            <p className="hint">{t('noMovements')}</p>
          ) : (
            <ul className="list" data-testid="movements">
              {[...statement.stock.movements].reverse().map((m, index) => (
                <li key={`${m.occurred_at}-${index}`} className="card">
                  <span className="card__line">
                    <span>
                      {m.date} · {t(m.bags_delta >= 0 ? 'movementIn' : 'movementOut')}
                    </span>
                    <span>
                      {Math.abs(m.bags_delta)} × {t(m.commodity)} {m.grade}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {current && statement === null && (
        <p className="message" data-tone="warn">
          {t('feesUnavailable')}
        </p>
      )}
      {!current && <p className="hint">{t('cachedNoFees')}</p>}
      <div className="actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            window.print();
          }}
        >
          🖨 {t('printStatement')}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          {t('anotherFarmer')}
        </button>
        <button type="button" className="btn btn--primary" onClick={onHome}>
          {t('done')}
        </button>
      </div>
      <BalanceSlip
        farmer={farmer}
        warehouse={app.session.warehouse}
        lines={lines}
        fetchedAt={lookup.fetchedAt}
        current={current}
        statement={statement}
      />
    </main>
  );
}
