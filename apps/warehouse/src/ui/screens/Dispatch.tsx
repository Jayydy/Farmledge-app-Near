import { useCallback, useEffect, useRef, useState } from 'react';

import { HttpError, NetworkError } from '../../api/client';
import { unlock } from '../../auth/sessions';
import type { PendingDispatch } from '../../db/schema';
import {
  acknowledgePending,
  dispatchReference,
  LEAVE_PENDING_AFTER_MS,
  resolvePending,
  savePending,
} from '../../dispatch/pending';
import { findFarmer } from '../../farmers/cache';
import { errorText, useI18n } from '../../i18n';
import { formatKg, parseKg, parseWholeCount } from '../../lib/numbers';
import { formatLocalPhone, normaliseNigerianMobile } from '../../lib/phone';
import { DeliveryNoteSlip } from '../../print/DeliveryNoteSlip';
import type {
  BalanceLine,
  BalanceResponse,
  Commodity,
  DeliveryNote,
  DeliveryNoteResponse,
  DispatchPlan,
  DispatchRequest,
  DispatchView,
  Features,
  LotView,
  LotsResponse,
} from '../../types/api';
import { Keypad } from '../components/Keypad';
import { useApp } from '../services';

/**
 * Dispatch (D54): stock leaving the warehouse. Online only. Without current
 * data the tablet could release grain that was pledged or already
 * dispatched, so it never starts offline (App records the blocked attempt),
 * and if the connection drops mid-way the entries are kept but nothing is
 * submitted until it is back.
 *
 * Seven decisions, "Step n of 7": farmer, line, bags, lots, weight, farmer
 * confirms, custodian signs off with their PIN. Then the result, which is
 * not a step. The delivery note prints only after the server has recorded
 * the dispatch. A submission whose answer is lost says "Not confirmed: do
 * not release the bags" and is retried with the same dispatch_id until the
 * server answers (it ignores a repeat).
 */

type Step =
  | 'phone'
  | 'confirmFarmer'
  | 'notFound'
  | 'holdings'
  | 'bags'
  | 'lots'
  | 'chooseLot'
  | 'weight'
  | 'notWeighedReason'
  | 'review'
  | 'signOff';

const SECTIONS: Step[][] = [
  ['phone', 'confirmFarmer', 'notFound'],
  ['holdings'],
  ['bags'],
  ['lots', 'chooseLot'],
  ['weight', 'notWeighedReason'],
  ['review'],
  ['signOff'],
];
const sectionOf = (step: Step) => SECTIONS.findIndex((steps) => steps.includes(step));

/** Kept in English on the record, whatever the screen's language, so reports read the same. */
export const NOT_WEIGHED_REASONS = ['No scale at this warehouse', 'Scale not working'] as const;

/** How often an unconfirmed submission is sent again while online. */
const RESUBMIT_MS = 5_000;

/** What the screen tells staff about releasing the bags, by whose record decides (D56). */
function releaseRule(t: ReturnType<typeof useI18n>['t'], features: Features): string {
  return features.release_authority === 'farmledge' ? t('doNotRelease') : t('releaseAsUsual');
}

export interface DispatchDraft {
  dispatchId: string;
  phone: string;
  farmer: { id: string; full_name: string; phone: string } | null;
  commodity: Commodity | null;
  grade: string | null;
  bags: string;
  /** A specific lot; null for the server's oldest-first rule. */
  depositId: string | null;
  weight: string;
  notWeighed: boolean;
  /** One of NOT_WEIGHED_REASONS, or the custodian's own words. */
  notWeighedReason: string;
  /**
   * editing, then `pending` once sent: from then on the saved request
   * (store `pendingDispatches`) and its outcome are what the screen shows.
   */
  phase: 'editing' | 'pending';
}

export function newDispatchDraft(): DispatchDraft {
  return {
    dispatchId: crypto.randomUUID(),
    phone: '',
    farmer: null,
    commodity: null,
    grade: null,
    bags: '',
    depositId: null,
    weight: '',
    notWeighed: false,
    notWeighedReason: '',
    phase: 'editing',
  };
}

