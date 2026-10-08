/** Records handled between two turns of the event loop in a long write. */
export const RECORDS_PER_TURN = 500;

/**
 * Hands the event loop a turn: a national register's publish seals and links
 * a hundred thousand records, and the service's status reads, other feeds'
 * fetches and timers must still run meanwhile.
 */
export function pause(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
