import { useI18n } from '../i18n';
import { formatKg } from '../lib/numbers';
import { formatLocalPhone } from '../lib/phone';
import type { DeliveryNote } from '../types/api';

/**
 * The printed delivery note, from GET /dispatches/:id/delivery-note only:
 * it is never printed before the server has recorded the dispatch. Hidden
 * on screen. UNTESTED on a real thermal printer: see README "Before field use".
 */
export function DeliveryNoteSlip({ note }: { note: DeliveryNote }) {
  const { t } = useI18n();
  const { goods } = note;
  const rows: [string, string][] = [
    [t('warehouse'), `${note.warehouse.name} (${note.warehouse.code})`],
    [t('dispatchedAt'), new Date(note.issued_at).toLocaleString()],
    [t('farmer'), note.farmer.full_name],
    [t('phone'), formatLocalPhone(note.farmer.phone)],
    [t('commodity'), t(goods.commodity)],
    [t('gradeTitle'), goods.grade],
    [t('bagsOut'), String(goods.bags)],
    [t('bookKg'), formatKg(goods.book_kg)],
    [
      t('weightReleased'),
      goods.exit_weight_kg === null
        ? t('notWeighedWithReason', { reason: goods.not_weighed_reason ?? '' })
        : formatKg(goods.exit_weight_kg),
    ],
    [
      t('lotsDrawn'),
      note.lots_drawn.map((lot) => t('lotBags', { n: lot.deposit_no, bags: lot.bags })).join(', '),
    ],
    [
      t('freeAfter'),
      t('bagsKg', { bags: note.balance_after.free_bags, kg: formatKg(note.balance_after.free_kg) }),
    ],
    [t('custodian'), note.custodian.full_name],
  ];
  if (note.balance_after.held_on_chain_bags > 0) {
    rows.push([
      t('heldOnChain'),
      t('bagsKg', {
        bags: note.balance_after.held_on_chain_bags,
        kg: formatKg(note.balance_after.held_on_chain_kg),
      }),
    ]);
  }
  return (
    <section className="slip" aria-hidden="true" data-testid="delivery-note">
      <h2>{t('deliveryNoteTitle')}</h2>
      {note.environment !== 'live' && <p className="slip__note">{t('testDocument')}</p>}
      <div className="slip__ref">{note.delivery_note_no}</div>
      <dl>
        {rows.map(([label, value]) => (
          <div className="slip__row" key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p>{t('farmerConfirmedOnTablet')}</p>
    </section>
  );
}
