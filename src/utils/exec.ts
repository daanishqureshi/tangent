import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(_execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a command with a timeout. Uses execFile (not exec/shell) to avoid shell
 * injection.  Args must be passed as a separate array.
 *
 * @param file   Executable name or path (e.g. "docker", "git")
 * @param args   Arguments array
 * @param opts.timeoutMs  Max runtime in ms (default 5 minutes)
 * @param opts.cwd        Working directory
 * @param opts.env        Additional env vars merged with process.env
 */
export async function execCommand(
  file: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; env?: Record<string, string> } = {},
): Promise<ExecResult> {
  const { timeoutMs = 5 * 60 * 1000, cwd, env } = opts;

  const { stdout, stderr } = await execFileAsync(file, args, {
    timeout: timeoutMs,
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 50 * 1024 * 1024, // 50 MB — docker build output can be large
  });

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}
