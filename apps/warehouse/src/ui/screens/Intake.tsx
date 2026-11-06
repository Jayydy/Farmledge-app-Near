import { useEffect, useRef, useState } from 'react';

import { findFarmer } from '../../farmers/cache';
import { useI18n } from '../../i18n';
import { parseKg, parseMoisture, parseWholeCount } from '../../lib/numbers';
import { formatLocalPhone, normaliseNigerianMobile } from '../../lib/phone';
import { preparePhoto, type PreparedPhoto } from '../../lib/photos';
import { saveCapture, type Capture } from '../../sync/capture';
import type { Commodity } from '../../types/api';
import { Keypad } from '../components/Keypad';
import { useApp } from '../services';

type Step =
  | 'phone'
  | 'confirmFarmer'
  | 'notFound'
  | 'name'
  | 'consent'
  | 'lookupConsent'
  | 'commodity'
  | 'grade'
  | 'moisture'
  | 'bags'
  | 'bagsConfirm'
  | 'verifier'
  | 'sample'
  | 'sampleBags'
  | 'sampleKg'
  | 'photos'
  | 'review';

/** Steps grouped as the custodian sees them: "Step n of 9". */
const SECTIONS: Step[][] = [
  ['phone', 'confirmFarmer', 'notFound', 'name', 'consent', 'lookupConsent'],
  ['commodity'],
  ['grade'],
  ['moisture'],
  ['bags', 'bagsConfirm'],
  ['verifier'],
  ['sample', 'sampleBags', 'sampleKg'],
  ['photos'],
  ['review'],
];
const sectionOf = (step: Step) => SECTIONS.findIndex((steps) => steps.includes(step));

type FoundFarmer =
  | { kind: 'known'; id: string; full_name: string; phone: string }
  | { kind: 'queued'; localFarmerId: string; full_name: string; phone: string };

export interface Draft {
  depositId: string;
  phone: string;
  found: FoundFarmer | null;
  lookup: 'not_found' | 'unknown_offline' | null;
  name: string;
  lookupConsent: boolean | null;
  commodity: Commodity | null;
  grade: string | null;
  moisture: string;
  bags: string;
  bagsConfirmed: boolean;
  verifierId: string | null;
  sample: 'skip' | 'yes' | null;
  sampleBags: string;
  sampleKg: string;
  photos: PreparedPhoto[];
}

export function newDraft(): Draft {
  return {
    depositId: crypto.randomUUID(),
    phone: '',
    found: null,
    lookup: null,
    name: '',
    lookupConsent: null,
    commodity: null,
    grade: null,
    moisture: '',
    bags: '',
    bagsConfirmed: false,
    verifierId: null,
    sample: null,
    sampleBags: '',
    sampleKg: '',
    photos: [],
  };
}

interface IntakeProps {
  draft: Draft;
  setDraft: (change: (draft: Draft) => Draft) => void;
  onSaved: (depositId: string) => void;
  onCancel: () => void;
}

