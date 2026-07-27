interface CachedUrl {
  expiresAt: number;
  value: Promise<string>;
}

export interface ExpiringUrlCache {
  get(key: string, load: () => Promise<string>): Promise<string>;
  delete(key: string): void;
}

/**
 * Keeps presigned playback URLs stable for most of their lifetime so browsers
 * can reuse cached object responses. Failed signing attempts are never cached.
 */
export function createExpiringUrlCache(
  ttlMs: number,
  now: () => number = Date.now,
  maxEntries = 1_024,
): ExpiringUrlCache {
  const entries = new Map<string, CachedUrl>();
  const entryLimit = Math.max(1, maxEntries);

  return {
    get(key, load) {
      const currentTime = now();
      const cached = entries.get(key);
      if (cached && cached.expiresAt > currentTime) {
        return cached.value;
      }

      for (const [cachedKey, entry] of entries) {
        if (entry.expiresAt <= currentTime) {
          entries.delete(cachedKey);
        }
      }
      while (entries.size >= entryLimit) {
        const oldestKey = entries.keys().next().value as string | undefined;
        if (oldestKey === undefined) {
          break;
        }
        entries.delete(oldestKey);
      }

      const entry: CachedUrl = {
        expiresAt: currentTime + ttlMs,
        value: load(),
      };
      entries.set(key, entry);
      void entry.value.catch(() => {
        if (entries.get(key) === entry) {
          entries.delete(key);
        }
      });
      return entry.value;
    },

    delete(key) {
      entries.delete(key);
    },
  };
}
