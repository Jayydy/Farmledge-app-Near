/** Longest side after resizing: plenty to see bags and labels, ~200–500 kB as JPEG. */
const MAX_DIMENSION = 1600;
const QUALITIES = [0.82, 0.7, 0.55, 0.4];

export interface PreparedPhoto {
  photoId: string;
  blob: Blob;
  contentType: 'image/jpeg';
  /** Hex SHA-256 of the bytes: the API recognises a re-upload by it. */
  sha256: string;
  previewUrl: string;
}

/**
 * Turns a camera photo into a JPEG under `maxBytes`, resized so its longest
 * side is at most 1600 px. Done once, before the photo is queued, so the
 * bytes (and their hash) never change between retries.
 */
export async function preparePhoto(file: Blob, maxBytes: number): Promise<PreparedPhoto> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no 2D canvas');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  for (const quality of QUALITIES) {
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', quality);
    });
    if (blob !== null && blob.size <= maxBytes) {
      return {
        photoId: crypto.randomUUID(),
        blob,
        contentType: 'image/jpeg',
        sha256: await sha256Hex(blob),
        previewUrl: URL.createObjectURL(blob),
      };
    }
  }
  throw new Error('photo too large even at the lowest quality');
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
