export function settleWithFallback<T>(
  promise: Promise<T>,
  fallback: T,
  timeoutMs: number,
): Promise<T> {
  return new Promise(resolve => {
    let settled = false
    const finish = (value: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(finish, timeoutMs, fallback)
    void promise.then(finish, () => finish(fallback))
  })
}
