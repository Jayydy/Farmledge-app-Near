import { HttpError, type ApiClient } from '../api/client';
import {
  getMeta,
  type AppDb,
  type CountedLine,
  type OpenAudit,
  type StoredSession,
} from '../db/schema';
import { isoWithOffset } from '../lib/numbers';
import type {
  AuditLineRequest,
  AuditLineView,
  AuditReport,
  AuditStartRequest,
  AuditView,
} from '../types/api';

/**
 * A stock count (D9, D57), online only. The custodian enters the figures;
 * the record names who physically counted and who watched, and the watcher
 * is never a custodian here. Counting is blind: the recorded figure for a
 * commodity and grade is shown only once its count is saved.
 *
 * The open count is kept in the tablet's meta store, so the idle lock or a
 * reload in the middle of the store never strands it open on the server.
 */

/** Counted bags: a whole number, 0 allowed (counted and found none), at most the API's cap. */
export function parseCountedBags(text: string): number | null {
  return /^\d{1,7}$/.test(text) && Number(text) <= 1_000_000 ? Number(text) : null;
}

/** Typed names compared as the API does: case and spacing don't count. */
export function samePersonName(a: string, b: string): boolean {
  const norm = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
}

/** The open count at the session's warehouse, if this tablet has one. */
export async function openCount(db: AppDb, session: StoredSession): Promise<OpenAudit | null> {
  const open = await getMeta(db, 'openAudit');
  return open !== undefined && open.audit.warehouse_id === session.warehouse.id ? open : null;
}

export async function startCount(
  db: AppDb,
  api: ApiClient,
  session: StoredSession,
  people: { countedBy: string; witnessedBy: string },
  now: Date = new Date(),
): Promise<OpenAudit> {
  const body: AuditStartRequest = {
    warehouse_id: session.warehouse.id,
    entered_by: session.custodian.id,
    counted_by: people.countedBy.trim(),
    witnessed_by: people.witnessedBy.trim(),
    started_at: isoWithOffset(now),
  };
  const { data } = await api<{ audit: AuditView }>('POST', '/audits', {
    token: session.token,
    json: body,
  });
  const open: OpenAudit = { audit: data.audit, lines: [] };
  await db.put('meta', open, 'openAudit');
  return open;
}

function fromLine(line: AuditLineView): CountedLine {
  return {
    commodity: line.commodity,
    grade: line.grade,
    recorded_bags: line.recorded_bags,
    recorded_kg: line.recorded_kg,
    counted_bags: line.counted_bags,
    counted_kg: line.counted_kg,
    difference_bags: line.variance_bags,
    difference_kg: line.variance_kg,
  };
}

/**
 * Saves one line and returns the count with it. If the server already has
 * this commodity and grade (a retry whose first answer was lost), the lines
 * are taken from its report instead, so the tablet never loses one.
 */
export async function countLine(
  db: AppDb,
  api: ApiClient,
  session: StoredSession,
  open: OpenAudit,
  line: AuditLineRequest,
): Promise<{ open: OpenAudit; saved: CountedLine; repeated: boolean }> {
  const path = `/audits/${open.audit.id}`;
  let next: OpenAudit;
  let saved: CountedLine | undefined;
  let repeated = false;
  try {
    const { data } = await api<{ line: AuditLineView }>('POST', `${path}/lines`, {
      token: session.token,
      json: line,
    });
    saved = fromLine(data.line);
    next = { ...open, lines: [...open.lines, saved] };
  } catch (err) {
    if (!(err instanceof HttpError) || err.code !== 'audit_line_exists') throw err;
    const report = await fetchReport(api, session, open.audit.id);
    next = { audit: report.audit, lines: report.lines.map(fromReportLine) };
    saved = next.lines.find((l) => l.commodity === line.commodity && l.grade === line.grade);
    repeated = true;
    if (saved === undefined) throw err;
  }
  await db.put('meta', next, 'openAudit');
  return { open: next, saved, repeated };
}

function fromReportLine(line: AuditReport['lines'][number]): CountedLine {
  return {
    commodity: line.commodity,
    grade: line.grade,
    recorded_bags: line.recorded_bags,
    recorded_kg: line.recorded_kg,
    counted_bags: line.counted_bags,
    counted_kg: line.counted_kg,
    difference_bags: line.difference_bags,
    difference_kg: line.difference_kg,
  };
}

async function fetchReport(
  api: ApiClient,
  session: StoredSession,
  auditId: string,
): Promise<AuditReport> {
  const { data } = await api<AuditReport>('GET', `/audits/${auditId}/report`, {
    token: session.token,
  });
  return data;
}

/**
 * Closes the count to further lines and returns its report. Already closed
 * (a lost answer, or another tablet) is fine: the report is what matters.
 * Only then is the tablet's copy dropped.
 */
export async function finishCount(
  db: AppDb,
  api: ApiClient,
  session: StoredSession,
  open: OpenAudit,
): Promise<AuditReport> {
  try {
    await api('POST', `/audits/${open.audit.id}/complete`, { token: session.token });
  } catch (err) {
    if (!(err instanceof HttpError) || err.code !== 'audit_completed') throw err;
  }
  const report = await fetchReport(api, session, open.audit.id);
  await db.delete('meta', 'openAudit');
  return report;
}

/**
 * The tablet's copy of a count the server no longer knows (404: another
 * warehouse's session, or a reset test database) is dropped, so it doesn't
 * sit on Home forever.
 */
export async function forgetCount(db: AppDb): Promise<void> {
  await db.delete('meta', 'openAudit');
}
