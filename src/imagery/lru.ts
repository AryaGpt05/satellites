/**
 * A minimal least-recently-used map. `get` refreshes recency; inserting past `max` evicts the
 * oldest entry. Backed by Map's insertion order, so every operation is O(1).
 */
export class Lru<K, V> {
  private readonly map = new Map<K, V>()
  readonly max: number
  private readonly onEvict?: (key: K, value: V) => void

  constructor(max: number, onEvict?: (key: K, value: V) => void) {
    if (!(max >= 1)) throw new RangeError('Lru max must be ≥ 1')
    this.max = Math.floor(max)
    this.onEvict = onEvict
  }

  get size(): number {
    return this.map.size
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined
    const v = this.map.get(key) as V
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }

  /** Read without touching recency. */
  peek(key: K): V | undefined {
    return this.map.get(key)
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K
      const v = this.map.get(oldest) as V
      this.map.delete(oldest)
      this.onEvict?.(oldest, v)
    }
    return this
  }

  delete(key: K): boolean {
    return this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  keys(): IterableIterator<K> {
    return this.map.keys()
  }
}

/**
 * Memoise an async lookup in an LRU, sharing in-flight promises and forgetting failures
 * (so a transient error is retried next time instead of being cached).
 */
export function memoAsync<V>(cache: Lru<string, Promise<V>>, key: string, load: () => Promise<V>): Promise<V> {
  const hit = cache.get(key)
  if (hit) return hit
  const p = load()
  cache.set(key, p)
  p.catch(() => {
    if (cache.peek(key) === p) cache.delete(key)
  })
  return p
}
