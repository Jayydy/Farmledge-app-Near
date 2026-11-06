import { useEffect, useState } from 'react';

import { HttpError } from '../../api/client';
import {
  countLine,
  finishCount,
  forgetCount,
  openCount,
  parseCountedBags,
  samePersonName,
  startCount,
} from '../../audit/count';
import type { CountedLine, OpenAudit } from '../../db/schema';
import { apiErrorText, useI18n } from '../../i18n';
import { formatKg, parseKg } from '../../lib/numbers';
import { CountSlip, signed } from '../../print/ReportSlips';
import type { AuditReport, Commodity } from '../../types/api';
import { Keypad } from '../components/Keypad';
import { useApp } from '../services';

type Step =
  | { name: 'loading' }
  | { name: 'who' }
  | { name: 'pick' }
  | { name: 'bags' }
  | { name: 'kg' }
  | { name: 'saved'; line: CountedLine }
  | { name: 'report'; report: AuditReport };

/**
 * The stock count (D9, D57). The signed-in custodian enters the figures,
 * but the record names who physically counted and who watched, and the
 * watcher can't be the custodian. Blind: each commodity and grade is
 * counted before the tablet shows what the system recorded for it. Online
 * only; an open count survives the idle lock and reloads (kept on the
 * tablet), so the custodian can walk the store and come back.
 */
