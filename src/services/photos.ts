import { createHash } from 'node:crypto';

import type pg from 'pg';

import { withTransaction } from '../db/transaction.js';
import {
  MAX_PHOTOS_PER_DEPOSIT,
  PHOTO_EXTENSIONS,
  PHOTO_TYPES,
  isPhotoType,
  sniffPhotoType,
} from '../domain/photo.js';
import {
  ConflictError,
  NotFoundError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../http/errors.js';
import type { PhotoStore } from '../storage/photoStore.js';
import { checkReferences } from './references.js';

export interface PhotoUpload {
  readonly depositId: string;
  readonly uploadedBy: string;
  /** Media type from the Content-Type header, parameters stripped. */
  readonly contentType: string;
  readonly data: Buffer;
}

export interface PhotoView {
  id: string;
  deposit_id: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  uploaded_by: string;
  created_at: Date;
}

export interface PhotoUploadOutcome {
  /** False when this exact image was already attached (a retried upload). */
  created: boolean;
  photo: PhotoView;
}

interface PhotoRow extends PhotoView {
  storage_key: string;
}

const PHOTO_COLUMNS =
  'id, deposit_id, storage_key, content_type, size_bytes, sha256, uploaded_by, created_at';

export class PhotoService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly store: PhotoStore,
  ) {}

  /**
   * Attaches a photo to a deposit (at most three). Photos are keyed by
   * content hash, so re-sending the same image after a dropped connection
   * returns the existing photo instead of using up a slot.
   */
  async upload(upload: PhotoUpload): Promise<PhotoUploadOutcome> {
    const { contentType, data } = upload;
    if (!isPhotoType(contentType)) {
      throw new UnsupportedMediaTypeError(`Photos must be one of ${PHOTO_TYPES.join(', ')}`);
    }
    if (data.length === 0) {
      throw new ValidationError('Request is invalid', {
        details: [{ code: 'required', field: '(body)', message: 'The photo is empty' }],
      });
    }
    const sniffed = sniffPhotoType(data);
    if (sniffed !== contentType) {
      throw new UnsupportedMediaTypeError(
        `The file is not a valid ${contentType} image${sniffed === null ? '' : ` (it looks like ${sniffed})`}`,
      );
    }
    const depositId = upload.depositId.toLowerCase();
    const sha256 = createHash('sha256').update(data).digest('hex');

    return withTransaction(this.pool, async (client) => {
      const deposit = await client.query<{ warehouse_id: string }>(
        'SELECT warehouse_id FROM deposits WHERE deposit_id = $1 FOR UPDATE',
        [depositId],
      );
      const found = deposit.rows[0];
      if (found === undefined) throw new NotFoundError('Deposit not found');

      const referenceErrors = await checkReferences(client, {
        warehouse: { id: found.warehouse_id, field: 'warehouse_id', mustBeActive: false },
        custodian: { id: upload.uploadedBy, field: 'uploaded_by' },
      });
      if (referenceErrors.length > 0) {
        throw new ValidationError('Photo upload is invalid', { details: referenceErrors });
      }

      const existing = await client.query<PhotoRow>(
        `SELECT ${PHOTO_COLUMNS} FROM deposit_photos WHERE deposit_id = $1 ORDER BY created_at`,
        [depositId],
      );
      const same = existing.rows.find((row) => row.sha256 === sha256);
      if (same !== undefined) return { created: false, photo: toView(same) };
      if (existing.rows.length >= MAX_PHOTOS_PER_DEPOSIT) {
        throw new ConflictError(`A deposit can have at most ${MAX_PHOTOS_PER_DEPOSIT} photos`, {
          code: 'photo_limit_reached',
        });
      }

      // Content-addressed, so identical images share one file.
      const key = `${sha256.slice(0, 2)}/${sha256}.${PHOTO_EXTENSIONS[contentType]}`;
      const { rows } = await client.query<PhotoRow>(
        `INSERT INTO deposit_photos
           (deposit_id, storage_key, content_type, size_bytes, sha256, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${PHOTO_COLUMNS}`,
        [depositId, key, contentType, data.length, sha256, upload.uploadedBy],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('photo insert returned no row');
      // Written before commit: if the write fails the row is rolled back. If
      // the commit fails after it, the orphan file is harmless and reused on retry.
      await this.store.put(key, data);
      return { created: true, photo: toView(row) };
    });
  }

  async list(depositId: string): Promise<PhotoView[]> {
    await this.assertDepositExists(depositId);
    const { rows } = await this.pool.query<PhotoRow>(
      `SELECT ${PHOTO_COLUMNS} FROM deposit_photos WHERE deposit_id = $1 ORDER BY created_at, id`,
      [depositId.toLowerCase()],
    );
    return rows.map(toView);
  }

  async read(depositId: string, photoId: string): Promise<{ photo: PhotoView; data: Buffer }> {
    const { rows } = await this.pool.query<PhotoRow>(
      `SELECT ${PHOTO_COLUMNS} FROM deposit_photos WHERE deposit_id = $1 AND id = $2`,
      [depositId.toLowerCase(), photoId],
    );
    const row = rows[0];
    if (row === undefined) throw new NotFoundError('Photo not found');
    const data = await this.store.get(row.storage_key);
    if (data === null) throw new Error(`photo ${row.id} is missing from storage`);
    return { photo: toView(row), data };
  }

  private async assertDepositExists(depositId: string): Promise<void> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM deposits WHERE deposit_id = $1', [
      depositId.toLowerCase(),
    ]);
    if (rowCount === 0) throw new NotFoundError('Deposit not found');
  }
}

function toView(row: PhotoRow): PhotoView {
  return {
    id: row.id,
    deposit_id: row.deposit_id,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    uploaded_by: row.uploaded_by,
    created_at: row.created_at,
  };
}
