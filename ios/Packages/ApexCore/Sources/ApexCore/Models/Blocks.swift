import Foundation

/// `POST /api/query { tool: "get_training_blocks" }` — `api/_lib/mcp/tools/blocks.ts`.
/// Every number on a block (its week count, the current week, every
/// attainment) is computed on the server: `src/lib/blocks` has the tests, so
/// nothing here does date or target arithmetic (D-008). `today` is the
/// caller's local date and is sent on every call — the server has no user
/// time zone, and the fixture would drift daily without it.
public struct TrainingBlocksQueryResult: Codable, Sendable, Equatable {
    public let today: String
    /// The block covering `today`, with its progress unless `block_id` was asked.
    public let current: BlockSummary?
    /// The block named by `block_id`, with its progress.
    public let block: BlockSummary?
    /// Every block, oldest first — only when `scope: "all"`.
    public let blocks: [BlockSummary]?
    /// Every objective — only when `include_objectives`.
    public let objectives: [Objective]?

    /// The list read: every block and objective, no progress (the list needs none).
    public static func args(today: String, includeObjectives: Bool = true) -> [String: JSONValue] {
        [
            "scope": .string("all"),
            "include_progress": .bool(false),
            "include_objectives": .bool(includeObjectives),
            "today": .string(today),
        ]
    }

    /// The detail read: one block's progress, whichever block it is.
    public static func args(blockId: String, today: String) -> [String: JSONValue] {
        ["block_id": .string(blockId), "today": .string(today)]
    }
}

/// One block as the tool summarises it (`blockSummary` in blocks.ts).
public struct BlockSummary: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let intent: String
    /// One of `BlockPhase.all`, or nil. A plain string: the DB CHECK is the truth.
    public let phase: String?
    public let objectiveId: String?
    public let startDate: String
    public let endDateExclusive: String
    public let weeks: Int
    /// 1-based, nil unless `today` falls inside the block.
    public let currentWeek: Int?
    public let weeklyTargets: WeeklyTargets
    public let objective: Objective?
    public let progress: BlockProgress?

    enum CodingKeys: String, CodingKey {
        case id, name, intent, phase, weeks, objective, progress
        case objectiveId = "objective_id"
        case startDate = "start_date"
        case endDateExclusive = "end_date_exclusive"
        case currentWeek = "current_week"
        case weeklyTargets = "weekly_targets"
    }

    public init(
        id: String, name: String, intent: String = "", phase: String? = nil, objectiveId: String? = nil,
        startDate: String, endDateExclusive: String, weeks: Int, currentWeek: Int? = nil,
        weeklyTargets: WeeklyTargets = WeeklyTargets(), objective: Objective? = nil, progress: BlockProgress? = nil
    ) {
        self.id = id
        self.name = name
        self.intent = intent
        self.phase = phase
        self.objectiveId = objectiveId
        self.startDate = startDate
        self.endDateExclusive = endDateExclusive
        self.weeks = weeks
        self.currentWeek = currentWeek
        self.weeklyTargets = weeklyTargets
        self.objective = objective
        self.progress = progress
    }
}

/// An objective (`objectiveSummary` in blocks.ts; the same shape rides on a
/// block's `objective`).
public struct Objective: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    /// One of `ObjectiveDiscipline.all`, or nil.
    public let discipline: String?
    public let targetDate: String?
    public let status: String
    public let notes: String?

    enum CodingKeys: String, CodingKey {
        case id, name, discipline, status, notes
        case targetDate = "target_date"
    }

    public init(id: String, name: String, discipline: String? = nil, targetDate: String? = nil, status: String = "active", notes: String? = nil) {
        self.id = id
        self.name = name
        self.discipline = discipline
        self.targetDate = targetDate
        self.status = status
        self.notes = notes
    }
}

/// The `weekly_targets` JSONB as authored (`src/types/blocks.ts`): camelCase,
/// every key optional, quantities carrying their unit because the repo never
/// converts across units.
public struct WeeklyTargets: Codable, Sendable, Equatable {
    public struct Quantity: Codable, Sendable, Equatable {
        public let value: Double
        public let unit: String
        public init(value: Double, unit: String) {
            self.value = value
            self.unit = unit
        }
    }

    public let cardioMinutes: Double?
    public let vert: Quantity?
    public let distance: Quantity?
    public let strengthSessions: Double?
    public let climbingSessions: Double?
    public let longSessionMinutes: Double?

    public init(
        cardioMinutes: Double? = nil, vert: Quantity? = nil, distance: Quantity? = nil,
        strengthSessions: Double? = nil, climbingSessions: Double? = nil, longSessionMinutes: Double? = nil
    ) {
        self.cardioMinutes = cardioMinutes
        self.vert = vert
        self.distance = distance
        self.strengthSessions = strengthSessions
        self.climbingSessions = climbingSessions
        self.longSessionMinutes = longSessionMinutes
    }

    public var isEmpty: Bool {
        cardioMinutes == nil && vert == nil && distance == nil
            && strengthSessions == nil && climbingSessions == nil && longSessionMinutes == nil
    }
}