export function StockCount({ onHome }: { onHome: () => void }) {
  const app = useApp();
  const { t, language } = useI18n();
  const online = app.connection === 'online';
  const [step, setStep] = useState<Step>({ name: 'loading' });
  const [open, setOpen] = useState<OpenAudit | null>(null);
  const [countedBy, setCountedBy] = useState('');
  const [witnessedBy, setWitnessedBy] = useState('');
  const [commodity, setCommodity] = useState<Commodity | null>(null);
  const [grade, setGrade] = useState<string | null>(null);
  const [bags, setBags] = useState('');
  const [kg, setKg] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void openCount(app.db, app.session).then((found) => {
      if (!live) return;
      setOpen(found);
      setStep(found === null ? { name: 'who' } : { name: 'pick' });
    });
    return () => {
      live = false;
    };
  }, [app.db, app.session]);

  const fail = async (err: unknown) => {
    if (err instanceof HttpError && err.status === 404 && open !== null) {
      // The server no longer has this count: don't keep offering to continue it.
      await forgetCount(app.db);
      setOpen(null);
      setStep({ name: 'who' });
    }
    setError(err instanceof HttpError ? apiErrorText(language, err) : t('dispatchConnectionLost'));
  };

  const homeButton = (
    <button type="button" className="btn" onClick={onHome}>
      {t('home')}
    </button>
  );
  const errorLine = error !== null && (
    <p className="message" data-tone="bad" role="alert">
      {error}
    </p>
  );
  const header = open !== null && step.name !== 'report' && (
    <p className="hint" data-testid="count-header">
      {t('countedBy')}: {open.audit.counted_by} · {t('witnessedBy')}: {open.audit.witnessed_by}
    </p>
  );

  if (step.name === 'loading') return null;

  if (!online && step.name !== 'report') {
    return (
      <main className="screen" data-testid="stock-count">
        <h1>{t('stockCount')}</h1>
        {header}
        <p className="message" data-tone="warn" role="status">
          {t('countNeedsConnection')}
        </p>
        {open !== null && <p className="hint">{t('countLeaveHint')}</p>}
        <div className="actions">{homeButton}</div>
      </main>
    );
  }

  if (step.name === 'who') {
    const witnessIsMe =
      witnessedBy.trim() !== '' && samePersonName(witnessedBy, app.session.custodian.full_name);
    const ready = countedBy.trim() !== '' && witnessedBy.trim() !== '' && !witnessIsMe;
    const start = async () => {
      setBusy(true);
      setError(null);
      try {
        const started = await startCount(app.db, app.api, app.session, { countedBy, witnessedBy });
        setOpen(started);
        setStep({ name: 'pick' });
      } catch (err) {
        await fail(err);
      } finally {
        setBusy(false);
      }
    };
    return (
      <main className="screen" data-testid="stock-count">
        <h1>{t('countWhoTitle')}</h1>
        <p className="hint">{t('countWhoHint')}</p>
        {errorLine}
        <label className="field">
          <span>{t('countedBy')}</span>
          <input
            className="text-field"
            autoComplete="off"
            autoCapitalize="words"
            aria-label={t('countedBy')}
            value={countedBy}
            maxLength={120}
            onChange={(event) => {
              setCountedBy(event.target.value);
            }}
          />
        </label>
        <label className="field">
          <span>{t('witnessedBy')}</span>
          <input
            className="text-field"
            autoComplete="off"
            autoCapitalize="words"
            aria-label={t('witnessedBy')}
            value={witnessedBy}
            maxLength={120}
            onChange={(event) => {
              setWitnessedBy(event.target.value);
            }}
          />
        </label>
        <p className="hint">{t('witnessHint')}</p>
        {witnessIsMe && (
          <p className="message" data-tone="bad" role="alert">
            {t('witnessIsYou')}
          </p>
        )}
        <div className="actions">
          {homeButton}
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || !ready}
            onClick={() => void start()}
          >
            {t('startCount')}
          </button>
        </div>
      </main>
    );
  }

  if (step.name === 'report') {
    const { report } = step;
    return (
      <main className="screen" data-testid="count-report">
        <h1>{t('countReportTitle')}</h1>
        <p className="hint">
          {t('countedBy')}: {report.audit.counted_by} · {t('witnessedBy')}:{' '}
          {report.audit.witnessed_by}
        </p>
        <p className="hint" data-testid="names-not-verified">
          {t('namesNotVerified')}
        </p>
        <ul className="list">
          {report.lines.map((line) => (
            <li
              key={`${line.commodity}-${line.grade}`}
              className="card"
              data-tone={line.difference_bags !== 0 ? 'bad' : undefined}
              data-testid="report-line"
            >
              <LineFigures line={line} />
            </li>
          ))}
        </ul>
        <p className="message" data-testid="report-total">
          {t('total')}: {signed(report.totals.difference_bags)} /{' '}
          {signed(report.totals.difference_kg, formatKg)}
        </p>
        {report.uncounted.length > 0 && (
          <>
            <h2>{t('notCounted')}</h2>
            <p className="hint">{t('notCountedHint')}</p>
            <ul className="list" data-testid="report-uncounted">
              {report.uncounted.map((line) => (
                <li key={`${line.commodity}-${line.grade}`} className="card" data-tone="bad">
                  <span className="card__line">
                    <span className="card__title">
                      {t(line.commodity)} · {t('grade', { grade: line.grade })}
                    </span>
                    <span>
                      {t('bagsKg', { bags: line.recorded_bags, kg: formatKg(line.recorded_kg) })}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              window.print();
            }}
          >
            🖨 {t('printCountReport')}
          </button>
          <button type="button" className="btn btn--primary" onClick={onHome}>
            {t('done')}
          </button>
        </div>
        <CountSlip warehouse={app.session.warehouse} report={report} />
      </main>
    );
  }

  // From here on there is an open count.
  if (open === null) return null;
  const done = (c: Commodity, g: string) =>
    open.lines.some((line) => line.commodity === c && line.grade === g);

  const save = async () => {
    const counted = parseCountedBags(bags);
    if (commodity === null || grade === null || counted === null) return;
    const weighed = kg === '' ? null : parseKg(kg);
    setBusy(true);
    setError(null);
    try {
      const result = await countLine(app.db, app.api, app.session, open, {
        commodity,
        grade,
        counted_bags: counted,
        ...(weighed === null ? {} : { counted_kg: weighed }),
      });
      setOpen(result.open);
      setStep({ name: 'saved', line: result.saved });
    } catch (err) {
      await fail(err);
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (!window.confirm(t('finishCountConfirm'))) return;
    setBusy(true);
    setError(null);
    try {
      const report = await finishCount(app.db, app.api, app.session, open);
      setOpen(null);
      setStep({ name: 'report', report });
    } catch (err) {
      await fail(err);
    } finally {
      setBusy(false);
    }
  };

  const nextLine = () => {
    setCommodity(null);
    setGrade(null);
    setBags('');
    setKg('');
    setError(null);
    setStep({ name: 'pick' });
  };

  const countedSoFar = (
    <>
      <h2>{t('countedSoFar')}</h2>
      {open.lines.length === 0 ? (
        <p className="hint">{t('nothingCounted')}</p>
      ) : (
        <ul className="list" data-testid="counted-lines">
          {open.lines.map((line) => (
            <li
              key={`${line.commodity}-${line.grade}`}
              className="card"
              data-tone={line.difference_bags !== 0 ? 'bad' : undefined}
            >
              <LineFigures line={line} />
            </li>
          ))}
        </ul>
      )}
    </>
  );

  if (step.name === 'saved') {
    return (
      <main className="screen" data-testid="stock-count">
        <h1>{t('stockCount')}</h1>
        {header}
        <div
          className="card"
          data-tone={step.line.difference_bags !== 0 ? 'bad' : undefined}
          data-testid="saved-line"
        >
          <LineFigures line={step.line} />
        </div>
        <div className="actions">
          <button type="button" className="btn btn--primary" onClick={nextLine}>
            {t('countAnother')}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void finish()}>
            {t('finishCount')}
          </button>
        </div>
        {errorLine}
        {countedSoFar}
        <p className="hint">{t('countLeaveHint')}</p>
        <div className="actions">{homeButton}</div>
      </main>
    );
  }

  if (step.name === 'bags') {
    return (
      <main className="screen" data-testid="stock-count">
        <h1>
          {commodity !== null && t(commodity)} · {grade !== null && t('grade', { grade })}
        </h1>
        <p className="hint">{t('countBlindHint')}</p>
        <h2>{t('countedBags')}</h2>
        <Keypad label={t('countedBags')} value={bags} onChange={setBags} maxLength={7} />
        {bags !== '' && parseCountedBags(bags) === null && (
          <p className="message" data-tone="bad">
            {t('countedBagsInvalid')}
          </p>
        )}
        <div className="actions">
          <button type="button" className="btn" onClick={nextLine}>
            {t('back')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={parseCountedBags(bags) === null}
            onClick={() => {
              setStep({ name: 'kg' });
            }}
          >
            {t('next')}
          </button>
        </div>
      </main>
    );
  }

  if (step.name === 'kg') {
    const kgOk = kg === '' || parseKg(kg) !== null;
    return (
      <main className="screen" data-testid="stock-count">
        <h1>
          {commodity !== null && t(commodity)} · {grade !== null && t('grade', { grade })}
        </h1>
        <p className="hint">{t('countBlindHint')}</p>
        <h2>{t('countedKg')}</h2>
        <Keypad label={t('countedKg')} value={kg} onChange={setKg} maxLength={9} decimal />
        {errorLine}
        <div className="actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setStep({ name: 'bags' });
            }}
          >
            {t('back')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || !kgOk}
            onClick={() => void save()}
          >
            {t('saveCount')}
          </button>
        </div>
      </main>
    );
  }

  // pick: the commodity and grade to count next.
  return (
    <main className="screen" data-testid="stock-count">
      <h1>{t('countLineTitle')}</h1>
      {header}
      {errorLine}
      <h2>{t('commodityTitle')}</h2>
      <div className="choices">
        {app.features.intake.commodities.map((c) => (
          <button
            key={c.code}
            type="button"
            className="btn"
            aria-pressed={commodity === c.code}
            onClick={() => {
              setCommodity(c.code);
            }}
          >
            {t(c.code)}
          </button>
        ))}
      </div>
      <h2>{t('gradeTitle')}</h2>
      <div className="choices">
        {app.features.grading.grades.map((g) => {
          const already = commodity !== null && done(commodity, g);
          return (
            <button
              key={g}
              type="button"
              className="btn"
              aria-pressed={grade === g}
              disabled={already}
              onClick={() => {
                setGrade(g);
              }}
            >
              {t('grade', { grade: g })}
              {already && <small>{t('alreadyCounted')}</small>}
            </button>
          );
        })}
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={commodity === null || grade === null || done(commodity, grade)}
          onClick={() => {
            setStep({ name: 'bags' });
          }}
        >
          {t('next')}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void finish()}>
          {t('finishCount')}
        </button>
      </div>
      {countedSoFar}
      <p className="hint">{t('countLeaveHint')}</p>
      <div className="actions">{homeButton}</div>
    </main>
  );
}

/** Recorded, counted and the difference for one commodity and grade. */
function LineFigures({
  line,
}: {
  line: Pick<
    CountedLine,
    | 'commodity'
    | 'grade'
    | 'recorded_bags'
    | 'recorded_kg'
    | 'counted_bags'
    | 'counted_kg'
    | 'difference_bags'
    | 'difference_kg'
  >;
}) {
  const { t } = useI18n();
  return (
    <>
      <span className="card__line">
        <span className="card__title">
          {t(line.commodity)} · {t('grade', { grade: line.grade })}
        </span>
      </span>
      <span className="card__line">
        <span>{t('counted')}</span>
        <span data-testid="counted">
          {t('bagsKg', { bags: line.counted_bags, kg: formatKg(line.counted_kg) })}
        </span>
      </span>
      <span className="card__line">
        <span>{t('recorded')}</span>
        <span data-testid="recorded">
          {t('bagsKg', { bags: line.recorded_bags, kg: formatKg(line.recorded_kg) })}
        </span>
      </span>
      <span className="card__line">
        <span>{t('difference')}</span>
        <span data-testid="difference">
          {signed(line.difference_bags)} / {signed(line.difference_kg, formatKg)}
        </span>
      </span>
    </>
  );
}
