export interface KinoEnvelope<T> {
  code: number;
  message: string;
  data: T;
  error_code?: string;
}

export type KinoMediaType = 'image' | 'video' | 'audio' | 'font';

export type KinoResourceType =
  | 'KEYFRAME'
  | 'SHOT_VIDEO'
  | 'CHARACTER_IMAGE'
  | 'CHARACTER_TURNAROUND'
  | 'LOCATION_IMAGE'
  | 'PROJECT_COVER_IMAGE'
  | 'UPLOAD'
  | 'OTHER'
  | 'GENERATION';

export interface KinoResourceSourceMeta {
  task_id?: string;
  prompt?: string;
  model?: string;
  seed?: number;
  width?: number;
  height?: number;
  duration_ms?: number;
  mime_type?: string;
  extra?: Record<string, unknown>;
}

export interface KinoResourceDTO {
  resource_id: string;
  game_id: string;
  media_type: KinoMediaType;
  name?: string;
  type?: KinoResourceType;
  url: string;
  remark?: string;
  source?: string;
  source_meta?: KinoResourceSourceMeta;
  created_at: number;
  updated_at: number;
}

export interface KinoResourcePage {
  items: KinoResourceDTO[];
  total: number;
  page: number;
  page_size: number;
}

export interface KinoImportProjectDTO {
  game_id: string;
  game_name?: string;
  name?: string;
  cover_url?: string;
  resource_count?: number;
  asset_count?: number;
  updated_at?: number;
}

export interface KinoImportProjectPage {
  items: KinoImportProjectDTO[];
  total: number;
}

/**
 * Short-lived credentials returned by Kino's documented
 * `POST /api/v1/kino/image-assets/upload` endpoint. The browser uses these
 * only for a direct COS PUT; they are never persisted by Workbench.
 */
export interface KinoImageUploadSts {
  tmp_secret_id: string;
  tmp_secret_key: string;
  session_token: string;
  expiration: string;
  bucket: string;
  bucket_url: string;
  region: string;
  prefix: string;
  object_key: string;
  allowed_extensions: string[];
  allowed_content_types: string[];
  max_file_size_bytes: number;
  required_headers: Record<string, string>;
}

export interface CreateKinoResourceInput {
  game_id: string;
  media_type: KinoMediaType;
  url: string;
  name?: string;
  type?: KinoResourceType;
  remark?: string;
  source?: string;
  source_meta?: KinoResourceSourceMeta;
}

export interface UpdateKinoResourceInput {
  resource_id: string;
  game_id: string;
  media_type: KinoMediaType;
  url: string;
  name?: string;
  type?: KinoResourceType;
  remark?: string;
  source?: string;
  source_meta?: KinoResourceSourceMeta;
}

export interface BatchCreateKinoResourcesInput {
  game_id: string;
  resources: Array<Omit<CreateKinoResourceInput, 'game_id'>>;
}

export interface BatchCreateKinoResourcesResult {
  created_count: number;
  skipped_count: number;
  items: KinoResourceDTO[];
}

export class KinoApiError extends Error {
  readonly status: number;
  readonly errorCode?: string;

  constructor(message: string, status: number, errorCode?: string) {
    super(message);
    this.name = 'KinoApiError';
    this.status = status;
    this.errorCode = errorCode;
  }
}
