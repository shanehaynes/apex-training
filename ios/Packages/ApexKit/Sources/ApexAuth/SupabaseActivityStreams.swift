import ApexCore
import Foundation
import Supabase

/// `activity_streams` through PostgREST under the user's JWT — the same
/// `select('provider, summary, streams')` the web's `SyncMetrics.tsx` makes.
/// Absence is the normal case and comes back as nil, not an error.
public struct SupabaseActivityStreams: ActivityStreamsReading {
    private let client: SupabaseClient

    public init(client: SupabaseClient) {
        self.client = client
    }

    public func record(eventId: String, eventDate: String) async throws -> ActivityStreamRecord? {
        let rows: [ActivityStreamRecord] = try await client
            .from("activity_streams")
            .select("provider, summary, streams")
            .eq("event_id", value: eventId)
            .eq("event_date", value: eventDate)
            .limit(1)
            .execute()
            .value
        return rows.first
    }
}
