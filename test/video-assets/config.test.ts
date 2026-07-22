import { describe, expect, test } from 'bun:test';
import {
  VideoAssetConfigError,
  parseVideoStorageConfig,
} from '../../src/video-assets/config';

describe('parseVideoStorageConfig', () => {
  test('defaults to local when FORGEAX_VIDEO_STORAGE is unset', () => {
    expect(parseVideoStorageConfig({})).toEqual({ kind: 'local' });
  });

  test('defaults to local when FORGEAX_VIDEO_STORAGE is empty', () => {
    expect(parseVideoStorageConfig({ FORGEAX_VIDEO_STORAGE: '   ' })).toEqual({ kind: 'local' });
  });

  test('parses a complete S3 configuration', () => {
    expect(
      parseVideoStorageConfig({
        FORGEAX_VIDEO_STORAGE: 's3',
        FORGEAX_VIDEO_S3_BUCKET: ' forgeax-videos ',
        FORGEAX_VIDEO_S3_REGION: ' ap-east-1 ',
        FORGEAX_VIDEO_S3_ENDPOINT: ' https://s3.example.test ',
        FORGEAX_VIDEO_S3_ACCESS_KEY_ID: ' AKIAEXAMPLE ',
        FORGEAX_VIDEO_S3_SECRET_ACCESS_KEY: ' super-secret-value ',
        FORGEAX_VIDEO_S3_PREFIX: ' /uploads/ ',
      }),
    ).toEqual({
      kind: 's3',
      bucket: 'forgeax-videos',
      region: 'ap-east-1',
      endpoint: 'https://s3.example.test',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'super-secret-value',
      prefix: 'uploads',
    });
  });

  test('parses a complete COS configuration', () => {
    expect(
      parseVideoStorageConfig({
        FORGEAX_VIDEO_STORAGE: 'cos',
        FORGEAX_VIDEO_COS_BUCKET: 'cos-bucket',
        FORGEAX_VIDEO_COS_REGION: 'ap-guangzhou',
        FORGEAX_VIDEO_COS_SECRET_ID: 'AKIDEXAMPLE',
        FORGEAX_VIDEO_COS_SECRET_KEY: 'another-secret',
        FORGEAX_VIDEO_COS_PREFIX: 'videos/',
      }),
    ).toEqual({
      kind: 'cos',
      bucket: 'cos-bucket',
      region: 'ap-guangzhou',
      secretId: 'AKIDEXAMPLE',
      secretKey: 'another-secret',
      prefix: 'videos',
    });
  });

  test('omits COS endpoint when FORGEAX_VIDEO_COS_ENDPOINT is unset', () => {
    const config = parseVideoStorageConfig({
      FORGEAX_VIDEO_STORAGE: 'cos',
      FORGEAX_VIDEO_COS_BUCKET: 'cos-bucket',
      FORGEAX_VIDEO_COS_REGION: 'ap-guangzhou',
      FORGEAX_VIDEO_COS_SECRET_ID: 'AKIDEXAMPLE',
      FORGEAX_VIDEO_COS_SECRET_KEY: 'another-secret',
    });
    expect(config.kind).toBe('cos');
    if (config.kind === 'cos') {
      expect(config.endpoint).toBeUndefined();
    }
  });

  test('normalizes bare and https COS endpoint hostnames', () => {
    const bare = parseVideoStorageConfig({
      FORGEAX_VIDEO_STORAGE: 'cos',
      FORGEAX_VIDEO_COS_BUCKET: 'cos-bucket',
      FORGEAX_VIDEO_COS_REGION: 'ap-guangzhou',
      FORGEAX_VIDEO_COS_SECRET_ID: 'AKIDEXAMPLE',
      FORGEAX_VIDEO_COS_SECRET_KEY: 'another-secret',
      FORGEAX_VIDEO_COS_ENDPOINT: ' STORAGE.EXAMPLE.COM ',
    });
    const https = parseVideoStorageConfig({
      FORGEAX_VIDEO_STORAGE: 'cos',
      FORGEAX_VIDEO_COS_BUCKET: 'cos-bucket',
      FORGEAX_VIDEO_COS_REGION: 'ap-guangzhou',
      FORGEAX_VIDEO_COS_SECRET_ID: 'AKIDEXAMPLE',
      FORGEAX_VIDEO_COS_SECRET_KEY: 'another-secret',
      FORGEAX_VIDEO_COS_ENDPOINT: 'https://storage.example.com/',
    });

    expect(bare).toMatchObject({
      kind: 'cos',
      endpoint: 'storage.example.com',
    });
    expect(https).toMatchObject({
      kind: 'cos',
      endpoint: 'storage.example.com',
    });
  });

  test('rejects unsafe COS endpoint values without leaking secrets', () => {
    const base = {
      FORGEAX_VIDEO_STORAGE: 'cos',
      FORGEAX_VIDEO_COS_BUCKET: 'cos-bucket',
      FORGEAX_VIDEO_COS_REGION: 'ap-guangzhou',
      FORGEAX_VIDEO_COS_SECRET_ID: 'AKIDEXAMPLE',
      FORGEAX_VIDEO_COS_SECRET_KEY: 'cos-secret-value',
    };

    for (const endpoint of [
      'http://storage.example.com',
      'https://user:pass@storage.example.com',
      'storage.example.com/path',
      'storage.example.com?query=1',
      'storage.example.com#frag',
      'storage.example.com:8443',
      '127.0.0.1',
      'localhost',
      '10.0.0.5',
      'not a hostname',
    ]) {
      expect(() =>
        parseVideoStorageConfig({
          ...base,
          FORGEAX_VIDEO_COS_ENDPOINT: endpoint,
        }),
      ).toThrow(VideoAssetConfigError);
      try {
        parseVideoStorageConfig({
          ...base,
          FORGEAX_VIDEO_COS_ENDPOINT: endpoint,
        });
      } catch (error) {
        expect((error as VideoAssetConfigError).message).toContain('FORGEAX_VIDEO_COS_ENDPOINT');
        expect((error as VideoAssetConfigError).message).not.toContain('cos-secret-value');
      }
    }
  });

  test('rejects invalid FORGEAX_VIDEO_STORAGE values', () => {
    expect(() =>
      parseVideoStorageConfig({ FORGEAX_VIDEO_STORAGE: 'kino' }),
    ).toThrow(VideoAssetConfigError);
    try {
      parseVideoStorageConfig({ FORGEAX_VIDEO_STORAGE: 'kino' });
    } catch (error) {
      expect((error as VideoAssetConfigError).message).toContain('FORGEAX_VIDEO_STORAGE');
      expect((error as VideoAssetConfigError).message).not.toContain('secret');
    }
  });

  test('fails S3 startup when any required variable is missing', () => {
    const base = {
      FORGEAX_VIDEO_STORAGE: 's3',
      FORGEAX_VIDEO_S3_BUCKET: 'bucket',
      FORGEAX_VIDEO_S3_REGION: 'ap-east-1',
      FORGEAX_VIDEO_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      FORGEAX_VIDEO_S3_SECRET_ACCESS_KEY: 'super-secret-value',
    };

    for (const key of [
      'FORGEAX_VIDEO_S3_BUCKET',
      'FORGEAX_VIDEO_S3_REGION',
      'FORGEAX_VIDEO_S3_ACCESS_KEY_ID',
      'FORGEAX_VIDEO_S3_SECRET_ACCESS_KEY',
    ] as const) {
      const env = { ...base };
      delete env[key];
      expect(() => parseVideoStorageConfig(env)).toThrow(VideoAssetConfigError);
      try {
        parseVideoStorageConfig(env);
      } catch (error) {
        expect((error as VideoAssetConfigError).message).toContain(key);
        expect((error as VideoAssetConfigError).message).not.toContain('super-secret-value');
      }
    }
  });

  test('fails COS startup when any required variable is missing', () => {
    const base = {
      FORGEAX_VIDEO_STORAGE: 'cos',
      FORGEAX_VIDEO_COS_BUCKET: 'bucket',
      FORGEAX_VIDEO_COS_REGION: 'ap-guangzhou',
      FORGEAX_VIDEO_COS_SECRET_ID: 'AKIDEXAMPLE',
      FORGEAX_VIDEO_COS_SECRET_KEY: 'another-secret',
    };

    for (const key of [
      'FORGEAX_VIDEO_COS_BUCKET',
      'FORGEAX_VIDEO_COS_REGION',
      'FORGEAX_VIDEO_COS_SECRET_ID',
      'FORGEAX_VIDEO_COS_SECRET_KEY',
    ] as const) {
      const env = { ...base };
      delete env[key];
      expect(() => parseVideoStorageConfig(env)).toThrow(VideoAssetConfigError);
      try {
        parseVideoStorageConfig(env);
      } catch (error) {
        expect((error as VideoAssetConfigError).message).toContain(key);
        expect((error as VideoAssetConfigError).message).not.toContain('another-secret');
      }
    }
  });

  test('does not fall back to local when explicit cloud configuration is incomplete', () => {
    expect(() =>
      parseVideoStorageConfig({
        FORGEAX_VIDEO_STORAGE: 's3',
        FORGEAX_VIDEO_S3_BUCKET: 'bucket',
      }),
    ).toThrow(VideoAssetConfigError);

    expect(() =>
      parseVideoStorageConfig({
        FORGEAX_VIDEO_STORAGE: 'cos',
        FORGEAX_VIDEO_COS_BUCKET: 'bucket',
      }),
    ).toThrow(VideoAssetConfigError);
  });

  test('rejects unsafe S3 and COS prefixes without leaking secrets', () => {
    const providers = [
      {
        env: {
          FORGEAX_VIDEO_STORAGE: 's3',
          FORGEAX_VIDEO_S3_BUCKET: 'bucket',
          FORGEAX_VIDEO_S3_REGION: 'ap-east-1',
          FORGEAX_VIDEO_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
          FORGEAX_VIDEO_S3_SECRET_ACCESS_KEY: 's3-secret-value',
        },
        prefixKey: 'FORGEAX_VIDEO_S3_PREFIX',
        secret: 's3-secret-value',
      },
      {
        env: {
          FORGEAX_VIDEO_STORAGE: 'cos',
          FORGEAX_VIDEO_COS_BUCKET: 'bucket',
          FORGEAX_VIDEO_COS_REGION: 'ap-guangzhou',
          FORGEAX_VIDEO_COS_SECRET_ID: 'AKIDEXAMPLE',
          FORGEAX_VIDEO_COS_SECRET_KEY: 'cos-secret-value',
        },
        prefixKey: 'FORGEAX_VIDEO_COS_PREFIX',
        secret: 'cos-secret-value',
      },
    ] as const;

    for (const provider of providers) {
      for (const prefix of [
        'bad\0prefix',
        'bad\\prefix',
        '.',
        '..',
        'safe/./object',
        'safe/../escape',
      ]) {
        const env = {
          ...provider.env,
          [provider.prefixKey]: prefix,
        };
        expect(() => parseVideoStorageConfig(env)).toThrow(VideoAssetConfigError);
        try {
          parseVideoStorageConfig(env);
        } catch (error) {
          expect((error as VideoAssetConfigError).message).toContain(provider.prefixKey);
          expect((error as VideoAssetConfigError).message).not.toContain(provider.secret);
        }
      }
    }
  });
});
