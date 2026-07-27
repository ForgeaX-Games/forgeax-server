import { describe, expect, test } from 'bun:test';
import {
  assertUploadFileName,
  assertUploadMime,
  assertUploadSize,
  extensionForMime,
  MAX_AUDIO_UPLOAD_BYTES,
  mediaTypeForMime,
} from '../../src/video-assets/media-policy';

const AUDIO_MIMES = [
  ['audio/mpeg', 'mp3'],
  ['audio/wav', 'wav'],
  ['audio/ogg', 'ogg'],
  ['audio/mp4', 'm4a'],
  ['audio/aac', 'aac'],
] as const;

describe('audio upload media policy', () => {
  test.each(AUDIO_MIMES)('accepts %s with .%s', (mimeType, extension) => {
    expect(mediaTypeForMime(mimeType)).toBe('audio');
    expect(extensionForMime(mimeType)).toBe(extension);
    expect(() => assertUploadMime('audio', mimeType)).not.toThrow();
    expect(() => assertUploadFileName(`bgm.${extension}`, mimeType)).not.toThrow();
    expect(() => assertUploadSize('audio', MAX_AUDIO_UPLOAD_BYTES)).not.toThrow();
  });

  test('rejects audio uploads above the 100MB limit', () => {
    expect(() => assertUploadSize('audio', MAX_AUDIO_UPLOAD_BYTES + 1)).toThrow(
      'Invalid upload size',
    );
  });
});
