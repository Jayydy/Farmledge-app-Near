import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { IDLE_LOCK_MS, refreshFeatures, releaseEndedSessions, signOut } from '../auth/sessions';
import { getMeta, setMeta, type StoredSession } from '../db/schema';
import { recordBlockedDispatch } from '../dispatch/blocked';
import { resolveAllPending } from '../dispatch/pending';
import { purgeExpiredBalances } from '../farmers/balances';
import { purgeExpiredFarmers, refreshDirectory } from '../farmers/cache';
import { I18nProvider, translator, type Language } from '../i18n';
import { DEFAULT_FEATURES } from '../lib/defaultFeatures';
import type { Connection } from '../lib/connectivity';
import type { Features } from '../types/api';
import { StatusBar } from './components/StatusBar';
import { Balance } from './screens/Balance';
import {
  Dispatch,
  DispatchBlocked,
  newDispatchDraft,
  PendingDispatchView,
  type DispatchDraft,
} from './screens/Dispatch';
import { Home } from './screens/Home';
import { Intake, newDraft, type Draft } from './screens/Intake';
import { Queue } from './screens/Queue';
import { Reprint } from './screens/Reprint';
import { Settings } from './screens/Settings';
import { StockCount } from './screens/StockCount';
import { DailySummary } from './screens/Summary';
import { LockScreen, SignIn } from './screens/SignIn';
import { Success } from './screens/Success';
import { AppContext, summarise, type AppState, type QueueSummary, type Services } from './services';

/** How often the queue is sent while online, besides every change and reconnect. */
const SYNC_INTERVAL_MS = 30_000;

type View =
  | { name: 'home' }
  | { name: 'intake' }
  | { name: 'success'; depositId: string }
  | { name: 'dispatch' }
  | { name: 'dispatchBlocked'; count: number }
  | { name: 'pendingDispatch'; dispatchId: string }
  | { name: 'balance' }
  | { name: 'queue' }
  | { name: 'reprint' }
  | { name: 'summary' }
  | { name: 'stockCount' }
  | { name: 'settings' };

export interface UpdateHandle {
  ready: boolean;
  apply: () => void;
}

