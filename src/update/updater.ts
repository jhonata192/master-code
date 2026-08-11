import { spawn } from 'node:child_process';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { runInstallerSilent } from './installer.js';
import { appendLog } from './updateLog.js';

export const UPDATE_FLAG = '--update-apply';

export interface UpdaterArgs {
  installerPath: string;
  parentPid: number;
  restartExe: string;
  fromVersion: string;
}

export function isUpdaterInvocation(argv: string[]): boolean {
  return argv.includes(UPDATE_FLAG);
}

export function parseUpdaterArgs(argv: string[]): UpdaterArgs | null {
  const idx = argv.indexOf(UPDATE_FLAG);
  if (idx < 0) return null;
  const [installerPath, parentPid, restartExe, fromVersion] = argv.slice(idx + 1);
  if (!installerPath || !restartExe) return null;
  return {
    installerPath,
    parentPid: Number(parentPid) || 0,
    restartExe,
    fromVersion: fromVersion ?? '0.0.0',
  };
}

function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (!pid) return resolve();
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (!alive || Date.now() > deadline) return resolve();
      setTimeout(tick, 300);
    };
    tick();
  });
}

export async function runUpdater(args: UpdaterArgs): Promise<number> {
  const updaterExe = process.execPath;
  try {
    await appendLog('update-apply', {
      from: args.fromVersion,
      installer: args.installerPath,
      restart: args.restartExe,
      updater: updaterExe,
      state: 'aguardando encerramento do master-code',
    });

    await waitForExit(args.parentPid, 60000);

    await appendLog('update-apply', { state: 'executando instalador' });
    const code = runInstallerSilent(args.installerPath);
    if (code !== 0) {
      await appendLog('update-apply', { state: 'falha', installerExitCode: String(code) });
      return code;
    }

    await appendLog('update-apply', { state: 'instalacao ok', restarting: args.restartExe });
    const child = spawn(args.restartExe, [], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return 0;
  } finally {
    if (path.basename(updaterExe).toLowerCase() === 'master-code-updater.exe') {
      await rm(updaterExe, { force: true }).catch(() => {});
    }
  }
}
