// src/game/asset-library/host-worker.ts
import { parentPort, workerData } from "node:worker_threads";

// src/game/asset-library/host.ts
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Worker, isMainThread } from "node:worker_threads";
import { existsSync as existsSync4, lstatSync as lstatSync3, readFileSync as readFileSync3, realpathSync as realpathSync2, readdirSync } from "node:fs";
import { arch as arch2, platform as platform2 } from "node:os";
import { resolve as resolve4, relative as relative2, isAbsolute as isAbsolute3, sep as sep2 } from "node:path";

// src/game/asset-library/constants.ts
import { createHash } from "node:crypto";
var PROVIDER_RESULT_SCHEMA = "forgeax.asset3d-search-result/1.0.0";
var PROVIDER_RECEIPT_SCHEMA = "forgeax.asset3d-search-receipt/1.0.0";
var ASSET3D_PROVIDER_COMMIT = "c181c48fbffc933a7ce9a0836f7878ca5e6d77e1";
var BUNDLED_ASSET3D_PROVIDERS = Object.freeze({
  "darwin-arm64": {
    sha256: "9492c507a3afe5cafcd50b5f782b313c8716c2e52f5def06592c6a100c0459db",
    relativePath: "asset3d/provider/asset3d-search-provider-c181c48fbffc933a7ce9a0836f7878ca5e6d77e1-darwin-arm64.tar.gz"
  },
  "linux-x64": {
    sha256: "e6ac3df76c8b82f9fe2c063dd3f221324a9dad5176fd52535a5144b0ff6002d8",
    relativePath: "asset3d/provider/asset3d-search-provider-c181c48fbffc933a7ce9a0836f7878ca5e6d77e1-linux-x64.tar.gz"
  }
});
var MAX_JSON_BYTES = 1024 * 1024;
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function canonicalJson(value) {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

// src/game/asset-library/aw-access.ts
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// src/game/asset-library/origins.ts
import { domainToASCII } from "node:url";
function canonicalIpv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part)))
    return;
  const values = parts.map(Number);
  if (values.some((value) => value > 255))
    throw new Error("download_origin_invalid: invalid IPv4 address");
  return values.join(".");
}
function canonicalizeOrigins(inputs) {
  if (inputs.length < 1 || inputs.length > 8) {
    throw new Error("download_origin_count_invalid: expected 1..8 --download-origin values");
  }
  const values = inputs.map((input) => {
    const lexical = /^(https?):\/\/(\[[0-9A-Fa-f:.]+\]|[^:/?#@]+):(\d{1,5})$/.exec(input);
    if (!lexical) {
      throw new Error("download_origin_invalid: expected exact scheme://host:port without path, query, fragment, or userinfo");
    }
    let parsed;
    try {
      parsed = new URL(input);
    } catch {
      throw new Error("download_origin_invalid: malformed URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error("download_origin_invalid: http or https required");
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("download_origin_invalid: userinfo/path/query/fragment is forbidden");
    }
    const port = Number(lexical[3]);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("download_origin_invalid: explicit port must be 1..65535");
    let host = lexical[2];
    if (host === "*" || host.includes("*"))
      throw new Error("download_origin_invalid: wildcard host is forbidden");
    if (host.startsWith("[") && host.endsWith("]")) {
      const normalized = new URL(`${parsed.protocol}//${host}:${port}`).hostname;
      host = normalized.startsWith("[") ? normalized.toLowerCase() : `[${normalized.toLowerCase()}]`;
    } else {
      host = canonicalIpv4(host) ?? domainToASCII(host.replace(/\.$/, "")).toLowerCase();
      if (!host)
        throw new Error("download_origin_invalid: host cannot be canonicalized");
    }
    return `${lexical[1]}://${host}:${port}`;
  }).sort();
  if (new Set(values).size !== values.length)
    throw new Error("download_origin_duplicate: canonical duplicates are forbidden");
  const compactJson = canonicalJson(values);
  return { values, compactJson, digest: sha256(compactJson) };
}

// src/game/asset-library/aw-access.ts
var AW_SERVICE_PATH = "/trpc.oasismetric.omcontentserver.http";
var ACCESS_CHECK_SCHEMA = "forgeax.asset3d-access-check/1.0.0";
function normalizeAssetLibraryServiceRoot(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("asset3d_base_url_invalid: expected an HTTP(S) EA gateway or service URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("asset3d_base_url_invalid: credentials, query, and fragment are forbidden");
  }
  let path = parsed.pathname.replace(/\/+$/, "");
  if (path.endsWith(`${AW_SERVICE_PATH}/HybridSearch`))
    path = path.slice(0, -"/HybridSearch".length);
  else if (!path.endsWith(AW_SERVICE_PATH))
    path = `${path}${AW_SERVICE_PATH}`;
  parsed.pathname = path;
  return parsed.toString().replace(/\/$/, "");
}
function resolveAssetLibrarySelection(options = {}) {
  const library = options.library || process.env.FORGEAX_ASSET_LIBRARY || "ea";
  if (library !== "aw" && library !== "ea") {
    throw new Error("asset3d_library_invalid: expected aw or ea");
  }
  const configured = options.baseUrl || process.env.FORGEAX_ASSET_LIBRARY_BASE_URL;
  if (!configured?.trim()) {
    throw new Error("asset3d_base_url_required: configure FORGEAX_ASSET_LIBRARY_BASE_URL before using the asset library");
  }
  return { library, serviceRoot: normalizeAssetLibraryServiceRoot(configured) };
}
function checkAssetLibraryProviderAccess(options) {
  const command = resolve(options.providerCache, "bin", "asset3d-search");
  if (!existsSync(command))
    throw new Error("asset3d_provider_not_prepared");
  const result = spawnSync(command, ["--check-aw-access"], {
    encoding: "utf8",
    timeout: 45000,
    maxBuffer: 128 * 1024,
    env: {
      ...process.env,
      ASSET3D_CATALOG_BASE_URL: "",
      AW_API_BASE_URL: options.serviceRoot,
      AW_API_DEPOT_NAME: options.depotName,
      AW_API_CREDENTIAL_FILE: resolve(options.credentialFile),
      AW_API_SANDBOX_KEY: ""
    }
  });
  return parseAssetLibraryAccessResult(result, options.serviceRoot);
}
function parseAssetLibraryAccessResult(result, serviceRoot) {
  if (result.error) {
    const code = result.error.code === "ETIMEDOUT" ? "asset3d_access_check_timeout" : "asset3d_access_check_process_failed";
    throw new Error(`${code}: Provider access check could not complete; credential validity is unknown`);
  }
  if (result.signal || result.status === null) {
    throw new Error("asset3d_access_check_process_failed: Provider access check terminated; credential validity is unknown");
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout ?? "");
  } catch {
    throw new Error("asset3d_access_validation_failed: Provider returned an invalid response");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("asset3d_access_validation_failed: Provider returned an invalid response");
  }
  const envelope = payload;
  if (envelope.schemaVersion !== ACCESS_CHECK_SCHEMA || typeof envelope.ok !== "boolean") {
    throw new Error("asset3d_access_validation_failed: Provider returned an invalid response");
  }
  if (envelope.ok === false) {
    const messages = {
      search_timeout: "selected asset-library service timed out",
      search_upstream_error: "selected asset-library service failed; credential validity is unknown",
      asset3d_access_validation_inconclusive: "Provider could not establish access and download origins",
      asset3d_api_key_invalid_or_unavailable: "Provider did not distinguish service, network and authentication failure; invalid credentials are not established"
    };
    const code = envelope.error?.code;
    if (typeof code === "string" && Object.hasOwn(messages, code)) {
      throw new Error(`${code}: ${messages[code]}`);
    }
    throw new Error("asset3d_access_validation_failed: Provider access check failed without a recognized cause; credential validity is unknown");
  }
  if (result.status !== 0) {
    throw new Error("asset3d_access_check_process_failed: Provider exited unsuccessfully despite a success response");
  }
  if (envelope.value?.authentication !== "sandbox-key" || !Array.isArray(envelope.value.downloadOrigins)) {
    throw new Error("asset3d_access_validation_failed: Provider returned an invalid response");
  }
  const origins = canonicalizeOrigins(envelope.value.downloadOrigins).values;
  return { serviceRoot, authentication: "sandbox-key", downloadOrigins: origins };
}

// src/game/asset-library/credentials.ts
import { existsSync as existsSync2, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolve2 } from "node:path";
var AW_CREDENTIAL_SCHEMA = "forgeax.asset3d-credential/1.0.0";
var MAX_CREDENTIAL_BYTES = 4096;
function validateKey(value) {
  if (!value || value.length > 2048 || [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  })) {
    throw new Error("asset3d_api_key_invalid: expected a non-empty printable key");
  }
  return value;
}
function defaultAwCredentialFile() {
  const configured = process.env.FORGEAX_ASSET3D_CREDENTIAL_FILE;
  return resolve2(configured || resolve2(homedir(), ".forgeax", "credentials", "asset3d-aw.json"));
}
function readAwCredential(pathInput) {
  const path = resolve2(pathInput);
  if (!isAbsolute(pathInput))
    throw new Error("asset3d_credential_path_invalid: absolute path required");
  if (!existsSync2(path))
    return;
  try {
    const metadata = lstatSync(path);
    const wrongOwner = typeof process.getuid === "function" && metadata.uid !== process.getuid();
    if (!metadata.isFile() || metadata.isSymbolicLink() || wrongOwner)
      throw new Error;
    if ((metadata.mode & 63) !== 0 || metadata.size < 1 || metadata.size > MAX_CREDENTIAL_BYTES)
      throw new Error;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (Object.keys(parsed).sort().join(",") !== "provider,sandboxKey,schemaVersion")
      throw new Error;
    if (parsed.schemaVersion !== AW_CREDENTIAL_SCHEMA || parsed.provider !== "aw" || typeof parsed.sandboxKey !== "string")
      throw new Error;
    return validateKey(parsed.sandboxKey);
  } catch {
    throw new Error("asset3d_credential_invalid: credential file must be an owned 0600 regular file with the supported schema");
  }
}

// src/game/asset-library/provider.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { existsSync as existsSync3, readFileSync as readFileSync2, realpathSync, lstatSync as lstatSync2, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir as homedir2, platform, arch } from "node:os";
import { resolve as resolve3, join, relative, isAbsolute as isAbsolute2, sep } from "node:path";
import { fileURLToPath } from "node:url";
function defaultLibraryAssetsRoot() {
  return process.env.FORGEAX_RESOURCE_ROOT ? resolve3(process.env.FORGEAX_RESOURCE_ROOT, "product/asset-library") : fileURLToPath(new URL("../../../assets/asset-library/", import.meta.url));
}
function packagedAsset3dProvider(path, root = defaultLibraryAssetsRoot()) {
  const canonical = realpathSync(root);
  const candidate = realpathSync(resolve3(root, path));
  const rel = relative(canonical, candidate);
  if (isAbsolute2(rel) || rel === ".." || rel.startsWith(`..${sep}`) || !lstatSync2(candidate).isFile())
    throw new Error("asset_library_provider_resource_invalid");
  return candidate;
}
function run(command, args, maxBuffer = 4 * 1024 * 1024) {
  const result = spawnSync2(command, args, { encoding: "utf8", timeout: 120000, maxBuffer });
  if (result.status !== 0)
    throw new Error("asset_library_provider_verification_failed");
  return result.stdout;
}
function prepareAsset3dProvider(options) {
  const { providerBundle: archive, expectedSha256: digest } = options;
  if (sha256(readFileSync2(archive)) !== digest)
    throw new Error("asset_library_provider_digest_mismatch");
  const manifest = JSON.parse(run("tar", ["-xOzf", archive, "bundle-manifest.json"]));
  if (manifest.schema !== "forgeax.asset3d-provider-bundle/1.0.0" || manifest.providerCommit !== ASSET3D_PROVIDER_COMMIT || manifest.target !== `${platform()}-${arch()}`)
    throw new Error("asset_library_provider_identity_mismatch");
  const python = ["python3.12", "python3.11", "python3"].find((command) => {
    const result = spawnSync2(command, ["-B", "-c", 'import sys;print("%d.%d"%sys.version_info[:2])'], { encoding: "utf8" });
    return result.status === 0 && /^(3\.11|3\.12)\s*$/.test(result.stdout);
  });
  if (!python)
    throw new Error("asset_library_python_required: Python 3.11 or 3.12");
  const root = resolve3(homedir2(), ".forgeax/providers/asset3d-search");
  mkdirSync(root, { recursive: true, mode: 448 });
  const cache = resolve3(root, digest);
  const stage = mkdtempSync(join(root, ".studio-verify-"));
  try {
    const verifier = resolve3(stage, "verify.py");
    writeFileSync(verifier, run("tar", ["-xOzf", archive, "verify/verify_asset3d_bundle.py"]), { mode: 384 });
    if (existsSync3(cache)) {
      run(python, ["-B", verifier, "--stage", cache, "--json"]);
    } else {
      run(python, ["-B", verifier, "--archive", archive, "--sha256", digest, "--provision", cache, "--python", python, "--json"]);
    }
    if (!existsSync3(resolve3(cache, "bin/asset3d-search")))
      throw new Error("asset_library_provider_missing");
    return realpathSync(cache);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// src/game/asset-library/fs.ts
import { closeSync, fsyncSync, mkdirSync as mkdirSync2, openSync, renameSync, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname } from "node:path";
function ensurePrivateDir(path) {
  mkdirSync2(path, { recursive: true, mode: 448 });
}
function atomicWrite(path, data, mode = 384) {
  ensurePrivateDir(dirname(path));
  const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = openSync(temp, "wx", mode);
  try {
    writeFileSync2(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const dirFd = openSync(dirname(path), "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

// src/game/asset-library/schema.ts
var ID = /^[A-Za-z0-9._-]{1,128}$/;
var DIGEST = /^[a-f0-9]{64}$/;
var ERROR_CODES = new Set([
  "asset_not_found",
  "asset_identity_missing",
  "search_timeout",
  "search_upstream_error",
  "download_timeout",
  "download_origin_rejected",
  "download_too_large",
  "archive_rejected",
  "conversion_failed",
  "digest_failed",
  "batch_timeout",
  "internal_error"
]);
var ROLES = new Set(["primary-model", "animation", "auxiliary-model", "texture", "metadata"]);
function exactKeys(record, allowed, field) {
  const extras = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extras.length)
    throw new Error(`provider_result_invalid: unknown ${field} fields`);
}
function safeRelativePath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || value.startsWith("/") || value.includes("\\")) {
    throw new Error("provider_result_invalid: manifest path must be relative POSIX");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error("provider_result_invalid: unsafe manifest path");
  return value;
}
function number(value, min, max, field) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`provider_result_invalid: ${field}`);
  return value;
}
function text(value, min, max, field) {
  if (typeof value !== "string" || [...value].length < min || [...value].length > max)
    throw new Error(`provider_result_invalid: ${field}`);
  return value;
}
function aggregate(entries) {
  const bytes = entries.map((entry) => `${entry.path}\x00${entry.bytes}\x00${entry.sha256}
`).join("");
  return sha256(bytes);
}
function parseProviderResult(input, expectedCommit, expectedOriginSetDigest) {
  const bytes = typeof input === "string" ? Buffer.byteLength(input) : input.byteLength;
  if (bytes > MAX_JSON_BYTES)
    throw new Error("provider_result_too_large: stdin exceeds 1 MiB");
  let raw;
  try {
    raw = JSON.parse(typeof input === "string" ? input : Buffer.from(input).toString("utf8"));
  } catch {
    throw new Error("provider_result_invalid: stdin is not JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("provider_result_invalid: top-level object required");
  const root = raw;
  exactKeys(root, ["schemaVersion", "total", "succeeded", "failed", "results", "receipt"], "top-level");
  if (root.schemaVersion !== PROVIDER_RESULT_SCHEMA)
    throw new Error("provider_result_invalid: schemaVersion");
  const total = number(root.total, 1, 16, "total");
  const succeeded = number(root.succeeded, 0, total, "succeeded");
  const failed = number(root.failed, 0, total, "failed");
  if (succeeded + failed !== total || !Array.isArray(root.results) || root.results.length !== total)
    throw new Error("provider_result_invalid: counts");
  let receipt;
  if (root.receipt !== undefined) {
    if (!root.receipt || typeof root.receipt !== "object" || Array.isArray(root.receipt)) {
      throw new Error("provider_result_invalid: receipt object required");
    }
    const value = root.receipt;
    exactKeys(value, ["schemaVersion", "provider", "providerCommit", "originSetDigest"], "receipt");
    if (value.schemaVersion !== PROVIDER_RECEIPT_SCHEMA || value.provider !== "ea-3d" || value.providerCommit !== expectedCommit || value.originSetDigest !== expectedOriginSetDigest) {
      throw new Error("provider_result_invalid: receipt identity");
    }
    receipt = {
      schemaVersion: PROVIDER_RECEIPT_SCHEMA,
      provider: "ea-3d",
      providerCommit: expectedCommit,
      originSetDigest: expectedOriginSetDigest
    };
  }
  if (succeeded > 0 && receipt === undefined)
    throw new Error("provider_result_invalid: success receipt required");
  const indices = new Set;
  let okCount = 0;
  const results = root.results.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new Error("provider_result_invalid: result row");
    const row = candidate;
    const queryIndex = number(row.queryIndex, 0, total - 1, "queryIndex");
    if (indices.has(queryIndex))
      throw new Error("provider_result_invalid: duplicate queryIndex");
    indices.add(queryIndex);
    const query = text(row.query, 1, 200, "query");
    if (row.status === "error") {
      exactKeys(row, ["status", "queryIndex", "query", "code", "retryable", "message"], "error");
      if (typeof row.code !== "string" || !ERROR_CODES.has(row.code) || typeof row.retryable !== "boolean")
        throw new Error("provider_result_invalid: error row");
      const message = text(row.message, 0, 256, "message");
      return { status: "error", queryIndex, query, code: row.code, retryable: row.retryable, message };
    }
    if (row.status !== "ok")
      throw new Error("provider_result_invalid: status");
    exactKeys(row, ["status", "queryIndex", "query", "provider", "providerAssetId", "assetName", "deliveredFormat", "sha256", "bytes", "primaryModel", "manifest", "originSetDigest", "downloaded_to"], "success");
    okCount++;
    if (row.provider !== "ea-3d" || row.deliveredFormat !== "glb" || typeof row.providerAssetId !== "string" || !ID.test(row.providerAssetId) || row.providerAssetId === "." || row.providerAssetId === "..") {
      throw new Error("provider_result_invalid: success identity");
    }
    const assetName = text(row.assetName, 1, 128, "assetName");
    const itemBytes = number(row.bytes, 1, 268435456, "bytes");
    if (typeof row.sha256 !== "string" || !DIGEST.test(row.sha256))
      throw new Error("provider_result_invalid: aggregate digest");
    if (!Array.isArray(row.manifest) || row.manifest.length < 1 || row.manifest.length > 1024)
      throw new Error("provider_result_invalid: manifest count");
    const seen = new Set;
    const manifest = row.manifest.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new Error("provider_result_invalid: manifest entry");
      const item = entry;
      exactKeys(item, ["path", "role", "bytes", "sha256"], "manifest");
      const path = safeRelativePath(item.path);
      if (seen.has(path))
        throw new Error("provider_result_invalid: duplicate manifest path");
      seen.add(path);
      if (typeof item.role !== "string" || !ROLES.has(item.role))
        throw new Error("provider_result_invalid: manifest role");
      const role = item.role;
      const entryBytes = number(item.bytes, 1, 134217728, "manifest bytes");
      if (typeof item.sha256 !== "string" || !DIGEST.test(item.sha256))
        throw new Error("provider_result_invalid: manifest digest");
      if ((role === "primary-model" || role === "animation" || role === "auxiliary-model") && !path.toLowerCase().endsWith(".glb")) {
        throw new Error("provider_result_invalid: model entry must be GLB");
      }
      return { path, role, bytes: entryBytes, sha256: item.sha256 };
    });
    const sorted = [...manifest].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
    if (manifest.some((entry, index) => entry.path !== sorted[index].path))
      throw new Error("provider_result_invalid: manifest must be UTF-8 path sorted");
    const primary = manifest.filter((entry) => entry.role === "primary-model");
    if (primary.length !== 1 || row.primaryModel !== primary[0].path)
      throw new Error("provider_result_invalid: primary model");
    if (manifest.reduce((sum, entry) => sum + entry.bytes, 0) !== itemBytes || aggregate(manifest) !== row.sha256) {
      throw new Error("provider_result_invalid: byte or aggregate digest mismatch");
    }
    if (row.originSetDigest !== expectedOriginSetDigest)
      throw new Error("provider_result_invalid: originSetDigest identity");
    return {
      status: "ok",
      queryIndex,
      query,
      provider: "ea-3d",
      providerAssetId: row.providerAssetId,
      assetName,
      deliveredFormat: "glb",
      sha256: row.sha256,
      bytes: itemBytes,
      primaryModel: row.primaryModel,
      manifest,
      originSetDigest: expectedOriginSetDigest,
      ...row.downloaded_to === undefined ? {} : { downloaded_to: row.downloaded_to }
    };
  });
  if (okCount !== succeeded || total - okCount !== failed)
    throw new Error("provider_result_invalid: status counts");
  return { schemaVersion: PROVIDER_RESULT_SCHEMA, total, succeeded, failed, results, ...receipt ? { receipt } : {} };
}

// src/game/asset-library/host.ts
function validateLibrarySources(root, items) {
  const canonical = realpathSync2(root);
  const declared = new Set;
  for (const item of items)
    for (const file of item.manifest) {
      const path = resolve4(root, file.path);
      const rel = relative2(canonical, realpathSync2(path));
      if (isAbsolute3(rel) || rel === ".." || rel.startsWith(`..${sep2}`))
        throw new Error("asset_source_escape");
      const info = lstatSync3(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes || sha256(readFileSync3(path)) !== file.sha256) {
        throw new Error("asset_source_digest_mismatch");
      }
      if (declared.has(file.path))
        throw new Error("asset_source_collision");
      declared.add(file.path);
    }
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const path = resolve4(dir, name);
      const info = lstatSync3(path);
      if (info.isSymbolicLink())
        throw new Error("asset_source_symlink");
      if (info.isDirectory())
        walk(path);
      else if (!info.isFile() || !declared.delete(relative2(root, path).split(sep2).join("/")))
        throw new Error("asset_source_undeclared");
    }
  }
  walk(root);
  if (declared.size)
    throw new Error("asset_source_missing");
}
async function search(command, env, args) {
  const child = spawn(command, [], { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  try {
    return await new Promise((done, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("asset_library_search_timeout")), 195000);
      const fail = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      child.on("error", () => fail(new Error("asset_library_provider_start_failed")));
      child.stdin.on("error", () => fail(new Error("asset_library_provider_write_failed")));
      child.on("exit", () => fail(new Error("asset_library_provider_exited")));
      const send = (value) => child.stdin.write(`${JSON.stringify(value)}
`);
      child.stdout.on("data", (data) => {
        buffer += data.toString("utf8");
        if (Buffer.byteLength(buffer) > 2 * 1024 * 1024)
          return fail(new Error("asset_library_response_too_large"));
        let end;
        while ((end = buffer.indexOf(`
`)) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line.trim())
            continue;
          try {
            const message = JSON.parse(line);
            if (message.error)
              return fail(new Error("asset_library_provider_protocol_error"));
            if (message.id === 1) {
              send({ jsonrpc: "2.0", method: "notifications/initialized" });
              send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_asset", arguments: args } });
            } else if (message.id === 2) {
              const texts = message.result?.content?.filter((v) => v.type === "text");
              if (message.result?.isError || texts?.length !== 1 || typeof texts[0].text !== "string")
                return fail(new Error("asset_library_provider_result_invalid"));
              clearTimeout(timer);
              done(texts[0].text);
            }
          } catch {
            return fail(new Error("asset_library_provider_protocol_error"));
          }
        }
      });
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "forgeax-host-assets", version: "1.0.0" } } });
    });
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
    const kill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }, 2000);
    kill.unref();
    child.once("exit", () => clearTimeout(kill));
  }
}
async function searchLibrarySources(options) {
  if (isMainThread)
    return new Promise((done, reject) => {
      const worker = new Worker(options.workerPath ?? resolve4(options.assetsRoot ?? defaultLibraryAssetsRoot(), "worker.js"), { workerData: { ...options, assetsRoot: options.assetsRoot ?? defaultLibraryAssetsRoot() }, execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")) });
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("asset_library_timeout"));
      }, 300000);
      worker.once("message", (message) => {
        clearTimeout(timer);
        worker.terminate();
        message.error ? reject(new Error(message.error)) : done(message.value);
      });
      worker.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`asset_library_worker_exit:${code}`));
      });
    });
  const root = realpathSync2(options.projectRoot);
  if (!existsSync4(resolve4(root, "forge.json")))
    throw new Error("asset_library_game_required");
  if (!Array.isArray(options.queries) || options.queries.length < 1 || options.queries.length > 8 || options.queries.some((q) => typeof q !== "string" || !q.trim() || [...q].length > 200))
    throw new Error("asset_library_queries_invalid");
  const selection = resolveAssetLibrarySelection({ library: options.library ?? process.env.FORGEAX_ASSET_LIBRARY ?? "ea" });
  const target = `${platform2()}-${arch2()}`;
  const bundle = BUNDLED_ASSET3D_PROVIDERS[target];
  if (!bundle)
    throw new Error(`asset3d_provider_target_unreleased: ${target}`);
  const credentialFile = defaultAwCredentialFile();
  if (!readAwCredential(credentialFile))
    throw new Error("asset3d_api_key_required: configure the official asset-library credential before searching");
  const cache = prepareAsset3dProvider({ providerBundle: packagedAsset3dProvider(bundle.relativePath, options.assetsRoot), expectedSha256: bundle.sha256 });
  const access = checkAssetLibraryProviderAccess({ providerCache: cache, depotName: selection.library, serviceRoot: selection.serviceRoot, credentialFile });
  const origins = canonicalizeOrigins(access.downloadOrigins);
  const execution = randomUUID();
  for (const directory of [resolve4(root, ".forgeax"), resolve4(root, ".forgeax", "library-sources")]) {
    if (!existsSync4(directory))
      continue;
    const rel = relative2(root, realpathSync2(directory));
    if (lstatSync3(directory).isSymbolicLink() || isAbsolute3(rel) || rel === ".." || rel.startsWith(`..${sep2}`))
      throw new Error("asset_library_source_escape");
  }
  const quarantine = resolve4(root, ".forgeax", "library-sources", execution);
  const sourceRoot = resolve4(quarantine, "workspace", "asset3d");
  ensurePrivateDir(sourceRoot);
  const payload = await search(resolve4(cache, "bin", "asset3d-search"), {
    ...process.env,
    ASSET3D_CATALOG_BASE_URL: "",
    AW_API_SANDBOX_KEY: "",
    AW_API_BASE_URL: selection.serviceRoot,
    AW_API_DEPOT_NAME: selection.library,
    AW_API_CREDENTIAL_FILE: credentialFile,
    AW_DOWNLOAD_ORIGINS: origins.compactJson,
    FBX2GLTF_BIN: resolve4(cache, "bin", "FBX2glTF"),
    MCP_SHARED_PATH: resolve4(quarantine, "workspace"),
    MCP_WORKSPACE_ROOT: resolve4(quarantine, "workspace"),
    MCP_GAME_RUNTIME_ROOT: resolve4(quarantine, "game-runtime")
  }, { queries: options.queries, output_dir: "workspace/asset3d", output_format: "glb" });
  const result = parseProviderResult(payload, ASSET3D_PROVIDER_COMMIT, origins.digest);
  if (result.total !== options.queries.length || result.results.some((item) => item.query !== options.queries[item.queryIndex]))
    throw new Error("asset_library_query_identity_mismatch");
  validateLibrarySources(sourceRoot, result.results.filter((item) => item.status === "ok"));
  const receipt = { schemaVersion: "forgeax.host-library-sources/1.0.0", execution, library: selection.library, providerCommit: ASSET3D_PROVIDER_COMMIT, sourceRoot, result };
  atomicWrite(resolve4(quarantine, "receipt.json"), `${JSON.stringify(receipt, null, 2)}
`);
  return receipt;
}

// src/game/asset-library/host-worker.ts
try {
  parentPort.postMessage({ value: await searchLibrarySources(workerData) });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : "asset_library_failed" });
}
