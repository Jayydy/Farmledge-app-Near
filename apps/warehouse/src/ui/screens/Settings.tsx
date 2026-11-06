import { useEffect, useState } from 'react';

import { getMeta } from '../../db/schema';
import { deregisterDevice } from '../../farmers/cache';
import { HAUSA_REVIEWED } from '../../i18n/ha';
import { useI18n } from '../../i18n';
import { useApp, summarise } from '../services';

export function Settings({ onDeregistered }: { onDeregistered: () => void }) {
  const app = useApp();
  const { t, language, setLanguage } = useI18n();
  const [waiting, setWaiting] = useState<number | null>(null);
  const [blocked, setBlocked] = useState(0);
  useEffect(() => {
    let live = true;
    void getMeta(app.db, 'blockedDispatchCount').then((count) => {
      if (live) setBlocked(count ?? 0);
    });
    return () => {
      live = false;
    };
  }, [app.db, app.revision]);

  const startDeregister = async () => {
    const summary = summarise(await app.db.getAll('outbox'));
    setWaiting(summary.waiting + summary.failed + summary.needsSignIn);
  };
  const deregister = async () => {
    await deregisterDevice(app.db);
    onDeregistered();
  };

  return (
    <main className="screen">
      <h1>{t('settingsTitle')}</h1>
      <h2>{t('language')}</h2>
      <div className="choices">
        <button
          type="button"
          className="btn"
          aria-pressed={language === 'ha'}
          onClick={() => {
            setLanguage('ha');
          }}
        >
          {t('hausa')}
        </button>
        <button
          type="button"
          className="btn"
          aria-pressed={language === 'en'}
          onClick={() => {
            setLanguage('en');
          }}
        >
          {t('english')}
        </button>
      </div>
      {!HAUSA_REVIEWED && (
        <p className="message" data-tone="warn">
          {t('translationDraft')}
        </p>
      )}
      <h2>{t('dispatch')}</h2>
      <p className="hint" data-testid="blocked-count">
        {t('blockedOnThisTablet', { n: blocked })}
      </p>

      <h2>{t('deregister')}</h2>
      <p className="hint">{t('deregisterText')}</p>
      {waiting === null ? (
        <button type="button" className="btn btn--danger" onClick={() => void startDeregister()}>
          {t('deregister')}
        </button>
      ) : (
        <>
          {waiting > 0 && (
            <p className="message" data-tone="warn">
              {t('deregisterPending', { n: waiting })}
            </p>
          )}
          <p className="message" data-tone="bad">
            {t('deregisterConfirm')}
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setWaiting(null);
              }}
            >
              {t('cancel')}
            </button>
            <button type="button" className="btn btn--danger" onClick={() => void deregister()}>
              {t('deregister')}
            </button>
          </div>
        </>
      )}
      <p className="hint">{t('version', { v: __APP_VERSION__ })}</p>
    </main>
  );
}
