import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

import { useI18n } from '../i18n';
import { formatLocalPhone } from '../lib/phone';
import { slipQrPayload, type SlipData } from './slipData';

/**
 * What a QR code on the slip carries.
 *
 * - Before the API has the deposit: a capture receipt, `farmledge:capture:<deposit_id>`.
 *   It identifies the record; it proves nothing, and the slip says so.
 * - After: the slip's `qr_payload` from GET /deposits/:id/slip, unchanged: the
 *   leaf's data and salt, as farmledge-protocol docs/backend-requirements.md §4
 *   requires for the counter slip. Its encoding is PROVISIONAL (API D45) until
 *   farmledge-protocol#5 specifies it; the app passes it through untouched, so
 *   only the API changes when it does.
 * - UNTESTED on a real thermal printer: see README "Before field use".
 */
export function useQrSvg(payload: string): string | null {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 })
      .then((markup) => {
        if (live) setSvg(markup);
      })
      .catch(() => {
        if (live) setSvg(null);
      });
    return () => {
      live = false;
    };
  }, [payload]);
  return svg;
}

/** The printed slip: one column, readable at 58 mm. Hidden on screen. */
export function Slip({ slip }: { slip: SlipData }) {
  const { t } = useI18n();
  const proof = slip.proofPayload !== null;
  const svg = useQrSvg(slipQrPayload(slip));
  const rows: [string, string][] = [
    [t('warehouse'), `${slip.warehouse.name} (${slip.warehouse.code})`],
    [t('capturedAt'), new Date(slip.capturedAt).toLocaleString()],
    [t('farmer'), slip.farmer.full_name],
    [t('phone'), formatLocalPhone(slip.farmer.phone)],
    [t('commodity'), t(slip.commodity)],
    [t('gradeTitle'), slip.grade],
    [t('moisture'), `${slip.moisturePct}%`],
    [t('bags'), String(slip.bags)],
    [t('custodian'), slip.custodian],
    [t('verifier'), slip.verifier],
  ];
  return (
    <section className="slip" aria-hidden="true" data-testid="slip">
      <h2>{proof ? t('slipProofTitle') : t('slipCaptureTitle')}</h2>
      {slip.reprint !== null && (
        <p className="slip__note" data-testid="reprint-stamp">
          {t('reprintStamp', {
            time: slip.reprint.at.toLocaleString(),
            name: slip.reprint.by,
          })}
        </p>
      )}
      <div className="slip__ref">
        {slip.depositNo === null
          ? slip.reference
          : `${slip.warehouse.code} · ${t('depositNumber', { n: slip.depositNo })}`}
      </div>
      {!proof && <p className="slip__note">{t('slipCaptureNote')}</p>}
      <dl>
        {rows.map(([label, value]) => (
          <div className="slip__row" key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <div className="slip__row">
          <dt>{t('reference')}</dt>
          <dd>{slip.reference}</dd>
        </div>
      </dl>
      {svg !== null && (
        // Generated locally by the qrcode library from our own payload.
        <div className="slip__qr" dangerouslySetInnerHTML={{ __html: svg }} />
      )}
      {proof && <p>{t('slipProofNote')}</p>}
    </section>
  );
}
