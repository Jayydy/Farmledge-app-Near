/** Also enforced by a database trigger on `deposit_photos`. */
export const MAX_PHOTOS_PER_DEPOSIT = 3;

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];

export const PHOTO_EXTENSIONS: Readonly<Record<PhotoType, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function isPhotoType(value: string): value is PhotoType {
  return (PHOTO_TYPES as readonly string[]).includes(value);
}

/**
 * Identifies an image from its first bytes, so a mislabelled or non-image
 * upload is refused whatever its Content-Type header says.
 */
export function sniffPhotoType(data: Uint8Array): PhotoType | null {
  const starts = (bytes: readonly number[], offset = 0) =>
    data.length >= offset + bytes.length && bytes.every((b, i) => data[offset + i] === b);

  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // "RIFF" <size> "WEBP"
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}
