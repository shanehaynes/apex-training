import Foundation

/// One `activity_streams` row, read directly through Supabase under the
/// per-user SELECT policy (the schedule payload never carries it). Keyed by
/// occurrence id + date; absence is the normal case and is silent. Presence is
/// the authoritative "synced" signal — a provider-filled planned occurrence
/// has no `source` on its base.
public struct ActivityStreamRecord: Codable, Sendable, Equatable {
    public let provider: String
    public let summary: Summary
    public let streams: Streams?

    public init(provider: String, summary: Summary, streams: Streams?) {
        self.provider = provider
        self.summary = summary
        self.streams = streams
    }

    /// The keys `SyncMetrics.tsx` reads; the row carries more (`sport`,
    /// `startUtc`, `hrZones`, …) which decode ignores.
    public struct Summary: Codable, Sendable, Equatable {
        public let sportLabel: String?
        public let avgHr: Double?
        public let maxHr: Double?
        public let calories: Double?
        public let distanceMeters: Double?
        public let elevationGainMeters: Double?
        public let trainingLoad: Double?

        public init(sportLabel: String? = nil, avgHr: Double? = nil, maxHr: Double? = nil, calories: Double? = nil,
                    distanceMeters: Double? = nil, elevationGainMeters: Double? = nil, trainingLoad: Double? = nil) {
            self.sportLabel = sportLabel
            self.avgHr = avgHr
            self.maxHr = maxHr
            self.calories = calories
            self.distanceMeters = distanceMeters
            self.elevationGainMeters = elevationGainMeters
            self.trainingLoad = trainingLoad
        }
    }

    /// `hr: [sec, bpm][]`, `gps: [sec, lat, lon, elevationMeters?][]` —
    /// tuples on the wire, downsampled server-side to ~2000 points.
    public struct Streams: Codable, Sendable, Equatable {
        public let hr: [[Double]]?
        public let gps: [[Double]]?

        public init(hr: [[Double]]?, gps: [[Double]]?) {
            self.hr = hr
            self.gps = gps
        }
    }

    public struct HRSample: Sendable, Equatable {
        public let seconds: Double
        public let bpm: Double
    }

    public struct GPSSample: Sendable, Equatable {
        public let seconds: Double
        public let latitude: Double
        public let longitude: Double
        public let elevationMeters: Double?
    }

    public var hrSamples: [HRSample] {
        (streams?.hr ?? []).compactMap { $0.count >= 2 ? HRSample(seconds: $0[0], bpm: $0[1]) : nil }
    }

    public var gpsSamples: [GPSSample] {
        (streams?.gps ?? []).compactMap {
            $0.count >= 3 ? GPSSample(seconds: $0[0], latitude: $0[1], longitude: $0[2],
                                      elevationMeters: $0.count >= 4 ? $0[3] : nil) : nil
        }
    }
}

/// How a feature reads a streams row; `ApexAuth` implements it over
/// supabase-swift, the mock client over a fixture.
public protocol ActivityStreamsReading: Sendable {
    func record(eventId: String, eventDate: String) async throws -> ActivityStreamRecord?
}

public struct SyncMetricItem: Sendable, Equatable {
    public enum Kind: Sendable { case heartRate, distance, elevation, calories, load }
    public let kind: Kind
    public let text: String
}

/// The badge strip in `SyncMetrics.tsx`, value for value: bpm as `avg/max`,
/// metres → miles to two places, metres → whole feet, calories, training load.
/// Zero and nil are both "not measured" (the web's truthiness check).
public enum SyncMetricsFormatter {
    public static func providerLabel(_ provider: String) -> String {
        provider == "coros" ? "COROS" : provider
    }

    public static func items(_ s: ActivityStreamRecord.Summary) -> [SyncMetricItem] {
        var items: [SyncMetricItem] = []
        if let avg = s.avgHr, avg != 0 {
            let max = s.maxHr.flatMap { $0 != 0 ? "/\(whole($0))" : nil } ?? ""
            items.append(.init(kind: .heartRate, text: "\(whole(avg))\(max) bpm"))
        }
        if let m = s.distanceMeters, m != 0 {
            items.append(.init(kind: .distance, text: String(format: "%.2f mi", m / 1609.344)))
        }
        if let m = s.elevationGainMeters, m != 0 {
            items.append(.init(kind: .elevation, text: "\(Int((m * 3.28084).rounded())) ft"))
        }
        if let c = s.calories, c != 0 {
            items.append(.init(kind: .calories, text: "\(whole(c)) cal"))
        }
        if let l = s.trainingLoad, l != 0 {
            items.append(.init(kind: .load, text: "Load \(whole(l))"))
        }
        return items
    }

    /// JavaScript prints `150` for 150 and `150.5` for 150.5; so does this.
    static func whole(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(value)
    }
}

/// Keep a series drawable: the server already caps at ~2000 points, a chart
/// 96pt tall needs far fewer.
public enum StreamDownsample {
    public static func stride<T>(_ samples: [T], maxCount: Int) -> [T] {
        guard maxCount > 1, samples.count > maxCount else { return samples }
        let step = Double(samples.count - 1) / Double(maxCount - 1)
        var out: [T] = (0..<maxCount).map { samples[Int((Double($0) * step).rounded())] }
        out[out.count - 1] = samples[samples.count - 1]
        return out
    }
}
