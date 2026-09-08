const LOCAL_INTERFACE_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const;
const LOCAL_INTERFACE_PROTOCOLS = ['http', 'https'] as const;

export function localInterfaceOrigins(interfacePort: string): ReadonlySet<string> {
  return new Set(
    LOCAL_INTERFACE_PROTOCOLS.flatMap((protocol) =>
      LOCAL_INTERFACE_HOSTS.map((host) => `${protocol}://${host}:${interfacePort}`),
    ),
  );
}
