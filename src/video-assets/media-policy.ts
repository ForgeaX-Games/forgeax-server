import type { KinoMediaType } from './kino-api';
import { KinoApiError } from './kino-api';

export const VIDEO_UPLOAD_MIME = 'video/mp4' as const;
export const IMAGE_UPLOAD_MIMES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type ImageUploadMime = (typeof IMAGE_UPLOAD_MIMES)[number];
export type SupportedUploadMime = typeof VIDEO_UPLOAD_MIME | ImageUploadMime;

export const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;

const IMAGE_MIME_SET = new Set<string>(IMAGE_UPLOAD_MIMES);
const EXTENSION_BY_MIME: Record<SupportedUploadMime, string> = {
  [VIDEO_UPLOAD_MIME]: 'mp4',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function mediaTypeForMime(mimeType: unknown): KinoMediaType | null {
  if (mimeType === VIDEO_UPLOAD_MIME) return 'video';
  return typeof mimeType === 'string' && IMAGE_MIME_SET.has(mimeType) ? 'image' : null;
}

export function assertUploadMime(
  mediaType: KinoMediaType,
  mimeType: unknown,
): asserts mimeType is SupportedUploadMime {
  if (mediaTypeForMime(mimeType) !== mediaType) {
    throw new KinoApiError('Invalid upload mime type', 400, 'invalid_media_type');
  }
}

export function maxUploadBytes(mediaType: KinoMediaType): number {
  return mediaType === 'image' ? MAX_IMAGE_UPLOAD_BYTES : MAX_VIDEO_UPLOAD_BYTES;
}

export function assertUploadSize(mediaType: KinoMediaType, bytes: unknown): asserts bytes is number {
  if (
    typeof bytes !== 'number' ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    bytes > maxUploadBytes(mediaType)
  ) {
    throw new KinoApiError('Invalid upload size', 400, 'invalid_upload_size');
  }
}

export function extensionForMime(mimeType: SupportedUploadMime): string {
  return EXTENSION_BY_MIME[mimeType];
}

export function assertUploadFileName(fileName: string, mimeType: SupportedUploadMime): void {
  const normalized = fileName.trim().toLowerCase();
  if (!normalized || !normalized.endsWith(`.${extensionForMime(mimeType)}`)) {
    if (mimeType === 'image/jpeg' && normalized.endsWith('.jpeg')) return;
    throw new KinoApiError('Invalid upload file name', 400, 'invalid_file_name');
  }
}
