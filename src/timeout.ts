/**
 * Reject if a promise has not settled within `ms`.
 *
 * This exists because a promise that never settles is invisible: no error, no
 * status change, nothing in the console. A dynamic `import()` in poi's renderer
 * behaves that way, and it left the plugin sitting at "stopped" with no way to
 * tell why.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    // Never hold the event loop open on the timer's account.
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}
