/** A fixed poll wait of `ms`: no growth, no jitter. */
export const poll = (ms: number) => ({ pollMin: ms, pollMax: ms, pollJitter: 0 });
