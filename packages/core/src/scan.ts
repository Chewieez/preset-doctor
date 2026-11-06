/**
 * One scan of a Bambu Studio folder for one account: reads the system index, the account's
 * presets and BambuStudio.conf, runs every rule and summarizes each preset as a table row.
 * Only reads; never writes.
 */
import { readStudioConf, STUDIO_CONF_PATH } from './conf.js';
import type { PresetFs } from './fs.js';
import { buildUserIndex, userInherits } from './resolve.js';
import type { RuleContext } from './rules/context.js';
import { checkR1, displayName, R1_ID, userCandidateNames } from './rules/r1.js';
import { checkR4 } from './rules/r4.js';
import { loadSystemIndexes, SystemIndexError, type SystemIndex } from './systemIndex.js';
import {
  RULE_IDS,
  type Finding,
  type PresetStatus,
  type PresetSummary,
  type ScanResult,
  type Severity,
  type UserPreset,
} from './types.js';
import { listAccounts, scanUser } from './userScan.js';

export const R5_ID = RULE_IDS.cloudSync;

export interface ScanOptions {
  /** Account folder to scan. Default: the one with the most presets. */
  userId?: string;
  /** Shown as ScanResult.root. Default: the adapter's `root` property when it has one. */
  root?: string;
}

/** The folder can't be scanned at all (not a Studio folder, unknown account). */
export class ScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScanError';
  }
}

const STATUS_RANK: Record<PresetStatus, number> = { ok: 0, info: 1, hidden: 2, broken: 3 };
const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2 };

export async function scan(fs: PresetFs, options: ScanOptions = {}): Promise<ScanResult> {
  const root = options.root ?? rootOf(fs);
  const warnings: string[] = [];
  const accounts = await listAccounts(fs);

  let system: SystemIndex | null = null;
  try {
    system = await loadSystemIndexes(fs);
  } catch (err) {
    if (!(err instanceof SystemIndexError)) throw err;
    warnings.push(`${err.message} Missing parent presets can't be checked without it.`);
  }
  if (!system && accounts.length === 0) {
    throw new ScanError(
      `${root || 'This folder'} doesn't look like a Bambu Studio data folder: no system ` +
        'preset index (system/BBL.json) was found, and there is no user folder.',
    );
  }

  const userId = options.userId ?? accounts[0]?.id ?? '';
  if (options.userId !== undefined && !accounts.some((a) => a.id === options.userId)) {
    const known = accounts.map((a) => a.id).join(', ') || 'none';
    throw new ScanError(`There is no account folder "${options.userId}". Found: ${known}.`);
  }
  if (userId === '') warnings.push('No user presets were found in this folder.');

  const presets = userId === '' ? [] : await scanUser(fs, userId);
  const findings: Finding[] = [];

  const conf = await readStudioConf(fs);
  if (conf.syncUserPreset === true) findings.push(cloudSyncFinding());
  else if (conf.error !== undefined && conf.syncUserPreset === undefined) {
    // Sync may well be on: say so, rather than staying as quiet as when it is off.
    warnings.push(
      `${conf.error} Preset Doctor could not tell whether cloud preset sync is on; turn it off ` +
        'in Bambu Studio before repairing.',
    );
  }

  const ctx: RuleContext | null = system
    ? { system, presets, resolve: { system, userByName: buildUserIndex(presets) } }
    : null;

  // R1 runs first, so R4 won't rename a preset that R1 suggests as someone's new parent.
  const r1s = new Map<UserPreset, Finding>();
  if (ctx) {
    for (const preset of presets) {
      const r1 = await checkR1(preset, ctx);
      if (r1) r1s.set(preset, r1);
    }
  }
  const r4ctx = {
    presets,
    suggestedParents: userCandidateNames([...r1s.values()]),
    ...(system ? { system } : {}),
  };

  const summaries: PresetSummary[] = [];
  for (const preset of presets) {
    const own: Finding[] = [];
    const r1 = r1s.get(preset);
    if (r1) own.push(r1);
    own.push(...checkR4(preset, r4ctx));
    findings.push(...own);
    summaries.push(summarize(preset, own, system !== null));
  }

  if (system) warnings.push(...system.warnings);
  return {
    root,
    userId,
    accounts,
    presets: summaries,
    findings,
    warnings,
    systemVersion: system?.version ?? null,
    systemIndexRead: system !== null,
  };
}

function cloudSyncFinding(): Finding {
  return {
    ruleId: R5_ID,
    severity: 'warning',
    presetPath: STUDIO_CONF_PATH,
    status: 'info',
    title: 'Cloud preset sync is on',
    explanation:
      'Turn off preset sync or log out of Bambu Studio before repairing, or the cloud copy may ' +
      'undo the fix.',
  };
}

/** `parentsChecked` is false when no system index could be read, so R1 did not run. */
function summarize(
  preset: UserPreset,
  findings: Finding[],
  parentsChecked: boolean,
): PresetSummary {
  const worst = [...findings].sort(
    (a, b) =>
      STATUS_RANK[b.status] - STATUS_RANK[a.status] ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  )[0];
  const inherits = preset.json ? userInherits(preset) : undefined;
  // Without the system index a parent was never checked, so don't call the preset OK; that
  // matters more than any note, but less than a real problem.
  const unchecked =
    !parentsChecked &&
    inherits !== undefined &&
    inherits !== '' &&
    (worst === undefined || STATUS_RANK[worst.status] <= STATUS_RANK.info);
  const summary: PresetSummary = {
    accountId: preset.accountId,
    path: preset.path,
    fileStem: preset.fileStem,
    isBase: preset.isBase,
    status: unchecked ? 'info' : (worst?.status ?? 'ok'),
    reason: unchecked
      ? `Parent "${inherits}" could not be checked (system presets unreadable)`
      : worst
        ? reasonFor(worst, inherits)
        : okReason(inherits),
    ruleIds: [...new Set(findings.map((f) => f.ruleId))],
  };
  if (preset.json) summary.name = displayName(preset);
  if (inherits !== undefined) summary.inherits = inherits;
  return summary;
}

function reasonFor(f: Finding, inherits: string | undefined): string {
  // Direct orphans name the missing parent; hidden children of orphans keep the title.
  if (f.ruleId === R1_ID && f.severity === 'error' && f.status === 'hidden' && inherits) {
    return `Parent "${inherits}" is missing`;
  }
  return f.title;
}

function okReason(inherits: string | undefined): string {
  return inherits ? `Based on "${inherits}"` : 'Custom filament, not based on another preset';
}

function rootOf(fs: PresetFs): string {
  const r = (fs as { root?: unknown }).root;
  return typeof r === 'string' ? r : '';
}