/// `computeBlockProgress` as the tool serialises it: snake_case at the top,
/// the attainment rows camelCase because they pass through untouched.
public struct BlockProgress: Codable, Sendable, Equatable {
    public struct ToDate: Codable, Sendable, Equatable {
        public let attainment: [TargetAttainment]
        /// The period's stats totals — a rich shape the phone does not render.
        public let totals: JSONValue?
    }

    public struct Week: Codable, Sendable, Equatable {
        public let index: Int
        public let startDate: String
        public let isComplete: Bool
        public let sessionsCompleted: Int
        public let attainment: [TargetAttainment]

        enum CodingKeys: String, CodingKey {
            case index, attainment
            case startDate = "start_date"
            case isComplete = "is_complete"
            case sessionsCompleted = "sessions_completed"
        }
    }

    public let weeksTotal: Int
    public let weeksElapsed: Int
    /// 1-based in-progress week, nil when the block has not started or has ended.
    public let currentWeek: Int?
    /// Prorated by ELAPSED weeks, not block length.
    public let toDate: ToDate
    public let weeks: [Week]
    public let prs: [BlockRecord]

    enum CodingKeys: String, CodingKey {
        case weeks, prs
        case weeksTotal = "weeks_total"
        case weeksElapsed = "weeks_elapsed"
        case currentWeek = "current_week"
        case toDate = "to_date"
    }
}

/// One target's attainment over a window (`TargetAttainment` in progress.ts).
public struct TargetAttainment: Codable, Sendable, Equatable, Identifiable {
    public var id: String { key }
    public let key: String
    public let label: String
    public let unit: String
    /// Per-week target as authored, or derived from the planned calendar.
    public let target: Double
    /// `"authored"` or `"derived"`.
    public let source: String
    /// target × weeks in the window.
    public let targetForWindow: Double
    public let actual: Double
    /// actual / targetForWindow, or nil when there is no target to divide by.
    public let pct: Double?
    /// Logged quantities in other units, disclosed rather than converted.
    public let unmatchedUnits: [String: Double]?

    public var isDerived: Bool { source == "derived" }
}

/// A personal record set inside the block (`DatedPersonalRecord` in
/// `src/lib/review/types.ts`), with the server's one-line description
/// (`describeRecord`). The record's own numbers vary by kind — est. 1RM,
/// seconds, reps, a quantity — so only what every kind carries is named.
public struct BlockRecord: Codable, Sendable, Equatable {
    /// `oneRM`, `duration`, `reps`, `distance` or `elevation`.
    public let kind: String
    public let exerciseName: String
    /// The event_date the record was set.
    public let date: String
    public let previousDate: String?
    public let description: String
}

/// The block phases and objective disciplines the DB accepts
/// (`src/types/blocks.ts`). Catalogs, not enums: the CHECK constraint is the
/// truth, and a value added there must not fail a decode here.
public enum BlockPhase {
    public static let all = ["base", "build", "peak", "taper", "recovery", "maintenance"]
}

public enum ObjectiveDiscipline {
    public static let all = ["alpine", "ice", "rock", "ski", "general"]
}

// MARK: - The cycle preview

/// `CycleSpec` in `src/lib/blocks/cadence.ts`, as the preview posts it.
public struct CycleSpec: Codable, Sendable, Equatable {
    /// Any date — the server snaps it to the ISO Monday that contains it.
    public var startDate: String
    public var weeksOn: Int
    /// 0 emits build blocks only.
    public var weeksOff: Int
    /// Repetitions of the on/off pair.
    public var cycles: Int
    public var namePrefix: String
    public var intent: String?
    public var objectiveId: String?
    public var weeklyTargets: WeeklyTargets
    /// Multiplier applied to the recovery block's targets.
    public var recoveryScale: Double

    public init(
        startDate: String, weeksOn: Int = 3, weeksOff: Int = 1, cycles: Int = 4, namePrefix: String,
        intent: String? = nil, objectiveId: String? = nil, weeklyTargets: WeeklyTargets = WeeklyTargets(),
        recoveryScale: Double = 0.5
    ) {
        self.startDate = startDate
        self.weeksOn = weeksOn
        self.weeksOff = weeksOff
        self.cycles = cycles
        self.namePrefix = namePrefix
        self.intent = intent
        self.objectiveId = objectiveId
        self.weeklyTargets = weeklyTargets
        self.recoveryScale = recoveryScale
    }
}

/// `POST /api/blocks?resource=cycle` — `api/_lib/handlers/blockCycle.ts`.
/// `ok: false` carries the generator's own refusal; `ok: true` carries the
/// dated blocks to render, the `rows` that `createBlocks` sends back verbatim
/// to commit them, and the first existing block they would overlap.
public struct CyclePreviewResponse: Codable, Sendable, Equatable {
    public let ok: Bool
    public let problem: String?
    public let blocks: [BlockDraft]?
    public let rows: [JSONValue]?
    public let totalWeeks: Int?
    public let conflict: BlockConflict?
}

/// A block the preview would create (`Omit<TrainingBlock, 'id'>`, camelCase).
public struct BlockDraft: Codable, Sendable, Equatable {
    public let name: String
    public let intent: String
    public let phase: String?
    public let objectiveId: String?
    public let startDate: String
    public let endDateExclusive: String
    public let weeklyTargets: WeeklyTargets
}

public struct BlockConflict: Codable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let startDate: String
    public let endDateExclusive: String
}
