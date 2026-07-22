export interface KinoEnvelope<T> {
  code: number;
  message: string;
  data: T;
  error_code?: string;
}

export type KinoMediaType = 'image' | 'video';

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
