import type { Farmer } from '../farmers/balances';
import { useI18n } from '../i18n';
import { formatKg, formatNaira } from '../lib/numbers';
import { formatLocalPhone } from '../lib/phone';
import type { Commodity, FarmerStatement } from '../types/api';

export interface BalanceSlipLine {
  commodity: Commodity;
  grade: string;
  bags: number;
  kg: number;
  free_bags: number;
  free_kg: number;
  held_bags: number;
  held_kg: number;
}

/**
 * The printed statement slip. From live figures it carries fees owed and
 * recent movements; from the tablet's cache only quantities, under a
 * "NOT CURRENT" line with the time they were fetched. Hidden on screen.
 */
export function BalanceSlip({
  farmer,
  warehouse,
  lines,
  fetchedAt,
  current,
  statement,
}: {
  farmer: Farmer;
  warehouse: { code: string; name: string };
  lines: BalanceSlipLine[];
  fetchedAt: number;
  current: boolean;
  statement: FarmerStatement | null;
}) {
  const { t } = useI18n();
  return (
    <section className="slip" aria-hidden="true" data-testid="balance-slip">
      <h2>{t('statementSlipTitle')}</h2>
      {!current && (
        <p className="slip__note" data-testid="not-current">
          {t('notCurrentAsOf', { time: new Date(fetchedAt).toLocaleString() })}
        </p>
      )}
      <dl>
        <div className="slip__row">
          <dt>{t('warehouse')}</dt>
          <dd>{`${warehouse.name} (${warehouse.code})`}</dd>
        </div>
        <div className="slip__row">
          <dt>{t('farmer')}</dt>
          <dd>{farmer.full_name}</dd>
        </div>
        <div className="slip__row">
          <dt>{t('phone')}</dt>
          <dd>{formatLocalPhone(farmer.phone)}</dd>
        </div>
        {current && (
          <div className="slip__row">
            <dt>{t('asOf')}</dt>
            <dd>{new Date(fetchedAt).toLocaleString()}</dd>
          </div>
        )}
      </dl>
      {lines.map((line) => (
        <dl key={`${line.commodity}-${line.grade}`}>
          <div className="slip__row">
            <dt>{`${t(line.commodity)} · ${t('grade', { grade: line.grade })}`}</dt>
            <dd>{t('bagsKg', { bags: line.bags, kg: formatKg(line.kg) })}</dd>
          </div>
          <div className="slip__row">
            <dt>{t('free')}</dt>
            <dd>{t('bagsKg', { bags: line.free_bags, kg: formatKg(line.free_kg) })}</dd>
          </div>
          {line.held_bags > 0 && (
            <div className="slip__row">
              <dt>{t('heldOnChain')}</dt>
              <dd>{t('bagsKg', { bags: line.held_bags, kg: formatKg(line.held_kg) })}</dd>
            </div>
          )}
        </dl>
      ))}
      {lines.length === 0 && <p>{t('noStock')}</p>}
      {current && statement !== null && (
        <>
          <dl>
            <div className="slip__row">
              <dt>{t('feesOwed')}</dt>
              <dd>{formatNaira(statement.fees.closing_outstanding_ngn)}</dd>
            </div>
            {statement.accrued_through !== null && (
              <div className="slip__row">
                <dt>{t('feesCountedTo')}</dt>
                <dd>{statement.accrued_through}</dd>
              </div>
            )}
          </dl>
          <dl>
            {statement.stock.movements.map((m, index) => (
              <div className="slip__row" key={`${m.occurred_at}-${index}`}>
                <dt>{`${m.date} ${t(m.bags_delta >= 0 ? 'movementIn' : 'movementOut')}`}</dt>
                <dd>{`${Math.abs(m.bags_delta)} × ${t(m.commodity)} ${m.grade}`}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {!current && <p>{t('cachedNoFees')}</p>}
    </section>
  );
}
