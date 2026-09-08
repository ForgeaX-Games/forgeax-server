export function hostApiAllowedOrigins(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  const rawPort = env.FORGEAX_INTERFACE_PORT?.trim() || '18920';
  if (!/^\d+$/u.test(rawPort)) {
    throw new Error(`FORGEAX_INTERFACE_PORT must be an integer: ${rawPort}`);
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`FORGEAX_INTERFACE_PORT is outside 1-65535: ${rawPort}`);
  }

  const protocol = env.FORGEAX_INTERFACE_HTTPS === '1' ? 'https' : 'http';
  const origins = new Set([
    `${protocol}://127.0.0.1:${port}`,
    `${protocol}://localhost:${port}`,
  ]);

  const publicOrigin = env.FORGEAX_PUBLIC_ORIGIN?.trim();
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (
      !['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      throw new Error('FORGEAX_PUBLIC_ORIGIN must be an exact HTTP(S) origin');
    }
    origins.add(url.origin);
  }

  return origins;
}

export function hostApiOriginAllowed(
  origin: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (hostApiAllowedOrigins(env).has(origin)) return true;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin || url.protocol !== 'https:') return false;

  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  return (env.FORGEAX_INTERFACE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase().replace(/\.$/u, ''))
    .filter((host) => host !== '' && host !== 'true' && host !== '*')
    .some((host) => host.startsWith('.')
      ? hostname === host.slice(1) || hostname.endsWith(host)
      : hostname === host);
}
