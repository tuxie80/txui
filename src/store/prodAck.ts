/**
 * Prod acknowledgment — which prod connections the user has already confirmed
 * THIS app run. Module-level on purpose: it is deliberately not persisted,
 * so every fresh launch re-asks once per connection.
 */
const acked = new Set<string>();

export function isProdAcked(connectionId: string): boolean {
  return acked.has(connectionId);
}

export function ackProd(connectionId: string): void {
  acked.add(connectionId);
}
