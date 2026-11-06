import { useI18n } from '../i18n';
import { formatKg } from '../lib/numbers';
import type { DaySummary } from '../summary/day';
import type { AuditReport, StockSummary } from '../types/api';

/** +2, −3, 0: a difference always says which way. */
export function signed(n: number, format: (n: number) => string = String): string {
  if (n > 0) return `+${format(n)}`;
  if (n < 0) return `−${format(-n)}`;
  return format(0);
}

/** The printed daily summary: one business day at the warehouse. Hidden on screen. */
export function SummarySlip({
  warehouse,
  summary,
  stock,
}: {
  warehouse: { code: string; name: string };
  summary: DaySummary;
  stock: StockSummary | null;
}) {
  const { t } = useI18n();
  return (
    <section className="slip" aria-hidden="true" data-testid="summary-slip">
      <h2>{t('summarySlipTitle')}</h2>
      <dl>
        <div className="slip__row">
          <dt>{t('warehouse')}</dt>
          <dd>{`${warehouse.name} (${warehouse.code})`}</dd>
        </div>
        <div className="slip__row">
          <dt>{summary.date}</dt>
          <dd>{t('asOfTime', { time: new Date(summary.fetchedAt).toLocaleTimeString() })}</dd>
        </div>
        <div className="slip__row">
          <dt>{t('todayIn')}</dt>
          <dd>
            {t('todayInLine', {
              n: summary.in.deposits,
              bags: summary.in.bags,
              kg: formatKg(summary.in.kg),
            })}
          </dd>
        </div>
        <div className="slip__row">
          <dt>{t('todayOut')}</dt>
          <dd>
            {t('todayOutLine', {
              n: summary.out.dispatches,
              bags: summary.out.bags,
              kg: formatKg(summary.out.kg),
            })}
          </dd>
        </div>
        <p>{t('todayNotWeighed', { n: summary.out.notWeighed })}</p>
        <p>{t('todayBlocked', { n: summary.blocked })}</p>
      </dl>
      {stock !== null && (
        <dl>
          <p>{t('stockNow')}</p>
          {stock.lines.map((line) => (
            <div className="slip__row" key={`${line.commodity}-${line.grade}`}>
              <dt>{`${t(line.commodity)} · ${t('grade', { grade: line.grade })}`}</dt>
              <dd>{t('bagsKg', { bags: line.bags, kg: formatKg(line.kg) })}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/**
 * The printed stock count report: who counted and witnessed, and every
 * difference. The names are typed text (D57), so the slip says they are not
 * verified: this is what a lender may be shown. Hidden on screen.
 */
export function CountSlip({
  warehouse,
  report,
}: {
  warehouse: { code: string; name: string };
  report: AuditReport;
}) {
  const { t } = useI18n();
  const row = (label: string, value: string) => (
    <div className="slip__row" key={label}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  return (
    <section className="slip" aria-hidden="true" data-testid="count-slip">
      <h2>{t('countSlipTitle')}</h2>
      <dl>
        {row(t('warehouse'), `${warehouse.name} (${warehouse.code})`)}
        {row(t('countedBy'), report.audit.counted_by ?? '')}
        {row(t('witnessedBy'), report.audit.witnessed_by ?? '')}
      </dl>
      <p>{t('namesNotVerified')}</p>
      <p>{t('countStarted', { time: new Date(report.audit.started_at).toLocaleString() })}</p>
      {report.lines.map((line) => (
        <dl key={`${line.commodity}-${line.grade}`}>
          <p>{`${t(line.commodity)} · ${t('grade', { grade: line.grade })}`}</p>
          {row(
            t('recorded'),
            t('bagsKg', { bags: line.recorded_bags, kg: formatKg(line.recorded_kg) }),
          )}
          {row(
            t('counted'),
            t('bagsKg', { bags: line.counted_bags, kg: formatKg(line.counted_kg) }),
          )}
          {row(
            t('difference'),
            `${signed(line.difference_bags)} / ${signed(line.difference_kg, formatKg)}`,
          )}
        </dl>
      ))}
      <dl>
        {row(
          t('total'),
          `${signed(report.totals.difference_bags)} / ${signed(report.totals.difference_kg, formatKg)}`,
        )}
      </dl>
      {report.uncounted.length > 0 && (
        <dl>
          <p>{t('notCounted')}</p>
          {report.uncounted.map((line) =>
            row(
              `${t(line.commodity)} · ${t('grade', { grade: line.grade })}`,
              t('bagsKg', { bags: line.recorded_bags, kg: formatKg(line.recorded_kg) }),
            ),
          )}
        </dl>
      )}
    </section>
  );
}
