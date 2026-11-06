import { useI18n } from '../../i18n';
import type { Connection } from '../../lib/connectivity';
import type { QueueSummary } from '../services';

interface StatusBarProps {
  connection: Connection;
  syncing: boolean;
  summary: QueueSummary;
  onOpenQueue?: (() => void) | undefined;
}

/**
 * Always on screen: online or offline, and what is waiting. Red when
 * something failed, amber when waiting or offline, green when all is sent.
 */
export function StatusBar({ connection, syncing, summary, onOpenQueue }: StatusBarProps) {
  const { t } = useI18n();
  const parts = [connection === 'online' ? t('online') : t('offline')];
  if (syncing) parts.push(t('syncing'));
  if (summary.failed > 0) parts.push(t('failedCount', { n: summary.failed }));
  if (summary.needsSignIn > 0) parts.push(t('needsSignInCount', { n: summary.needsSignIn }));
  if (summary.waiting > 0) parts.push(t('pendingCount', { n: summary.waiting }));
  if (!syncing && summary.failed + summary.needsSignIn + summary.waiting === 0) {
    parts.push(t('allSent'));
  }

  const tone =
    summary.failed > 0
      ? 'bad'
      : connection === 'offline' || summary.waiting + summary.needsSignIn > 0
        ? 'warn'
        : 'ok';
  return (
    <div className="status" data-tone={tone} role="status" aria-live="polite" data-testid="status">
      <span className="status__dot" data-pulse={syncing} aria-hidden="true" />
      <span>{parts.join(' · ')}</span>
      {onOpenQueue !== undefined && summary.failed + summary.waiting + summary.needsSignIn > 0 && (
        <button type="button" className="status__action" onClick={onOpenQueue}>
          {t('queue')}
        </button>
      )}
    </div>
  );
}
