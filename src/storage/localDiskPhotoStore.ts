import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assertSafeKey, type PhotoStore } from './photoStore.js';

/**
 * Stores photos as files under `root`. Writes go to a temporary file first
 * and are renamed into place, so a crash never leaves a half-written photo.
 */
export class LocalDiskPhotoStore implements PhotoStore {
  constructor(private readonly root: string) {}

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.pathFor(key);
    if (await exists(target)) return;
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, data, { flag: 'wx' });
    await rename(temporary, target);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return null;
      throw err;
    }
  }

  private pathFor(key: string): string {
    assertSafeKey(key);
    return path.join(this.root, key);
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return false;
    throw err;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
