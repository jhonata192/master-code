import { spawn } from 'node:child_process';
import { platform } from 'node:os';

export function openUrlInBrowser(url: string): boolean {
  try {
    let cmd: string;
    let args: string[];
    const p = platform();
    if (p === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '""', url];
    } else if (p === 'darwin') {
      cmd = 'open';
      args = [url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
