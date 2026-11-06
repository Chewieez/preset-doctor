import type { IpcError, IpcResult, PresetDoctorApi } from './contract';

declare global {
  interface Window {
    presetDoctor: PresetDoctorApi;
  }
}

export const api: PresetDoctorApi = window.presetDoctor;

export class AppError extends Error {
  readonly code: IpcError['code'];
  readonly written: string[] | undefined;
  readonly backupId: string | undefined;

  constructor(error: IpcError) {
    super(error.message);
    this.code = error.code;
    this.written = error.written;
    this.backupId = error.backupId;
  }
}

/** Unwraps an IPC result, throwing AppError on failure. */
export async function call<T>(pending: Promise<IpcResult<T>>): Promise<T> {
  const result = await pending;
  if (result.ok) return result.value;
  throw new AppError(result.error);
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