export function App({
  services,
  update,
}: {
  services: Services & { changes: EventTarget };
  update: UpdateHandle;
}) {
  const { db, api, engine, connectivity } = services;
  const [booted, setBooted] = useState(false);
  const [language, setLanguageState] = useState<Language>('en');
  const [features, setFeatures] = useState<Features>(DEFAULT_FEATURES);
  const [session, setSession] = useState<StoredSession | null>(null);
  const [locked, setLocked] = useState<StoredSession | null>(null);
  const [connection, setConnection] = useState<Connection>(connectivity.current);
  const [syncing, setSyncing] = useState(false);
  const [revision, setRevision] = useState(0);
  const [summary, setSummary] = useState<QueueSummary>({ waiting: 0, failed: 0, needsSignIn: 0 });
  const [view, setView] = useState<View>({ name: 'home' });
  const [draft, setDraftState] = useState<Draft | null>(null);
  const [dispatchDraft, setDispatchDraftState] = useState<DispatchDraft | null>(null);
  const syncing$ = useRef(false);
  const sessionRef = useRef<StoredSession | null>(null);
  sessionRef.current = session;

  const t = useMemo(() => translator(language), [language]);
  const setLanguage = useCallback(
    (next: Language) => {
      setLanguageState(next);
      document.documentElement.lang = next;
      void setMeta(db, 'language', next);
    },
    [db],
  );

  // ---- Boot: language, cached rules, and a locked screen for the last sign-in.
  useEffect(() => {
    void (async () => {
      const [savedLanguage, savedFeatures, sessions] = await Promise.all([
        getMeta(db, 'language'),
        getMeta(db, 'features'),
        db.getAll('sessions'),
      ]);
      if (savedLanguage !== undefined) {
        setLanguageState(savedLanguage);
        document.documentElement.lang = savedLanguage;
      }
      if (savedFeatures !== undefined) setFeatures(savedFeatures);
      const now = Date.now();
      const last = sessions
        .filter((s) => !s.ended && !s.invalid && Date.parse(s.session.expires_at) > now)
        .sort((a, b) => b.signedInAt - a.signedInAt)[0];
      // Reopening the app on a shared tablet always asks for the PIN.
      if (last !== undefined) setLocked(last);
      setBooted(true);
    })();
  }, [db]);

  // ---- Changes to the outbox: refresh the status bar and every screen.
  useEffect(() => {
    const bump = () => {
      setRevision((r) => r + 1);
    };
    services.changes.addEventListener('change', bump);
    return () => {
      services.changes.removeEventListener('change', bump);
    };
  }, [services.changes]);

  useEffect(() => {
    let live = true;
    void db.getAll('outbox').then((items) => {
      if (live) setSummary(summarise(items));
    });
    return () => {
      live = false;
    };
  }, [db, revision]);

  // ---- Sync: on reconnect, every 30 s online, after each save, and on demand.
  const syncNow = useCallback(async () => {
    if (syncing$.current) return;
    syncing$.current = true;
    setSyncing(true);
    try {
      const report = await engine.run();
      if (report.unreachable) {
        connectivity.reportUnreachable();
        return;
      }
      // What a blocked dispatch reports as "offline since".
      await setMeta(db, 'lastOnlineAt', Date.now());
      await releaseEndedSessions(db, api);
      const current = sessionRef.current;
      if (current !== null) {
        await refreshDirectory(db, api, current);
        await refreshFeatures(db, api);
        const saved = await getMeta(db, 'features');
        if (saved !== undefined) setFeatures(saved);
      }
      await purgeExpiredFarmers(db);
      await purgeExpiredBalances(db);
      // Dispatches left pending settle in the background, by the same rules as on screen.
      await resolveAllPending(db, api);
    } finally {
      syncing$.current = false;
      setSyncing(false);
      setRevision((r) => r + 1);
    }
  }, [api, connectivity, db, engine]);

  useEffect(() => {
    connectivity.start();
    const unsubscribe = connectivity.subscribe((state) => {
      setConnection(state);
      if (state === 'online') void syncNow();
    });
    return () => {
      unsubscribe();
      connectivity.stop();
    };
  }, [connectivity, syncNow]);

  useEffect(() => {
    if (connection !== 'online') return;
    void syncNow();
    const timer = setInterval(() => void syncNow(), SYNC_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [connection, syncNow]);

  // ---- Idle lock: a shared tablet never stays signed in unattended.
  useEffect(() => {
    if (session === null) return;
    let timer = setTimeout(lockNow, IDLE_LOCK_MS);
    function lockNow() {
      setLocked(sessionRef.current);
      setSession(null);
    }
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(lockNow, IDLE_LOCK_MS);
    };
    const events = ['pointerdown', 'keydown', 'touchstart'] as const;
    for (const event of events) window.addEventListener(event, reset, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, reset);
    };
  }, [session]);

  const setDraft = useCallback((change: (draft: Draft) => Draft) => {
    setDraftState((current) => (current === null ? current : change(current)));
  }, []);
  const setDispatchDraft = useCallback((change: (draft: DispatchDraft) => DispatchDraft) => {
    setDispatchDraftState((current) => (current === null ? current : change(current)));
  }, []);
  /** A dispatch sent but not confirmed must never be dropped, whoever signs in next. */
  const dispatchInFlight = dispatchDraft?.phase === 'pending';

  const signedIn = (next: StoredSession) => {
    // Someone else: whatever the last person started is theirs, not this person's.
    if (locked !== null && locked.custodian.id !== next.custodian.id) {
      setDraftState(null);
      if (dispatchInFlight) {
        setView({ name: 'dispatch' });
      } else {
        setDispatchDraftState(null);
        setView({ name: 'home' });
      }
    }
    setLocked(null);
    setSession(next);
    void getMeta(db, 'features').then((saved) => {
      if (saved !== undefined) setFeatures(saved);
    });
    void syncNow();
  };

  const i18n = { language, t, setLanguage };
  const languageSwitch = (
    <div className="lang" role="group" aria-label={t('language')}>
      <button
        type="button"
        aria-pressed={language === 'ha'}
        onClick={() => {
          setLanguage('ha');
        }}
      >
        HA
      </button>
      <button
        type="button"
        aria-pressed={language === 'en'}
        onClick={() => {
          setLanguage('en');
        }}
      >
        EN
      </button>
    </div>
  );
  const header = (who: StoredSession | null) => (
    <header className="header">
      <span className="header__brand">{t('appName')}</span>
      {languageSwitch}
      {who !== null && (
        <span className="header__who">
          {who.custodian.full_name}
          <small>{who.warehouse.name}</small>
        </span>
      )}
      {session !== null && (
        <button
          type="button"
          className="header__icon"
          onClick={() => {
            setLocked(session);
            setSession(null);
          }}
        >
          🔒 {t('lock')}
        </button>
      )}
    </header>
  );
  const statusBar = (
    <StatusBar
      connection={connection}
      syncing={syncing}
      summary={summary}
      onOpenQueue={
        session !== null && view.name !== 'intake' && view.name !== 'dispatch'
          ? () => {
              setView({ name: 'queue' });
            }
          : undefined
      }
    />
  );

  if (!booted) return null;

  if (session === null) {
    return (
      <I18nProvider value={i18n}>
        <div className="app">
          {header(locked)}
          {statusBar}
          {locked !== null ? (
            <LockScreen
              services={services}
              session={locked}
              hasDraft={draft !== null}
              onUnlocked={signedIn}
              onSwitchUser={() => {
                setDraftState(null);
                if (!dispatchInFlight) {
                  setDispatchDraftState(null);
                  setView({ name: 'home' });
                }
                setLocked(null);
              }}
            />
          ) : (
            <SignIn services={services} online={connection === 'online'} onSignedIn={signedIn} />
          )}
        </div>
      </I18nProvider>
    );
  }

  const state: AppState = {
    ...services,
    connection,
    syncing,
    features,
    session,
    revision,
    syncNow,
  };
  const home = () => {
    setView({ name: 'home' });
  };
  const startIntake = () => {
    setDraftState(newDraft());
    setView({ name: 'intake' });
  };
  // Offline, a dispatch never starts (D54): the attempt is recorded and counted instead.
  const startDispatch = () => {
    if (dispatchInFlight) {
      setView({ name: 'dispatch' });
      return;
    }
    if (connection !== 'online') {
      void recordBlockedDispatch(db, session).then((count) => {
        setView({ name: 'dispatchBlocked', count });
        setRevision((r) => r + 1);
      });
      return;
    }
    setDispatchDraftState(newDispatchDraft());
    setView({ name: 'dispatch' });
  };
  const busyFlow = view.name === 'intake' || view.name === 'dispatch';

  return (
    <I18nProvider value={i18n}>
      <AppContext.Provider value={state}>
        <div className="app">
          {header(session)}
          {statusBar}
          <div className="app__body">
            {update.ready && (
              <div className="banner" role="status">
                {t('updateReady')}
                {busyFlow ? (
                  <span>{t('updateLater')}</span>
                ) : (
                  <button type="button" className="btn btn--primary" onClick={update.apply}>
                    {t('updateNow')}
                  </button>
                )}
              </div>
            )}
            {view.name === 'home' && (
              <>
                <Home
                  onReprint={() => {
                    setView({ name: 'reprint' });
                  }}
                  onNewDeposit={startIntake}
                  onDispatch={startDispatch}
                  onBalance={() => {
                    setView({ name: 'balance' });
                  }}
                  onOpenPending={(dispatchId) => {
                    setView({ name: 'pendingDispatch', dispatchId });
                  }}
                  onOpen={(depositId) => {
                    setView({ name: 'success', depositId });
                  }}
                  onSummary={() => {
                    setView({ name: 'summary' });
                  }}
                  onStockCount={() => {
                    setView({ name: 'stockCount' });
                  }}
                />
                <div className="screen" style={{ paddingTop: 0 }}>
                  <div className="actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setView({ name: 'queue' });
                      }}
                    >
                      {t('queue')}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setView({ name: 'settings' });
                      }}
                    >
                      {t('settings')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--danger"
                      onClick={() => {
                        if (!window.confirm(t('endShiftConfirm'))) return;
                        void signOut(db, api, session.id).then(() => {
                          setDraftState(null);
                          setSession(null);
                          setLocked(null);
                          setRevision((r) => r + 1);
                        });
                      }}
                    >
                      {t('endShift')}
                    </button>
                  </div>
                </div>
              </>
            )}
            {view.name === 'intake' && draft !== null && (
              <Intake
                key={draft.depositId}
                draft={draft}
                setDraft={setDraft}
                onCancel={() => {
                  setDraftState(null);
                  home();
                }}
                onSaved={(depositId) => {
                  setDraftState(null);
                  setView({ name: 'success', depositId });
                  setRevision((r) => r + 1);
                  void syncNow();
                }}
              />
            )}
            {view.name === 'success' && (
              <Success depositId={view.depositId} onNext={startIntake} onHome={home} />
            )}
            {view.name === 'reprint' && <Reprint onHome={home} />}
            {view.name === 'dispatch' && dispatchDraft !== null && (
              <Dispatch
                key={dispatchDraft.dispatchId}
                draft={dispatchDraft}
                setDraft={setDispatchDraft}
                onDone={() => {
                  setDispatchDraftState(null);
                  home();
                }}
                onCancel={() => {
                  setDispatchDraftState(null);
                  home();
                }}
                onLeave={() => {
                  // Still pending, on Home's list, and still resolving after each sync.
                  setDispatchDraftState(null);
                  home();
                }}
                onLock={() => {
                  setLocked(session);
                  setSession(null);
                }}
              />
            )}
            {view.name === 'pendingDispatch' && (
              <PendingDispatchView dispatchId={view.dispatchId} onClose={home} />
            )}
            {view.name === 'dispatchBlocked' && (
              <DispatchBlocked count={view.count} onHome={home} />
            )}
            {view.name === 'balance' && <Balance onHome={home} />}
            {view.name === 'summary' && <DailySummary onHome={home} />}
            {view.name === 'stockCount' && <StockCount onHome={home} />}
            {view.name === 'queue' && (
              <>
                <Queue />
                <div className="screen" style={{ paddingTop: 0 }}>
                  <button type="button" className="btn" onClick={home}>
                    {t('home')}
                  </button>
                </div>
              </>
            )}
            {view.name === 'settings' && (
              <>
                <Settings
                  onDeregistered={() => {
                    setDraftState(null);
                    setSession(null);
                    setLocked(null);
                    setFeatures(DEFAULT_FEATURES);
                    home();
                  }}
                />
                <div className="screen" style={{ paddingTop: 0 }}>
                  <button type="button" className="btn" onClick={home}>
                    {t('home')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </AppContext.Provider>
    </I18nProvider>
  );
}