export function Intake({ draft, setDraft, onSaved, onCancel }: IntakeProps) {
  const app = useApp();
  const { t } = useI18n();
  const [history, setHistory] = useState<Step[]>(['phone']);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const step = history[history.length - 1] ?? 'phone';
  const topRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  // Each step starts at its top; an error is scrolled into view where it appears.
  useEffect(() => {
    topRef.current?.scrollIntoView({ block: 'start' });
  }, [step]);
  useEffect(() => {
    if (error !== null) errorRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [error]);
  const intake = app.features.intake;
  const verifiers = app.session.roster.verifiers;
  const update = (change: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...change }));
  };

  const go = (next: Step) => {
    setError(null);
    // Editing from the review screen: return there once the edited section is done.
    const target = editing && sectionOf(next) !== sectionOf(step) ? 'review' : next;
    if (target === 'review') setEditing(false);
    setHistory((h) => [...h, target]);
  };
  const back = () => {
    setError(null);
    if (history.length <= 1) onCancel();
    else setHistory((h) => h.slice(0, -1));
  };
  const edit = (target: Step) => {
    setEditing(true);
    setHistory((h) => [...h, target]);
  };

  const moisture = parseMoisture(draft.moisture);
  const commodityRules = intake.commodities.find((c) => c.code === draft.commodity);
  const bags = parseWholeCount(draft.bags);
  const sampleBags = parseWholeCount(draft.sampleBags);
  const sampleKg = parseKg(draft.sampleKg);
  const farmerName = draft.found?.full_name ?? draft.name.trim().replace(/\s+/g, ' ');
  const verifier = verifiers.find((v) => v.id === draft.verifierId);

  const afterFarmer = () => {
    go('commodity');
  };

  const lookUp = async () => {
    const phone = normaliseNigerianMobile(draft.phone);
    if (phone === null) {
      setError(t('signInInvalidPhone'));
      return;
    }
    setBusy(true);
    const result = await findFarmer(
      app.db,
      app.api,
      app.session,
      phone,
      app.connection === 'online',
    );
    setBusy(false);
    if (result?.kind === 'found') {
      const farmer = result.farmer;
      update({
        found:
          farmer.id !== null
            ? { kind: 'known', id: farmer.id, full_name: farmer.full_name, phone: farmer.phone }
            : {
                kind: 'queued',
                localFarmerId: farmer.localFarmerId ?? '',
                full_name: farmer.full_name,
                phone: farmer.phone,
              },
        lookup: null,
      });
      go('confirmFarmer');
    } else {
      update({ found: null, lookup: result?.kind ?? 'unknown_offline', lookupConsent: null });
      go('notFound');
    }
  };

  const save = async () => {
    const phone = normaliseNigerianMobile(draft.phone);
    if (
      phone === null ||
      draft.commodity === null ||
      draft.grade === null ||
      moisture === null ||
      bags === null ||
      verifier === undefined
    ) {
      return;
    }
    const farmer: Capture['farmer'] =
      draft.found ??
      ({
        kind: 'new',
        localFarmerId: crypto.randomUUID(),
        full_name: farmerName,
        phone,
        consent: true,
        lookupConsent: draft.lookupConsent === true,
      } as const);
    const capture: Capture = {
      depositId: draft.depositId,
      capturedAt: new Date(),
      session: {
        id: app.session.id,
        custodian: { id: app.session.custodian.id, full_name: app.session.custodian.full_name },
        warehouse: app.session.warehouse,
      },
      verifier,
      farmer,
      commodity: draft.commodity,
      grade: draft.grade,
      moisturePct: moisture,
      bagCount: bags,
      confirmBagCount: bags > intake.bag_count_confirm_above,
      sample:
        draft.sample === 'yes' && sampleBags !== null && sampleKg !== null
          ? { sampleId: crypto.randomUUID(), bagsWeighed: sampleBags, totalKg: sampleKg }
          : null,
      photos: draft.photos.map(({ photoId, blob, contentType, sha256 }) => ({
        photoId,
        blob,
        contentType,
        sha256,
      })),
    };
    setBusy(true);
    setError(null);
    try {
      await saveCapture(app.db, capture);
      onSaved(draft.depositId);
    } catch {
      setError(t('saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <>
      <div className="screen__step" ref={topRef}>
        {t('stepOf', { n: sectionOf(step) + 1, total: SECTIONS.length })}
      </div>
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
              disabled={busy || normaliseNigerianMobile(draft.phone) === null}
              onClick={() => void lookUp()}
            >
              {busy ? t('lookingUp') : t('next')}
            </button>
          </div>
        </main>
      );

    case 'confirmFarmer':
      return (
        <main className="screen">
          {header}
          <h1>{t('isThisFarmer')}</h1>
          <p className="reference">{draft.found?.full_name}</p>
          <p className="hint" style={{ textAlign: 'center' }}>
            {formatLocalPhone(draft.found?.phone ?? '')}
          </p>
          {draft.found?.kind === 'queued' && (
            <p className="message" data-tone="warn">
              {t('queuedFarmer')}
            </p>
          )}
          <div className="choices">
            <button
              type="button"
              className="btn"
              onClick={() => {
                update({ found: null });
                back();
              }}
            >
              {t('no')}
            </button>
            <button type="button" className="btn btn--primary" onClick={afterFarmer}>
              {t('yes')}
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
            {draft.lookup === 'not_found' ? t('farmerNotFound') : t('farmerUnknownOffline')}
          </p>
          <div className="actions">
            {backButton}
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                go('name');
              }}
            >
              {t('registerFarmer')}
            </button>
          </div>
        </main>
      );

    case 'name': {
      const valid = farmerName.length >= 2 && farmerName.length <= 100;
      return (
        <main className="screen">
          {header}
          <h1>{t('farmerNameTitle')}</h1>
          <p className="hint">{t('farmerNameHint')}</p>
          <input
            className="text-field"
            autoFocus
            autoComplete="off"
            autoCapitalize="words"
            enterKeyHint="next"
            aria-label={t('farmerNameTitle')}
            value={draft.name}
            onChange={(event) => {
              update({ name: event.target.value });
            }}
          />
          <div className="actions">
            {backButton}
            <button
              type="button"
              className="btn btn--primary"
              disabled={!valid}
              onClick={() => {
                go('consent');
              }}
            >
              {t('next')}
            </button>
          </div>
        </main>
      );
    }

    case 'consent':
      return (
        <main className="screen">
          {header}
          <h1>{t('consentTitle')}</h1>
          <p className="read-aloud">{t('consentText')}</p>
          <div className="choices">
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                setError(t('consentRefused'));
              }}
            >
              {t('consentRefuse')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                go('lookupConsent');
              }}
            >
              {t('consentAgree')}
            </button>
          </div>
          <div className="actions">{backButton}</div>
        </main>
      );

    case 'lookupConsent':
      return (
        <main className="screen">
          {header}
          <h1>{t('lookupConsentTitle')}</h1>
          <p className="read-aloud">{t('lookupConsentText')}</p>
          <div className="choices">
            <button
              type="button"
              className="btn"
              onClick={() => {
                update({ lookupConsent: false });
                afterFarmer();
              }}
            >
              {t('no')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                update({ lookupConsent: true });
                afterFarmer();
              }}
            >
              {t('yes')}
            </button>
          </div>
          <div className="actions">{backButton}</div>
        </main>
      );

    case 'commodity':
      return (
        <main className="screen">
          {header}
          <h1>{t('commodityTitle')}</h1>
          <div className="choices">
            {intake.commodities.map((c) => (
              <button
                key={c.code}
                type="button"
                className="btn"
                aria-pressed={draft.commodity === c.code}
                onClick={() => {
                  update({ commodity: c.code });
                  go('grade');
                }}
              >
                {t(c.code)}
              </button>
            ))}
          </div>
          <div className="actions">{backButton}</div>
        </main>
      );

    case 'grade':
      return (
        <main className="screen">
          {header}
          <h1>{t('gradeTitle')}</h1>
          <div className="choices">
            {app.features.grading.grades.map((grade) => (
              <button
                key={grade}
                type="button"
                className="btn"
                aria-pressed={draft.grade === grade}
                onClick={() => {
                  update({ grade });
                  go('moisture');
                }}
              >
                {t('grade', { grade })}
              </button>
            ))}
          </div>
          <div className="actions">{backButton}</div>
        </main>
      );

    case 'moisture': {
      const range = commodityRules?.moisture_pct;
      const next = () => {
        if (moisture === null) setError(t('moistureInvalid'));
        else if (range !== undefined && (moisture < range.min || moisture > range.max)) {
          setError(t('moistureOutOfRange', { min: range.min, max: range.max }));
        } else go('bags');
      };
      return (
        <main className="screen">
          {header}
          <h1>{t('moistureTitle')}</h1>
          <p className="hint">{t('moistureHint')}</p>
          <Keypad
            label={t('moistureTitle')}
            placeholder="12.5"
            value={draft.moisture}
            onChange={(value) => {
              update({ moisture: value });
            }}
            maxLength={4}
            decimal
          />
          <div className="actions">
            {backButton}
            <button
              type="button"
              className="btn btn--primary"
              disabled={draft.moisture === ''}
              onClick={next}
            >
              {t('next')}
            </button>
          </div>
        </main>
      );
    }

    case 'bags': {
      const next = () => {
        if (bags === null) setError(t('bagsInvalid'));
        else if (bags > intake.bag_count_max)
          setError(t('bagsTooMany', { max: intake.bag_count_max }));
        else if (bags > intake.bag_count_confirm_above && !draft.bagsConfirmed) go('bagsConfirm');
        else go('verifier');
      };
      return (
        <main className="screen">
          {header}
          <h1>{t('bagsTitle')}</h1>
          <Keypad
            label={t('bagsTitle')}
            placeholder="20"
            value={draft.bags}
            onChange={(value) => {
              update({ bags: value, bagsConfirmed: false });
            }}
            maxLength={5}
          />
          <div className="actions">
            {backButton}
            <button
              type="button"
              className="btn btn--primary"
              disabled={draft.bags === ''}
              onClick={next}
            >
              {t('next')}
            </button>
          </div>
        </main>
      );
    }

    case 'bagsConfirm':
      return (
        <main className="screen">
          {header}
          <h1>{t('bagsConfirmTitle')}</h1>
          <p className="reference">{draft.bags}</p>
          <p className="message" data-tone="warn">
            {t('bagsConfirmText', { n: draft.bags })}
          </p>
          <div className="choices">
            <button type="button" className="btn" onClick={back}>
              {t('bagsConfirmNo')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                update({ bagsConfirmed: true });
                go('verifier');
              }}
            >
              {t('bagsConfirmYes', { n: draft.bags })}
            </button>
          </div>
        </main>
      );

    case 'verifier':
      return (
        <main className="screen">
          {header}
          <h1>{t('verifierTitle')}</h1>
          {verifiers.length === 0 ? (
            <p className="message" data-tone="bad">
              {t('noVerifiers')}
            </p>
          ) : (
            <div className="choices">
              {verifiers.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className="btn"
                  aria-pressed={draft.verifierId === v.id}
                  onClick={() => {
                    update({ verifierId: v.id });
                    go('sample');
                  }}
                >
                  {v.full_name}
                </button>
              ))}
            </div>
          )}
          <div className="actions">{backButton}</div>
        </main>
      );

    case 'sample':
      return (
        <main className="screen">
          {header}
          <h1>{t('sampleTitle')}</h1>
          <p className="hint">{t('sampleHint')}</p>
          <div className="choices">
            <button
              type="button"
              className="btn"
              onClick={() => {
                update({ sample: 'skip', sampleBags: '', sampleKg: '' });
                go('photos');
              }}
            >
              {t('sampleSkip')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                update({ sample: 'yes' });
                go('sampleBags');
              }}
            >
              {t('sampleYes')}
            </button>
          </div>
          <div className="actions">{backButton}</div>
        </main>
      );

    case 'sampleBags': {
      const max = bags ?? 1;
      const next = () => {
        if (sampleBags === null || sampleBags > max) setError(t('sampleBagsInvalid', { max }));
        else go('sampleKg');
      };
      return (
        <main className="screen">
          {header}
          <h1>{t('sampleBagsTitle')}</h1>
          <Keypad
            label={t('sampleBagsTitle')}
            placeholder="2"
            value={draft.sampleBags}
            onChange={(value) => {
              update({ sampleBags: value });
            }}
            maxLength={5}
          />
          <div className="actions">
            {backButton}
            <button
              type="button"
              className="btn btn--primary"
              disabled={draft.sampleBags === ''}
              onClick={next}
            >
              {t('next')}
            </button>
          </div>
        </main>
      );
    }

    case 'sampleKg': {
      const next = () => {
        if (sampleKg === null) setError(t('sampleKgInvalid'));
        else go('photos');
      };
      return (
        <main className="screen">
          {header}
          <h1>{t('sampleKgTitle')}</h1>
          <Keypad
            label={t('sampleKgTitle')}
            placeholder="198.5"
            value={draft.sampleKg}
            onChange={(value) => {
              update({ sampleKg: value });
            }}
            maxLength={9}
            decimal
          />
          <div className="actions">
            {backButton}
            <button
              type="button"
              className="btn btn--primary"
              disabled={draft.sampleKg === ''}
              onClick={next}
            >
              {t('next')}
            </button>
          </div>
        </main>
      );
    }

    case 'photos':
      return (
        <PhotosStep
          header={header}
          backButton={backButton}
          photos={draft.photos}
          max={intake.photos.max_per_deposit}
          maxBytes={intake.photos.max_bytes}
          onChange={(photos) => {
            update({ photos });
          }}
          onNext={() => {
            go('review');
          }}
        />
      );

    case 'review': {
      const rows: [string, string, Step][] = [
        [t('farmer'), farmerName, 'phone'],
        [
          t('phone'),
          formatLocalPhone(normaliseNigerianMobile(draft.phone) ?? draft.phone),
          'phone',
        ],
        [t('commodity'), draft.commodity === null ? '' : t(draft.commodity), 'commodity'],
        [t('gradeTitle'), draft.grade ?? '', 'grade'],
        [t('moisture'), `${draft.moisture}%`, 'moisture'],
        [t('bags'), draft.bags, 'bags'],
        [t('verifier'), verifier?.full_name ?? '', 'verifier'],
        [
          t('scaleSample'),
          draft.sample === 'yes'
            ? t('sampleSummary', { bags: draft.sampleBags, kg: draft.sampleKg })
            : t('none'),
          'sample',
        ],
        [t('photos'), String(draft.photos.length), 'photos'],
      ];
      const complete =
        farmerName !== '' &&
        draft.commodity !== null &&
        draft.grade !== null &&
        moisture !== null &&
        bags !== null &&
        verifier !== undefined &&
        draft.photos.length > 0;
      return (
        <main className="screen">
          {header}
          <h1>{t('reviewTitle')}</h1>
          <dl className="review">
            {rows.map(([label, value, target]) => (
              <div className="review__row" key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    edit(target);
                  }}
                  disabled={busy}
                >
                  {t('edit')}
                </button>
              </div>
            ))}
          </dl>
          <div className="actions">
            <button
              type="button"
              className="btn btn--danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(t('discardConfirm'))) onCancel();
              }}
            >
              {t('discard')}
            </button>
            <button
              type="button"
              className="btn btn--primary btn--huge"
              disabled={!complete || busy}
              onClick={() => void save()}
            >
              {busy ? t('saving') : t('confirm')}
            </button>
          </div>
        </main>
      );
    }
  }
}

