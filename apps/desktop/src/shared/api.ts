/**
 * The UI contract lives in @preset-doctor/ui (shared with the web version); this file adds the
 * desktop's IPC channel names. Type-only re-exports, so the sandboxed preload bundle stays tiny.
 */
import type { CoreApiCall } from '@preset-doctor/ui/contract';

export type * from '@preset-doctor/ui/contract';

export const CHANNELS = {
  getConfig: 'pd:get-config',
  scan: 'pd:scan',
  plan: 'pd:plan',
  apply: 'pd:apply',
  listBackups: 'pd:list-backups',
  restore: 'pd:restore',
  studioStatus: 'pd:studio-status',
  pickFolder: 'pd:pick-folder',
  openBackupsFolder: 'pd:open-backups-folder',
  openDonationPage: 'pd:open-donation-page',
} as const satisfies Record<CoreApiCall, string>;
