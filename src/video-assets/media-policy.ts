import type { KinoMediaType } from './kino-api';
import { KinoApiError } from './kino-api';

export const VIDEO_UPLOAD_MIME = 'video/mp4' as const;
export const IMAGE_UPLOAD_MIMES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;
export const AUDIO_UPLOAD_MIMES = [
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/mp4',
  'audio/aac',
] as const;
export const FONT_UPLOAD_MIMES = [
  'font/woff2',
  'font/woff',
  'font/ttf',
  'font/otf',
] as const;

export type ImageUploadMime = (typeof IMAGE_UPLOAD_MIMES)[number];
export type AudioUploadMime = (typeof AUDIO_UPLOAD_MIMES)[number];
export type FontUploadMime = (typeof FONT_UPLOAD_MIMES)[number];
export type SupportedUploadMime = typeof VIDEO_UPLOAD_MIME | ImageUploadMime | AudioUploadMime | FontUploadMime;

export const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_AUDIO_UPLOAD_BYTES = MAX_VIDEO_UPLOAD_BYTES;
export const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_FONT_UPLOAD_BYTES = 20 * 1024 * 1024;

const IMAGE_MIME_SET = new Set<string>(IMAGE_UPLOAD_MIMES);
const AUDIO_MIME_SET = new Set<string>(AUDIO_UPLOAD_MIMES);
const FONT_MIME_SET = new Set<string>(FONT_UPLOAD_MIMES);
const EXTENSION_BY_MIME: Record<SupportedUploadMime, string> = {
  [VIDEO_UPLOAD_MIME]: 'mp4',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
};

export function mediaTypeForMime(mimeType: unknown): KinoMediaType | null {
  if (mimeType === VIDEO_UPLOAD_MIME) return 'video';
  if (typeof mimeType !== 'string') return null;
  if (IMAGE_MIME_SET.has(mimeType)) return 'image';
  if (AUDIO_MIME_SET.has(mimeType)) return 'audio';
  return FONT_MIME_SET.has(mimeType) ? 'font' : null;
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
  if (mediaType === 'image') return MAX_IMAGE_UPLOAD_BYTES;
  if (mediaType === 'font') return MAX_FONT_UPLOAD_BYTES;
  return MAX_VIDEO_UPLOAD_BYTES;
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
