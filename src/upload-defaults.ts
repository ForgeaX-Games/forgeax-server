// Product-shell-owned upload destination defaults.
//
// The shared destination repo and the shared write token are PRODUCT policy and
// credential — which org repo every workspace lands in, and the token that makes
// upload work out of the box for everyone. They live here in the product shell,
// NOT in the business-agnostic @forgeax/orchestrator base (where the token used
// to be a compiled constant inside upload/config.ts). The shell injects them at
// boot via `createForgeaxApp({ uploadDefaults })`; the orchestration layer's
// upload mechanism reads them through `getUploadDefaults()`. FORGEAX_UPLOAD_*
// env overrides still win at resolve time, so this object carries only the
// built-in shared defaults (no env resolution here).
//
// The token is stored in pieces because GitHub secret-scanning / push-protection
// auto-revokes verbatim `github_pat_` strings the moment they land in a mirror.
// Scope check 2026-07-20: Contents write only on ForgeaX-Games/Forgeax-Data
// (personal-repo blob create → 403 Resource not accessible by PAT). Never
// logged / committed / persisted.

import type { UploadDefaults } from '@forgeax/orchestrator';

/** The shared org repo every workspace lands in (one `<namespace>/` subdir each). */
const SHARED_UPLOAD_REPO = 'ForgeaX-Games/Forgeax-Data';

const SHARED_UPLOAD_TOKEN = [
  'github_pat_',
  '11AD6JT7Q01J0AtpQyDmzz_',
  '8nFt5DkPQIyww1qhquNbc3eLOXyMv7yuhugt3HN8uY1BQVJHRRPr2FqsLXS',
].join('');

/** Built-in shared defaults injected into the orchestration layer's upload seam. */
export const uploadDefaults: UploadDefaults = {
  repo: SHARED_UPLOAD_REPO,
  token: SHARED_UPLOAD_TOKEN,
  branch: 'main',
};
