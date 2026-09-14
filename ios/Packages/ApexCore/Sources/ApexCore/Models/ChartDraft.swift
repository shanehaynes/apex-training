import Foundation

/// `ChartDraft` from `src/lib/analytics/draft.ts` — the tile builder's form
/// state, in the exact JSON the server reduces (`POST /api/coach-tool
/// update_chart_draft`), previews (`POST /api/analytics-compute { drafts }`)
/// and saves (`POST /api/analytics-tiles { draft }`). Numeric fields are
/// strings deliberately: an input must be clearable; the server parses.
/// Enum-like fields are plain strings so a value the web adds still decodes.
///
/// A dumb mirror: constructors and nothing else. Validation, draft→spec and
/// spec→draft run server-side (D-008, D-028) — the live preview's problem
/// slot carries the same `chartDraftProblem` text the web shows.
public struct ChartDraft: Codable, Sendable, Equatable {
    public var title: String
    /// line · bar · stacked-bar · area · kpi · table
    public var chartType: String
    /// rolling · fixed · preset
    public var rangeKind: String
    public var rollingDays: String
    public var startDate: String
    /// INCLUSIVE in the form (what a person means by "to"); the spec stores exclusive.
    public var endDate: String
    public var preset: String
    /// day · week · iso-month · total (a kpi is stored as total by the server)
    public var bucket: String
    /// mi · km · m · ft, or `""` for as logged.
    public var displayUnit: String
    public var series: [SeriesDraft]

    public init(
        title: String, chartType: String, rangeKind: String, rollingDays: String, startDate: String, endDate: String,
        preset: String, bucket: String, displayUnit: String, series: [SeriesDraft]
    ) {
        self.title = title
        self.chartType = chartType
        self.rangeKind = rangeKind
        self.rollingDays = rollingDays
        self.startDate = startDate
        self.endDate = endDate
        self.preset = preset
        self.bucket = bucket
        self.displayUnit = displayUnit
        self.series = series
    }

    /// `emptyChartDraft()`: a line chart over the last 90 days, weekly, one series.
    public static var empty: ChartDraft {
        ChartDraft(
            title: "", chartType: "line", rangeKind: "rolling", rollingDays: "90", startDate: "", endDate: "",
            preset: "this-iso-month", bucket: "week", displayUnit: "", series: [.empty(id: "s1")]
        )
    }

    /// The next unused `s<n>`.
    public func nextSeriesId() -> String {
        let used = Set(series.map(\.id))
        var n = 1
        while used.contains("s\(n)") { n += 1 }
        return "s\(n)"
    }

    public func jsonValue() throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(self))
    }

    public init(jsonValue: JSONValue) throws {
        self = try JSONDecoder().decode(ChartDraft.self, from: JSONEncoder().encode(jsonValue))
    }
}

/// One series of the draft (`SeriesDraft`). `""` means unset: the measure's
/// default aggregation, no split, the auto label, no grade scale, no axis.
public struct SeriesDraft: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var label: String
    public var measure: String
    public var agg: String
    public var eventTypes: [String]
    public var sports: [String]
    public var workoutTitles: [String]
    public var exerciseNames: [String]
    public var categories: [String]
    public var mealTypes: [String]
    public var gradeScale: String
    public var dayFilterTypes: [String]
    public var dayFilterOffset: String
    /// include · exclude
    public var dayFilterMode: String
    public var groupBy: String
    public var groupLimit: String
    /// left · right · ""
    public var axis: String

    public init(
        id: String, label: String = "", measure: String = "", agg: String = "", eventTypes: [String] = [],
        sports: [String] = [], workoutTitles: [String] = [], exerciseNames: [String] = [], categories: [String] = [],
        mealTypes: [String] = [], gradeScale: String = "", dayFilterTypes: [String] = [], dayFilterOffset: String = "0",
        dayFilterMode: String = "include", groupBy: String = "", groupLimit: String = "", axis: String = ""
    ) {
        self.id = id
        self.label = label
        self.measure = measure
        self.agg = agg
        self.eventTypes = eventTypes
        self.sports = sports
        self.workoutTitles = workoutTitles
        self.exerciseNames = exerciseNames
        self.categories = categories
        self.mealTypes = mealTypes
        self.gradeScale = gradeScale
        self.dayFilterTypes = dayFilterTypes
        self.dayFilterOffset = dayFilterOffset
        self.dayFilterMode = dayFilterMode
        self.groupBy = groupBy
        self.groupLimit = groupLimit
        self.axis = axis
    }

    /// `emptySeriesDraft(id)`.
    public static func empty(id: String) -> SeriesDraft { SeriesDraft(id: id) }
}
