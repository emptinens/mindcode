export type ForegroundAgentStep<T, TReturn> =
  | {
      type: "message";
      result: IteratorResult<T, TReturn>;
    }
  | {
      type: "background";
      pendingMessage: Promise<IteratorResult<T, TReturn>>;
    };

/**
 * Arbitrates the single foreground-to-background transition for an agent.
 *
 * The AppState check deliberately runs after Promise.race. It gives a
 * background request priority when the request and a final iterator result
 * settle in the same turn, so a completed stream cannot strand a task in the
 * running/backgrounded state.
 */
export class ForegroundAgentHandoff {
  private backgroundEvent: Promise<{ type: "background" }> | undefined;
  private handoffStarted = false;

  constructor(backgroundSignal?: Promise<void>) {
    this.backgroundEvent = backgroundSignal?.then(() => ({
      type: "background" as const,
    }));
  }

  async next<T, TReturn>(
    pendingMessage: Promise<IteratorResult<T, TReturn>>,
    isBackgrounded: () => boolean,
  ): Promise<ForegroundAgentStep<T, TReturn>> {
    if (this.handoffStarted || !this.backgroundEvent) {
      return {
        type: "message",
        result: await pendingMessage,
      };
    }

    const winner = await Promise.race([
      pendingMessage.then(
        (result) => ({
          type: "message" as const,
          result,
        }),
        (error: unknown) => ({
          type: "message_error" as const,
          error,
        }),
      ),
      this.backgroundEvent,
    ]);

    if (winner.type === "background" || isBackgrounded()) {
      this.handoffStarted = true;
      // A resolved background promise must never participate in another race.
      this.backgroundEvent = undefined;
      return {
        type: "background",
        pendingMessage,
      };
    }

    if (winner.type === "message_error") {
      throw winner.error;
    }

    return winner;
  }
}
