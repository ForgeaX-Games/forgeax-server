export const VIDEO_ASSET_RESOURCE_ID_RE =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function isValidVideoAssetResourceId(resourceId: unknown): resourceId is string {
  return (
    typeof resourceId === 'string' &&
    VIDEO_ASSET_RESOURCE_ID_RE.test(resourceId)
  );
}
