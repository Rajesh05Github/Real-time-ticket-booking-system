import type { SeatGenerationAssignment } from '../queues/queue-names.js';

export interface SeatRow {
  eventId: string;
  sectionId: string;
  seatCode: string;
  priceMinor: number;
  currency: string;
}

/**
 * Pure expansion of "N seats named PREFIX+start..PREFIX+start+N-1" into
 * concrete row objects -- no database access. Lives in @flashsale/shared
 * (not apps/api or apps/worker) specifically so BOTH the synchronous
 * creation path (apps/api, for small requests) and the background job
 * (apps/worker, for large ones) expand assignments identically. Without
 * a single shared implementation, the two paths could silently drift --
 * e.g. one off-by-one in a hand-copied loop producing A0..A99 on one
 * path and A1..A100 on the other for what the admin intended as the same
 * request.
 */
export function buildSeatRows(eventId: string, assignments: SeatGenerationAssignment[]): SeatRow[] {
  const rows: SeatRow[] = [];
  for (const assignment of assignments) {
    for (let offset = 0; offset < assignment.seatCount; offset += 1) {
      rows.push({
        eventId,
        sectionId: assignment.sectionId,
        seatCode: `${assignment.seatCodePrefix}${assignment.startNumber + offset}`,
        priceMinor: assignment.priceMinor,
        currency: assignment.currency,
      });
    }
  }
  return rows;
}
