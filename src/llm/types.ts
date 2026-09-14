/** The brain, behind a port. Everything above this line is deterministic and
 *  testable without credentials; everything below it needs a Whissle key. */
export interface LlmPort {
  /**
   * A production reply turn against the agent's own persona + knowledge base,
   * with this turn's grounding injected as ephemeral `context`.
   */
  chatTurn(message: string, context: string, opts?: { maxTokens?: number }): Promise<string>;

  /**
   * The same turn, narrated while it happens.
   *
   * `onDelta` receives the reply as it is generated. The RETURN value is still
   * the complete reply, and that is what the guardrail chain judges — streaming
   * shortens time-to-first-token in the operator's view, never time-to-send. A
   * partially generated reply has not been checked and must never be sendable.
   */
  chatTurnStream(
    message: string,
    context: string,
    onDelta: (text: string, full: string) => void,
    opts?: { maxTokens?: number },
  ): Promise<string>;

  /**
   * A utility turn with a bespoke system prompt, for internal JSON work
   * (rolling show context, intent classification) that the seller persona would
   * otherwise fight.
   */
  utilityTurn(system: string, user: string, opts?: { maxTokens?: number }): Promise<string>;

  readonly name: string;
}

export class LlmError extends Error {
  constructor(public status: number, public detail: string) {
    super(`llm ${status}: ${detail.slice(0, 240)}`);
  }
  /** The gateway runs a shared 8-wide LLM semaphore and 429s a burst. The
   *  fan-out worker backs off on this rather than dropping the question. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }
  get isOutOfCredit(): boolean {
    return this.status === 402;
  }
}
