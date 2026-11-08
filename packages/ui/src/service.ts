/**
 * Building blocks for the two implementations of PresetDoctorApi: the desktop main process
 * (apps/desktop/src/main/service.ts) and the web version (apps/web/src/browserDoctor.ts), so both
 * validate requests and word their refusals the same way.
 *
 * Not for the UI or the desktop preload: unlike the rest of this package, it imports core at
 * runtime.
 */
import {
  ApplyError,
  BackupCoverageError,
  BackupSlicerError,
  BackupSourceError,
  errorMessage,
  FixError,
  RestoreError,
  StaleChangeError,
  unifiedDiff,
  type Change,
  type FixChoice,
} from '@preset-doctor/core';
import type { IpcError, IpcErrorCode, IpcResult, PlanOptions, PlanPayload } from './contract';

/** A request turned down on purpose; becomes an IpcError with this code. */
export class Refusal extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
    readonly extra: Partial<IpcError> = {},
  ) {
    super(message);
  }
}

export function invalid(message: string): Refusal {
  return new Refusal('invalid', message);
}

/** A planned file changed since the scan; nothing was written. */
export function staleRefusal(): Refusal {
  return new Refusal(
    'stale',
    'Some files changed since the scan, so nothing was written. Scan again and retry.',
  );
}

/** Validates the fix selection the UI sent (it crosses IPC, so it is untrusted). */
export function parseChoices(value: unknown): FixChoice[] {
  if (!Array.isArray(value)) throw invalid('Bad fix selection.');
  return value.map((v: unknown) => {
    const c = v as Partial<Record<keyof FixChoice, unknown>> | null;
    if (!c || typeof c.presetPath !== 'string') throw invalid('Bad fix selection.');
    const choice: FixChoice = { presetPath: c.presetPath };
    if (typeof c.candidateName === 'string') choice.candidateName = c.candidateName;
    if (c.rename === true) choice.rename = true;
    if (c.allNozzles === true) choice.allNozzles = true;
    return choice;
  });
}

/** base_id is updated unless the UI explicitly turned it off. */
export function parsePlanOptions(value: unknown): { updateBaseId: boolean } {
  return { updateBaseId: (value as Partial<PlanOptions> | null)?.updateBaseId !== false };
}

/** Maps an error a platform knows more about (e.g. a browser permission error); else undefined. */
export type ErrorMapper = (err: unknown) => IpcError | undefined;

/** Runs `fn` and turns its result or error into an IpcResult. Never throws. */
export async function run<T>(
  fn: () => Promise<T> | T,
  mapOther?: ErrorMapper,
): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof Refusal) {
      return { ok: false, error: { code: err.code, message: err.message, ...err.extra } };
    }
    if (err instanceof FixError) {
      return {
        ok: false,
        error: { code: err.stale ? 'stale' : 'invalid', message: err.message },
      };
    }
    const mapped = mapOther?.(err);
    if (mapped) return { ok: false, error: mapped };
    return { ok: false, error: { code: 'failed', message: errorMessage(err) } };
  }
}

/** Runs writes (apply, restore) one at a time, each through run(). */
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly mapOther?: ErrorMapper) {}

  run<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
    const next = this.tail.then(() => run(fn, this.mapOther));
    this.tail = next;
    return next;
  }
}

const MAX_PLANS = 50;

/** Previews the UI may still apply, each tied to the folder it was planned for (`key`). */
export class PlanStore<K> {
  private readonly plans = new Map<string, { key: K; changes: Change[] }>();

  /** Keeps the plan under `id` (dropping the oldest beyond 50) and returns it for the UI. */
  add(key: K, changes: Change[], id: string): PlanPayload {
    this.plans.set(id, { key, changes });
    while (this.plans.size > MAX_PLANS) this.plans.delete(this.plans.keys().next().value!);
    return {
      planId: id,
      changes: changes.map((c) => ({
        path: c.path,
        description: c.description,
        diff: unifiedDiff(c),
      })),
    };
  }

  get(id: unknown): { key: K; changes: Change[] } | undefined {
    return typeof id === 'string' ? this.plans.get(id) : undefined;
  }

  clear(): void {
    this.plans.clear();
  }
}

/** The refusal for an error from checking the backup or applying changes; undefined for others. */
export function applyFailure(err: unknown, backupId: string): Refusal | undefined {
  if (err instanceof BackupCoverageError) return new Refusal('failed', err.message);
  if (err instanceof StaleChangeError) return staleRefusal();
  if (err instanceof ApplyError) {
    return new Refusal(
      'partial',
      `${err.message}. Some files were already changed; restore backup ${backupId} to undo.`,
      { written: err.written, backupId },
    );
  }
  return undefined;
}

/** The refusal for an error from a restore; undefined for others. */
export function restoreFailure(err: unknown): Refusal | undefined {
  if (err instanceof BackupSourceError) return new Refusal('other-source', err.message);
  if (err instanceof BackupSlicerError) return new Refusal('other-slicer', err.message);
  if (err instanceof RestoreError) {
    // Say which backup undoes the part that was done.
    return new Refusal(
      'partial',
      err.message +
        (err.safetyBackup ? '' : ' Restore the same backup again once the problem is fixed.'),
      {
        written: err.restored,
        ...(err.safetyBackup ? { backupId: err.safetyBackup.id } : {}),
      },
    );
  }
  return undefined;
}
