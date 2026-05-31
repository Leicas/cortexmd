/**
 * Simple mutex for expensive operations that should not run concurrently.
 * Uses a module-level Map to track which operations are currently running.
 */

const running = new Map<string, boolean>();

/**
 * Attempt to acquire an operation lock.
 * Returns true if the lock was acquired, false if the operation is already running.
 */
export function acquireOperation(name: string): boolean {
  if (running.get(name)) {
    return false;
  }
  running.set(name, true);
  return true;
}

/**
 * Release an operation lock.
 */
export function releaseOperation(name: string): void {
  running.delete(name);
}

/**
 * Check if an operation is currently running.
 */
export function isOperationRunning(name: string): boolean {
  return running.get(name) === true;
}
