/**
 * Small FIFO concurrency gate used for native process fan-out.
 *
 * A released slot is handed directly to the oldest waiter. Keeping the active
 * count unchanged during that hand-off prevents a newly arriving task from
 * barging in and temporarily exceeding the configured limit.
 * @module
 */

/** Wrap asynchronous work with a fair, fixed-size concurrency limit. */
export function createConcurrencyLimiter(maxConcurrent: number) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError('maxConcurrent must be a positive integer')
  }

  let active = 0
  const waiters: Array<() => void> = []

  async function acquire(): Promise<void> {
    if (active < maxConcurrent) {
      active++
      return
    }
    await new Promise<void>((resolve) => { waiters.push(resolve) })
    // The releasing task transfers its already-counted slot to this waiter.
  }

  function release(): void {
    const next = waiters.shift()
    if (next === undefined) active--
    else next()
  }

  return async function withLimit<T>(task: () => Promise<T>): Promise<T> {
    await acquire()
    try {
      return await task()
    } finally {
      release()
    }
  }
}
