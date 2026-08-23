import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when `moduleUrl` is the module Node was started with.
 *
 * Comparing `process.argv[1]` by filename is not enough: an npm `bin` entry is
 * installed as a symlink named after the command (`mt2mx`), not after the file
 * it points at, so a filename test silently turns the CLI into a no-op when it
 * is installed globally. Resolving both sides to a real path handles the
 * symlink, a direct `node dist/src/cli/main.js`, and `npm link` alike.
 */
export function isEntryPoint(moduleUrl: string): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/**
 * Stop a closed pipe from crashing the process.
 *
 * `mt2mx list | head -4` closes stdout as soon as head has what it wants; the
 * next write raises EPIPE, which Node turns into an unhandled error event. A
 * command line tool is expected to end quietly instead.
 */
export function ignoreBrokenPipe(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') process.exit(0);
      throw error;
    });
  }
}
