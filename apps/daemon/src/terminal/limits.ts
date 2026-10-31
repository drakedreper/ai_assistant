/** A token bucket: `capacity` tokens, refilled at `perSecond`. Pure, with an injected clock. */
export class TokenBucket {
  private tokens: number
  private last: number

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    private readonly now: () => number,
  ) {
    this.tokens = capacity
    this.last = now()
  }

  /** Take `cost` tokens. False (and nothing taken) when there are not enough. */
  take(cost: number): boolean {
    const t = this.now()
    const elapsed = Math.max(0, t - this.last)
    this.last = t
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.perSecond)
    if (cost > this.tokens) return false
    this.tokens -= cost
    return true
  }
}