function PhotosStep({
  header,
  backButton,
  photos,
  max,
  maxBytes,
  onChange,
  onNext,
}: {
  header: React.ReactNode;
  backButton: React.ReactNode;
  photos: PreparedPhoto[];
  max: number;
  maxBytes: number;
  onChange: (photos: PreparedPhoto[]) => void;
  onNext: () => void;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(photos);
  useEffect(() => {
    latest.current = photos;
  }, [photos]);

  const add = async (file: File | undefined) => {
    if (file === undefined) return;
    setProcessing(true);
    setError(null);
    try {
      const photo = await preparePhoto(file, maxBytes);
      onChange([...latest.current, photo]);
    } catch {
      setError(t('photoFailed'));
    } finally {
      setProcessing(false);
      if (input.current !== null) input.current.value = '';
    }
  };

  return (
    <main className="screen">
      {header}
      <h1>{t('photosTitle')}</h1>
      <p className="hint">{t('photosHint', { max })}</p>
      {error !== null && (
        <p className="message" data-tone="bad" role="alert">
          {error}
        </p>
      )}
      <div className="photos">
        {photos.map((photo, index) => (
          <figure className="photo" key={photo.photoId} style={{ margin: 0 }}>
            <img src={photo.previewUrl} alt={`${t('photos')} ${index + 1}`} />
            <button
              type="button"
              className="btn"
              onClick={() => {
                URL.revokeObjectURL(photo.previewUrl);
                onChange(photos.filter((p) => p.photoId !== photo.photoId));
              }}
            >
              {t('removePhoto')}
            </button>
          </figure>
        ))}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        data-testid="photo-input"
        onChange={(event) => void add(event.target.files?.[0])}
      />
      {photos.length < max && (
        <button
          type="button"
          className="btn btn--huge"
          disabled={processing}
          onClick={() => input.current?.click()}
        >
          {processing ? t('processingPhoto') : `📷 ${t('takePhoto')}`}
        </button>
      )}
      <div className="actions">
        {backButton}
        <button
          type="button"
          className="btn btn--primary"
          disabled={photos.length === 0 || processing}
          onClick={onNext}
        >
          {t('next')}
        </button>
      </div>
    </main>
  );
}
