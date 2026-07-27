import type {
  RuntimeAction,
  RuntimeErrorCode,
  RuntimeFailure,
  RuntimeFailureStage,
  RuntimeScope,
} from './types';

export class RuntimeCarrierError extends Error {
  readonly details: RuntimeFailure;

  constructor(details: RuntimeFailure) {
    super(details.message);
    this.name = 'RuntimeCarrierError';
    this.details = details;
  }
}

export function runtimeFailure(input: {
  code: RuntimeErrorCode;
  stage: RuntimeFailureStage;
  retryable: boolean;
  hint: string;
  message: string;
  runtimeId?: string;
  requestedScope?: RuntimeScope;
  occupyingScope?: RuntimeScope | null;
}): RuntimeFailure {
  return { ...input, at: new Date().toISOString() };
}

export function errorForAction(
  action: RuntimeAction,
  input: Omit<Parameters<typeof runtimeFailure>[0], 'stage'>,
) {
  return runtimeFailure({ ...input, stage: action });
}