interface DispatchProps {
  draft: DispatchDraft;
  setDraft: (change: (draft: DispatchDraft) => DispatchDraft) => void;
  onDone: () => void;
  onCancel: () => void;
  /** After LEAVE_PENDING_AFTER_MS: back to Home; the dispatch stays pending there. */
  onLeave: () => void;
  /** Too many wrong PINs at sign-off: lock the tablet. */
  onLock: () => void;
}

export function Dispatch({ draft, setDraft, onDone, onCancel, onLeave, onLock }: DispatchProps) {
  const app = useApp();
  const { api, db } = app;
  const { t, language } = useI18n();
  const [history, setHistory] = useState<Step[]>(['phone']);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<BalanceLine[] | null>(null);
  const [lots, setLots] = useState<LotView[] | null>(null);
  const [plan, setPlan] = useState<DispatchPlan | null>(null);
  const [pin, setPin] = useState('');
  /** Bumped by every attempt that leaves the dispatch unconfirmed, so the retry timer re-arms. */
  const [sending, setSending] = useState(false);
  const step = history[history.length - 1] ?? 'phone';
  const online = app.connection === 'online';
  const topRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    topRef.current?.scrollIntoView({ block: 'start' });
  }, [step]);
  useEffect(() => {
    if (error !== null) errorRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [error]);

  const update = (change: Partial<DispatchDraft>) => {
    setDraft((current) => ({ ...current, ...change }));
  };
  const go = (next: Step) => {
    setError(null);
    setHistory((h) => [...h, next]);
  };
  const back = () => {
    setError(null);
    if (history.length <= 1) onCancel();
    else setHistory((h) => h.slice(0, -1));
  };
  /** Back to an earlier step, dropping what came after it. */
  const backTo = (target: Step) => {
    setHistory((h) => {
      const at = h.lastIndexOf(target);
      return at === -1 ? [...h, target] : h.slice(0, at + 1);
    });
  };
  const apiError = (err: unknown): string =>
    err instanceof HttpError
      ? errorText(language, err.code, err.message)
      : err instanceof NetworkError
        ? t('dispatchConnectionLost')
        : t('saveFailed');

  const token = app.session.token;
  const warehouseId = app.session.warehouse.id;
  const line = lines?.find((l) => l.commodity === draft.commodity && l.grade === draft.grade);
  const bags = parseWholeCount(draft.bags);
  const weight = parseKg(draft.weight);
  const scaleRequired = app.features.weight_mode === 'scale_required';

  // ---- Loading what the screens show, always from the server ----------------

  const loadLines = useCallback(
    async (farmerId: string) => {
      const { data } = await api<BalanceResponse>(
        'GET',
        `/farmers/${farmerId}/balance?warehouse=${warehouseId}`,
        { token },
      );
      setLines(data.items.filter((l) => l.warehouse_id === warehouseId));
    },
    [api, token, warehouseId],
  );

  const loadLots = useCallback(async () => {
    if (draft.farmer === null || draft.commodity === null || draft.grade === null) return;
    const { data } = await api<LotsResponse>(
      'GET',
      `/farmers/${draft.farmer.id}/lots?warehouse=${warehouseId}&commodity=${draft.commodity}&grade=${encodeURIComponent(draft.grade)}`,
      { token },
    );
    setLots(data.items);
  }, [api, draft.commodity, draft.farmer, draft.grade, token, warehouseId]);

  const loadPlan = useCallback(
    async (depositId: string | null) => {
      if (
        draft.farmer === null ||
        draft.commodity === null ||
        draft.grade === null ||
        bags === null
      )
        return;
      const { data } = await api<DispatchPlan>('POST', '/dispatches/plan', {
        token,
        json: {
          warehouse_id: warehouseId,
          farmer_id: draft.farmer.id,
          custodian_id: app.session.custodian.id,
          commodity: draft.commodity,
          grade: draft.grade,
          bag_count: bags,
          deposit_id: depositId,
        },
      });
      setPlan(data);
    },
    [
      api,
      app.session.custodian.id,
      bags,
      draft.commodity,
      draft.farmer,
      draft.grade,
      token,
      warehouseId,
    ],
  );

  /** Runs a load, showing its error. Returns whether it worked. */
  const attempt = async (load: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await load();
      return true;
    } catch (err) {
      setError(apiError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // ---- Submitting ---------------------------------------------------------------

  const request = (): DispatchRequest | null => {
    if (draft.farmer === null || draft.commodity === null || draft.grade === null || bags === null)
      return null;
    return {
      dispatch_id: draft.dispatchId,
      warehouse_id: warehouseId,
      farmer_id: draft.farmer.id,
      custodian_id: app.session.custodian.id,
      commodity: draft.commodity,
      grade: draft.grade,
      bag_count: bags,
      ...(draft.notWeighed
        ? { not_weighed_reason: draft.notWeighedReason }
        : { exit_weight_kg: weight }),
      farmer_confirmed: true,
      deposit_id: draft.depositId,
    };
  };

  /**
   * The first send, straight after sign-off. The request is saved first
   * (src/dispatch/pending.ts), so a reload or crash never loses it. A refusal
   * now means nothing was recorded: back to the steps with the reason.
   * Otherwise PendingDispatchView takes over until the outcome is known.
   */
  const send = async (body: DispatchRequest) => {
    setSending(true);
    const pending = await savePending(db, body, app.session, draft.farmer?.full_name ?? '');
    const result = await resolvePending(db, api, pending, { firstSend: true });
    setSending(false);
    if (result.unreachable) app.connectivity.reportUnreachable();
    if (result.state !== 'not_recorded') {
      update({ phase: 'pending' });
      return;
    }
    await acknowledgePending(db, body.dispatch_id);
    setPin('');
    const code = result.lastError?.code ?? '';
    const message = errorText(language, code, result.lastError?.message ?? '');
    if (code === 'insufficient_balance' || code === 'lot_governed_on_chain') {
      // Something changed since the plan: show the lots again, with the server's reason.
      setPlan(null);
      backTo('lots');
      setError(message);
      void loadLots().catch(() => undefined);
      return;
    }
    setError(message);
  };

  if (sending) {
    return (
      <main className="screen" data-testid="dispatch-sending">
        <h1>{t('dispatchSending')}</h1>
        <p className="message" data-tone="warn" role="status">
          {releaseRule(t, app.features)}
        </p>
      </main>
    );
  }
  if (draft.phase === 'pending') {
    return <PendingDispatchView dispatchId={draft.dispatchId} onClose={onDone} onLeave={onLeave} />;
  }

  // ---- The seven steps -------------------------------------------------------------

  const header = (
    <>
      <div className="screen__step" ref={topRef}>
        {t('stepOf', { n: sectionOf(step) + 1, total: SECTIONS.length })}
      </div>
      {!online && (
        <p className="message" data-tone="warn" role="status" data-testid="dispatch-offline">
          {t('dispatchOfflineMidway')}
        </p>
      )}
      {error !== null && (
        <p className="message" data-tone="bad" role="alert" ref={errorRef}>
          {error}
        </p>
      )}
    </>
  );
  const backButton = (
    <button type="button" className="btn" onClick={back}>
      {history.length <= 1 ? t('cancel') : t('back')}
    </button>
  );

  const lookUp = async () => {
    const phone = normaliseNigerianMobile(draft.phone);
    if (phone === null) {
      setError(t('signInInvalidPhone'));
      return;
    }
    setBusy(true);
    const result = await findFarmer(db, api, app.session, phone, online);
    setBusy(false);
    if (result?.kind === 'found' && result.farmer.id !== null) {
      update({
        farmer: { id: result.farmer.id, full_name: result.farmer.full_name, phone },
      });
      go('confirmFarmer');
    } else {
      update({ farmer: null });
      go('notFound');
    }
  };

  switch (step) {
    case 'phone':
      return (
        <main className="screen">
          {header}
          <h1>{t('farmerPhoneTitle')}</h1>
          <Keypad
            label={t('farmerPhoneTitle')}
            placeholder="0803 123 4567"
            value={draft.phone}
            onChange={(phone) => {
              update({ phone });
            }}
            maxLength={14}
          />
          <div className="actions">
            {backButton}
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !online || normaliseNigerianMobile(draft.phone) === null}
              onClick={() => void lookUp()}
            >
              {busy ? t('lookingUp') : t('next')}
            </button>
          </div>
        </main>
      );

    case 'notFound':
      return (
        <main className="screen">
          {header}
          <h1>{formatLocalPhone(normaliseNigerianMobile(draft.phone) ?? draft.phone)}</h1>
          <p className="message" data-tone="warn">
            {t('dispatchFarmerNotFound')}
          </p>
          <div className="actions">{backButton}</div>
        </main>
      );

    case 'confirmFarmer':
      return (
        <main className="screen">
          {header}
          <h1>{t('isThisFarmer')}</h1>
          <p className="reference">{draft.farmer?.full_name}</p>
          <p className="hint" style={{ textAlign: 'center' }}>
            {formatLocalPhone(draft.farmer?.phone ?? '')}
          </p>
          <div className="choices">
            <button type="button" className="btn" onClick={back}>
              {t('no')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !online}
              onClick={() => {
                const farmer = draft.farmer;
                if (farmer === null) return;
                void attempt(() => loadLines(farmer.id)).then((ok) => {
                  if (ok) go('holdings');
                });
              }}
            >
              {t('yes')}
            </button>
          </div>
        </main>
      );

    case 'holdings':
      return (
        <main className="screen">
          {header}
          <h1>{t('holdingsTitle')}</h1>
          {lines === null || lines.length === 0 ? (
            <p className="message" data-tone="warn">
              {t('noStock')}
            </p>
          ) : (
            <div className="choices" style={{ gridTemplateColumns: '1fr' }}>
              {lines.map((l) => {
                const none = l.free_bags === 0;
                return (
                  <button
                    key={`${l.commodity}-${l.grade}`}
                    type="button"
                    className="btn card"
                    data-testid="holding"
                    aria-disabled={none}
                    data-tone={none ? 'muted' : undefined}
                    onClick={() => {
                      if (none) return;
                      update({ commodity: l.commodity, grade: l.grade, bags: '', depositId: null });
                      setLots(null);
                      setPlan(null);
                      go('bags');
                    }}
                  >
                    <span className="card__line" style={{ width: '100%' }}>
                      <span className="card__title">
                        {t(l.commodity)} · {t('grade', { grade: l.grade })}
                      </span>
                      <span>{t('freeBags', { n: l.free_bags })}</span>
                    </span>
                    {l.held_on_chain_bags > 0 && (
                      <span className="card__line" style={{ width: '100%' }}>
                        <span>
                          {none
                            ? t('allHeldOnChain', {
                                n: l.held_on_chain_bags,
                                lots: l.held_on_chain_lots.join(', '),
                              })
                            : t('someHeldOnChain', {
                                n: l.held_on_chain_bags,
                                lots: l.held_on_chain_lots.join(', '),
                              })}
                        </span>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <div className="actions">{backButton}</div>
        </main>
      );

    case 'bags': {
      const free = line?.free_bags ?? 0;
      const held = line?.held_on_chain_bags ?? 0;
      const next = () => {
        if (bags === null) setError(t('bagsInvalid'));
        else if (bags > free) setError(t('bagsOverFree', { n: bags, free, held }));
        else
          void attempt(async () => {
            await Promise.all([loadLots(), loadPlan(draft.depositId)]);
          }).then((ok) => {
            if (ok) go('lots');
          });
      };
      return (
        <main className="screen">
          {header}
          <h1>{t('bagsOutTitle')}</h1>
          <p className="hint" data-testid="free-bags">
            {t('freeBags', { n: free })}
            {held > 0 && ` · ${t('heldBags', { n: held })}`}
          </p>
          {bags !== null && bags > free && (
            <p className="message" data-tone="bad" role="alert" data-testid="over-free">
              {t('bagsOverFree', { n: bags, free, held })}
            </p>
          )}
          <Keypad
            label={t('bagsOutTitle')}
            placeholder="5"
            value={draft.bags}
            onChange={(value) => {
              setError(null);
              update({ bags: value, depositId: null });
            }}
            maxLength={5}
          />
          <div className="actions">
            {backButton}
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !online || draft.bags === '' || (bags !== null && bags > free)}
              onClick={next}
            >
              {t('next')}
            </button>
          </div>
        </main>
      );
    }

    case 'lots':
      return (
        <main className="screen">
          {header}
          <h1>{t('lotsTitle')}</h1>
          {plan !== null && (
            <p className="message" data-tone="ok" data-testid="plan">
              {t(draft.depositId === null ? 'planOldestFirst' : 'planChosenLot')}{' '}
              {plan.lots_drawn
                .map((lot) => t('lotBags', { n: lot.deposit_no, bags: lot.bags }))
                .join(', ')}
            </p>
          )}
          <LotList lots={lots ?? []} drawn={plan?.lots_drawn.map((l) => l.deposit_id) ?? []} />
          <div className="actions">
            {backButton}
            <button
              type="button"
              className="btn"
              disabled={busy || !online}
              onClick={() => {
                go('chooseLot');
              }}
            >
              {t('chooseLot')}
            </button>
            {draft.depositId !== null && (
              <button
                type="button"
                className="btn"
                disabled={busy || !online}
                onClick={() => {
                  update({ depositId: null });
                  void attempt(() => loadPlan(null));
                }}
              >
                {t('useOldestFirst')}
              </button>
            )}
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !online || plan === null}
              onClick={() => {
                go('weight');
              }}
            >
              {t('next')}
            </button>
          </div>
        </main>
      );

    case 'chooseLot':
      return (
        <main className="screen">
          {header}
          <h1>{t('chooseLotTitle', { n: draft.bags })}</h1>
          <div className="choices" style={{ gridTemplateColumns: '1fr' }}>
            {(lots ?? []).map((lot) => {
              const enough = bags !== null && lot.bags >= bags;
              const usable = lot.state === 'free' && enough;
              return (
                <button
                  key={lot.deposit_id}
                  type="button"
                  className="btn card"
                  data-testid="lot-choice"
                  aria-disabled={!usable}
                  data-tone={usable ? undefined : 'muted'}
                  onClick={() => {
                    if (!usable) return;
                    update({ depositId: lot.deposit_id });
                    void attempt(() => loadPlan(lot.deposit_id)).then((ok) => {
                      if (ok) backTo('lots');
                    });
                  }}
                >
                  <span className="card__line" style={{ width: '100%' }}>
                    <span className="card__title">{t('lotNumber', { n: lot.deposit_no })}</span>
                    <span>{t('bagsKg', { bags: lot.bags, kg: formatKg(lot.kg) })}</span>
                  </span>
                  <span className="card__line" style={{ width: '100%' }}>
                    <span>
                      {lot.state !== 'free'
                        ? lotReason(t, lot)
                        : enough
                          ? new Date(lot.intake_at).toLocaleDateString()
                          : t('lotTooSmall', { n: lot.bags })}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="actions">{backButton}</div>
        </main>
      );

    case 'weight':
      return (
        <main className="screen">
          {header}
          <h1>{t('weightReleasedTitle')}</h1>
          <p className="hint">{t('weightReleasedHint', { kg: formatKg(plan?.book_kg ?? 0) })}</p>
          <Keypad
            label={t('weightReleasedTitle')}
            placeholder="985.5"
            value={draft.weight}
            onChange={(value) => {
              update({ weight: value, notWeighed: false, notWeighedReason: '' });
            }}
            maxLength={9}
            decimal
          />
          <div className="actions">
            {backButton}
            {!scaleRequired && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  update({ weight: '' });
                  go('notWeighedReason');
                }}
              >
                {t('notWeighed')}
              </button>
            )}
            <button
              type="button"
              className="btn btn--primary"
              disabled={weight === null}
              onClick={() => {
                update({ notWeighed: false, notWeighedReason: '' });
                go('review');
              }}
            >
              {t('next')}
            </button>
          </div>
        </main>
      );

    case 'notWeighedReason': {
      const other = !(NOT_WEIGHED_REASONS as readonly string[]).includes(draft.notWeighedReason);
      const typed = draft.notWeighedReason.trim();
      return (
        <main className="screen">
          {header}
          <h1>{t('notWeighedTitle')}</h1>
          <p className="hint">{t('notWeighedHint')}</p>
          <div className="choices" style={{ gridTemplateColumns: '1fr' }}>
            {NOT_WEIGHED_REASONS.map((reason, index) => (
              <button
                key={reason}
                type="button"
                className="btn"
                aria-pressed={draft.notWeighed && draft.notWeighedReason === reason}
                onClick={() => {
                  update({ notWeighed: true, notWeighedReason: reason, weight: '' });
                  go('review');
                }}
              >
                {t(index === 0 ? 'reasonNoScale' : 'reasonScaleBroken')}
              </button>
            ))}
          </div>
          <input
            className="text-field"
            autoComplete="off"
            aria-label={t('reasonOther')}
            placeholder={t('reasonOther')}
            maxLength={500}
            value={other ? draft.notWeighedReason : ''}
            onChange={(event) => {
              update({ notWeighedReason: event.target.value });
            }}
          />
          <div className="actions">
            {backButton}
            <button
              type="button"
              className="btn btn--primary"
              disabled={!other || typed === ''}
              onClick={() => {
                update({ notWeighed: true, notWeighedReason: typed, weight: '' });
                go('review');
              }}
            >
              {t('next')}
            </button>
          </div>
        </main>
      );
    }

    case 'review': {
      const shownReason =
        draft.notWeighedReason === NOT_WEIGHED_REASONS[0]
          ? t('reasonNoScale')
          : draft.notWeighedReason === NOT_WEIGHED_REASONS[1]
            ? t('reasonScaleBroken')
            : draft.notWeighedReason;
      const rows: [string, string][] = [
        [t('farmer'), draft.farmer?.full_name ?? ''],
        [
          t('commodity'),
          draft.commodity === null
            ? ''
            : `${t(draft.commodity)} · ${t('grade', { grade: draft.grade ?? '' })}`,
        ],
        [t('bagsOut'), draft.bags],
        [
          t('lotsDrawn'),
          (plan?.lots_drawn ?? [])
            .map((lot) => t('lotBags', { n: lot.deposit_no, bags: lot.bags }))
            .join(', '),
        ],
        [
          t('weightReleased'),
          draft.notWeighed
            ? t('notWeighedWithReason', { reason: shownReason })
            : formatKg(weight ?? 0),
        ],
      ];
      return (
        <main className="screen">
          {header}
          <h1>{t('dispatchReviewTitle')}</h1>
          <dl className="review" data-testid="dispatch-review">
            {rows.map(([label, value]) => (
              <div className="review__row" key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className="read-aloud">
            {t('dispatchReadAloud', {
              bags: draft.bags,
              name: draft.farmer?.full_name ?? '',
            })}
          </p>
          <div className="actions">
            {backButton}
            <button
              type="button"
              className="btn btn--primary btn--huge"
              onClick={() => {
                setPin('');
                go('signOff');
              }}
            >
              {t('farmerConfirms')}
            </button>
          </div>
        </main>
      );
    }

    case 'signOff': {
      const signOff = async () => {
        setBusy(true);
        setError(null);
        const outcome = await unlock(db, app.session.id, pin);
        setBusy(false);
        setPin('');
        const body = request();
        if (outcome.ok && body !== null) {
          void send(body);
        } else if (outcome.ok) {
          setError(t('saveFailed'));
        } else if (outcome.reason === 'offline_locked') {
          onLock();
        } else {
          setError(t('signOffWrongPin'));
        }
      };
      return (
        <main className="screen">
          {header}
          <h1>{t('signOffTitle', { name: app.session.custodian.full_name })}</h1>
          <p className="hint">{t('signOffHint')}</p>
          <Keypad label={t('yourPin')} value={pin} onChange={setPin} maxLength={6} masked />
          <div className="actions">
            {backButton}
            <button
              type="button"
              className="btn btn--primary btn--huge"
              disabled={busy || !online || pin.length !== 6}
              onClick={() => void signOff()}
            >
              {t('signOffAndDispatch')}
            </button>
          </div>
        </main>
      );
    }
  }
}

type Translate = ReturnType<typeof useI18n>['t'];

/** Why a lot can't leave, in the screen's language. */
function lotReason(t: Translate, lot: LotView): string {
  return lot.state === 'minted'
    ? t('lotMinted', { receipt: lot.receipt_id ?? '?' })
    : t('lotPledged');
}

/** Every lot of the grade, oldest first; excluded ones are shown with their reason, never hidden. */
function LotList({ lots, drawn }: { lots: LotView[]; drawn: string[] }) {
  const { t } = useI18n();
  return (
    <ul className="list" data-testid="lots">
      {lots.map((lot) => {
        const tone =
          lot.state !== 'free' ? 'bad' : drawn.includes(lot.deposit_id) ? 'ok' : undefined;
        return (
          <li
            key={lot.deposit_id}
            className="card"
            data-testid="lot"
            data-state={lot.state}
            data-tone={tone}
          >
            <span className="card__line">
              <span className="card__title">{t('lotNumber', { n: lot.deposit_no })}</span>
              <span>{t('bagsKg', { bags: lot.bags, kg: formatKg(lot.kg) })}</span>
            </span>
            <span className="card__line">
              <span>{new Date(lot.intake_at).toLocaleDateString()}</span>
              <span className="tag" data-tone={tone ?? 'warn'}>
                {lot.state !== 'free'
                  ? t('excluded')
                  : drawn.includes(lot.deposit_id)
                    ? t('drawnFrom')
                    : t('lotFree')}
              </span>
            </span>
            {lot.state !== 'free' && (
              <p className="message" data-tone="bad" data-testid="lot-reason">
                {lotReason(t, lot)}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Recorded by the server: the delivery note prints from the server's own record. */
function DispatchDone({ result, onDone }: { result: DispatchView; onDone: () => void }) {
  const app = useApp();
  const { t } = useI18n();
  const { api } = app;
  const token = app.session.token;
  const [note, setNote] = useState<DeliveryNote | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    api<DeliveryNoteResponse>('GET', `/dispatches/${result.dispatch_id}/delivery-note`, { token })
      .then(({ data }) => {
        if (live) setNote(data.delivery_note);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [api, token, result.dispatch_id, attempt]);
  const load = () => {
    setFailed(false);
    setAttempt((n) => n + 1);
  };

  return (
    <main className="screen" data-testid="dispatch-done">
      <div className="done-mark" aria-hidden="true">
        ✓
      </div>
      <h1 style={{ textAlign: 'center' }}>{t('dispatchRecorded')}</h1>
      <p className="message" data-tone="ok" role="status">
        {t('releaseNow', { n: result.bag_count })}
      </p>
      <p className="reference" data-testid="delivery-note-no">
        {result.delivery_note_no}
      </p>
      <p className="hint" style={{ textAlign: 'center' }}>
        {result.lots_drawn
          .map((lot) => t('lotBags', { n: lot.deposit_no, bags: lot.bags }))
          .join(', ')}
      </p>
      {failed && (
        <p className="message" data-tone="warn">
          {t('deliveryNoteLoadFailed')}
        </p>
      )}
      <div className="actions">
        {failed ? (
          <button type="button" className="btn" onClick={load}>
            {t('tryAgainNow')}
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={note === null}
            onClick={() => {
              window.print();
            }}
          >
            🖨 {t('printDeliveryNote')}
          </button>
        )}
        <button type="button" className="btn btn--primary" onClick={onDone}>
          {t('home')}
        </button>
      </div>
      {note !== null && <DeliveryNoteSlip note={note} />}
    </main>
  );
}

/** Shown instead of the dispatch flow when the tablet is offline; the attempt is already recorded. */
export function DispatchBlocked({ count, onHome }: { count: number; onHome: () => void }) {
  const { t } = useI18n();
  const app = useApp();
  const paper = app.features.release_authority !== 'farmledge';
  return (
    <main className="screen" data-testid="dispatch-blocked">
      <h1>{t('dispatchBlockedTitle')}</h1>
      <p className="message" data-tone="bad" role="alert">
        {paper ? t('dispatchBlockedPaper') : t('dispatchNeedsConnection')}
      </p>
      <p className="hint">{t('dispatchBlockedCounted', { n: count })}</p>
      <div className="actions">
        <button type="button" className="btn btn--primary" onClick={onHome}>
          {t('home')}
        </button>
      </div>
    </main>
  );
}

/**
 * A sent dispatch until its outcome is known and seen: from the dispatch
 * flow, or from Home after "Leave pending". It keeps resolving every few
 * seconds while online (src/dispatch/pending.ts); what it tells staff about
 * the bags follows the release rule in force (D56).
 */
export function PendingDispatchView({
  dispatchId,
  onClose,
  onLeave,
}: {
  dispatchId: string;
  onClose: () => void;
  onLeave?: (() => void) | undefined;
}) {
  const app = useApp();
  const { t, language } = useI18n();
  const { api, db } = app;
  const online = app.connection === 'online';
  const [pending, setPending] = useState<PendingDispatch | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const busy = useRef(false);

  useEffect(() => {
    let live = true;
    void db.get('pendingDispatches', dispatchId).then((found) => {
      if (live) setPending(found ?? null);
    });
    return () => {
      live = false;
    };
  }, [db, dispatchId, app.revision]);

  const state = pending?.state;
  const tryNow = useCallback(async () => {
    if (busy.current) return;
    const current = await db.get('pendingDispatches', dispatchId);
    if (current?.state !== 'unconfirmed') return;
    busy.current = true;
    try {
      const result = await resolvePending(db, api, current);
      if (result.unreachable) app.connectivity.reportUnreachable();
      setPending(result);
    } finally {
      busy.current = false;
    }
  }, [api, app.connectivity, db, dispatchId]);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      if (online && state === 'unconfirmed') void tryNow();
    }, RESUBMIT_MS);
    return () => {
      clearInterval(timer);
    };
  }, [online, state, tryNow]);

  if (pending === null) return null;
  const close = () => {
    void acknowledgePending(db, dispatchId).then(onClose);
  };

  if (pending.state === 'recorded' && pending.result !== null) {
    return <DispatchDone result={pending.result} onDone={close} />;
  }

  const details = (
    <dl className="review">
      <div className="review__row">
        <dt>{t('reference')}</dt>
        <dd data-testid="dispatch-reference">{dispatchReference(dispatchId)}</dd>
      </div>
      <div className="review__row">
        <dt>{t('farmer')}</dt>
        <dd>{pending.farmerName}</dd>
      </div>
      <div className="review__row">
        <dt>{t('bagsOut')}</dt>
        <dd>{pending.request.bag_count}</dd>
      </div>
    </dl>
  );

  if (pending.state === 'not_recorded') {
    return (
      <main className="screen" data-testid="dispatch-not-recorded">
        <h1>{t('dispatchNotRecorded')}</h1>
        <p className="message" data-tone="bad" role="alert">
          {app.features.release_authority === 'farmledge'
            ? t('notRecordedStartAgain')
            : t('notRecordedPaper')}
        </p>
        {details}
        <div className="actions">
          <button type="button" className="btn btn--primary" onClick={close}>
            {t('done')}
          </button>
        </div>
      </main>
    );
  }

  const waited = now - pending.firstSentAt;
  return (
    <main className="screen" data-testid="dispatch-unconfirmed">
      <h1>{t('dispatchNotConfirmed')}</h1>
      <p className="message" data-tone="bad" role="alert" data-testid="release-rule">
        {releaseRule(t, app.features)}
      </p>
      {details}
      {pending.lastError !== null && (
        <p className="message" data-tone="warn" data-testid="unconfirmed-error">
          {errorText(language, pending.lastError.code, pending.lastError.message)}
        </p>
      )}
      <p className="hint">{online ? t('dispatchRetrying') : t('dispatchWaitingSignal')}</p>
      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!online}
          onClick={() => void tryNow()}
        >
          {t('tryAgainNow')}
        </button>
        {onLeave !== undefined && waited >= LEAVE_PENDING_AFTER_MS && (
          <button type="button" className="btn" onClick={onLeave}>
            {t('leavePending')}
          </button>
        )}
      </div>
      {onLeave !== undefined && waited < LEAVE_PENDING_AFTER_MS && (
        <p className="hint">{t('leavePendingAfter', { n: LEAVE_PENDING_AFTER_MS / 60_000 })}</p>
      )}
    </main>
  );
}
