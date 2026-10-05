/**
 * Retry `attempt` with exponential backoff (base 500ms, capped at 4s) while it keeps failing with
 * a retryable error, until `deadline`. `attempt` resolves to undefined on success, or an error
 * message on failure; `shouldRetry` decides, from that message, whether the failure is transient.
 */
export async function retryWithBackoff(attempt: () => Promise<string | undefined>, deadline: number, shouldRetry: (err: string) => boolean): Promise<void> {
  for (let n = 0; ; n++) {
    const err = await attempt();
    if (err === undefined) return;
    if (Date.now() >= deadline || !shouldRetry(err)) throw new Error(err);
    const backoff = Math.min(500 * 2 ** n, 4_000, Math.max(deadline - Date.now(), 0));
    await new Promise((r) => setTimeout(r, backoff));
  }
}
