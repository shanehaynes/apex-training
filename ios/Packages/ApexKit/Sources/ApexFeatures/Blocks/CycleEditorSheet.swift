import ApexCore
import ApexUI
import SwiftUI

/// The cycle generator (`CycleEditor.tsx`) as a sheet: the cadence, the
/// targets, and the point of the screen — the dated preview the server draws
/// (`POST /api/blocks?resource=cycle`) after every edit, with the existing
/// block it would overlap named. Create sends the server's own rows back.
public struct CycleEditorSheet: View {
    private let model: BlocksModel
    private let onClose: () -> Void
    @State private var name = ""
    @State private var intent = ""
    @State private var objectiveId: String?
    @State private var startDay: DayKey
    @State private var weeksOn = "3"
    @State private var weeksOff = "1"
    @State private var cycles = "4"
    @State private var recoveryScale = 0.5
    /// The six target fields, borrowed from the block form.
    @State private var targets: BlockForm
    @State private var problem: String?
    @State private var isSaving = false

    private static let recoveryOptions: [(value: Double, label: String)] = [
        (0.4, "40% — a real rest week"), (0.5, "50% — half volume"), (0.6, "60% — a light week"),
    ]

    public init(model: BlocksModel, onClose: @escaping () -> Void) {
        self.model = model
        self.onClose = onClose
        let monday = BlockDates.mondayOf(model.today)
        _startDay = State(initialValue: monday)
        _targets = State(initialValue: BlockForm(startDay: monday, endInclusive: monday))
    }

    private var spec: CycleSpec {
        CycleSpec(
            startDate: startDay.string,
            weeksOn: Self.int(weeksOn, fallback: 3), weeksOff: Self.int(weeksOff, fallback: 1), cycles: Self.int(cycles, fallback: 4),
            // A blank name previews as "Cycle" so the rhythm shows; Create stays off until a real one.
            namePrefix: name.trimmingCharacters(in: .whitespaces).isEmpty ? "Cycle" : name.trimmingCharacters(in: .whitespaces),
            intent: intent.isEmpty ? nil : intent, objectiveId: objectiveId,
            weeklyTargets: targets.weeklyTargetsValue(), recoveryScale: recoveryScale
        )
    }

    private var ready: CyclePreviewResponse? {
        if case .ready(let response) = model.preview { return response }
        return nil
    }

    private var canCreate: Bool {
        guard let ready, !name.trimmingCharacters(in: .whitespaces).isEmpty, !isSaving else { return false }
        return ready.conflict == nil && !(ready.blocks ?? []).isEmpty
    }

    public var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "New cycle", onClose: onClose)
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    Text("A cycle repeats weeks of work followed by an easier week — enough load to adapt, enough rest to absorb it. It lays down ordinary blocks you can edit afterward.")
                        .apexBody()
                        .fixedSize(horizontal: false, vertical: true)
                    FormField("Name", text: $name, placeholder: "Spring Alpine", identifier: "blocks.cycle.name")
                    FormField("Intent", text: $intent, placeholder: "What this cycle is for", isMultiline: true, identifier: "blocks.cycle.intent")
                    objectivePicker
                    DateField("Starts (snaps to Monday)", day: $startDay, identifier: "blocks.cycle.start")
                        .onChange(of: startDay) { _, day in
                            let monday = BlockDates.mondayOf(day)
                            if monday != day { startDay = monday }
                        }
                    cadence
                    targetsSection
                    preview
                }
                .padding(Spacing.screen)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background(ApexColor.bgSurface)
        .safeAreaInset(edge: .bottom, spacing: 0) { actionBar }
        .interactiveDismissDisabled(!name.isEmpty)
        .task { model.scheduleCyclePreview(spec) }
        .onChange(of: spec) { _, next in
            problem = nil
            model.scheduleCyclePreview(next)
        }
        .onDisappear { model.resetPreview() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("blocks.cycle")
    }

    private var objectivePicker: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text("Objective").apexFieldLabel()
            Menu {
                Button("None") { objectiveId = nil }
                ForEach(model.objectives) { objective in
                    Button(objective.name) { objectiveId = objective.id }
                }
            } label: {
                HStack {
                    Text(model.objective(id: objectiveId)?.name ?? "None")
                        .font(.apex(.display, size: TypeScale.base, relativeTo: .body))
                        .foregroundStyle(objectiveId == nil ? ApexColor.textMuted : ApexColor.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    ApexIcon.chevronDown.image.font(.system(size: 12, weight: .medium)).foregroundStyle(ApexColor.textMuted)
                }
                .apexFieldChrome()
                .contentShape(.rect)
            }
            .accessibilityIdentifier("blocks.cycle.objective")
        }
    }

    private var cadence: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Cadence").apexEyebrow()
            HStack(spacing: Spacing.sm) {
                FormField("Weeks on", text: $weeksOn, keyboard: .numberPad, identifier: "blocks.cycle.weekson")
                FormField("Weeks off", text: $weeksOff, keyboard: .numberPad, identifier: "blocks.cycle.weeksoff")
                FormField("Repeat", text: $cycles, keyboard: .numberPad, identifier: "blocks.cycle.repeat")
            }
            ChipRow("Recovery volume", options: Self.recoveryOptions, selection: $recoveryScale, identifier: "blocks.cycle.recovery")
                .disabled(Self.int(weeksOff, fallback: 1) == 0)
                .opacity(Self.int(weeksOff, fallback: 1) == 0 ? 0.4 : 1)
        }
    }

    private var targetsSection: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Weekly targets for the build weeks").apexEyebrow()
            Text("Recovery weeks carry the same targets scaled by the recovery volume; a long-session threshold is not scaled.")
                .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
                .foregroundStyle(ApexColor.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: Spacing.sm) {
                FormField("Cardio (min)", text: $targets.cardioMinutes, keyboard: .numberPad, identifier: "blocks.cycle.cardio")
                FormField("Strength sessions", text: $targets.strengthSessions, keyboard: .numberPad, identifier: "blocks.cycle.strength")
            }
            HStack(spacing: Spacing.sm) {
                FormField("Climbing sessions", text: $targets.climbingSessions, keyboard: .numberPad, identifier: "blocks.cycle.climbing")
                FormField("Long session (min)", text: $targets.longSessionMinutes, keyboard: .numberPad, identifier: "blocks.cycle.long")
            }
            HStack(alignment: .bottom, spacing: Spacing.sm) {
                FormField("Vertical gain", text: $targets.vert, keyboard: .numberPad, identifier: "blocks.cycle.vert")
                ApexSegmented(selection: $targets.vertUnit, options: [("ft", "ft"), ("m", "m")]).frame(width: 96)
            }
            HStack(alignment: .bottom, spacing: Spacing.sm) {
                FormField("Distance", text: $targets.distance, keyboard: .numberPad, identifier: "blocks.cycle.distance")
                ApexSegmented(selection: $targets.distanceUnit, options: [("mi", "mi"), ("km", "km")]).frame(width: 96)
            }
        }
    }

    @ViewBuilder
    private var preview: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Preview").apexEyebrow()
            if let ready, let blocks = ready.blocks, let first = blocks.first, let last = blocks.last {
                Text("\(blocks.count) blocks · \(ready.totalWeeks ?? 0) weeks · \(BlocksModel.periodLabelWithYear(startDate: first.startDate, endDateExclusive: last.endDateExclusive))")
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("blocks.cycle.summary")
            }
            switch model.preview {
            case .idle, .loading:
                if let ready { rows(ready) } else { ProgressView().tint(ApexColor.textMuted).frame(maxWidth: .infinity) }
            case .problem(let text):
                Text(text).font(.apex(.display, size: TypeScale.sm, relativeTo: .callout)).foregroundStyle(ApexPalette.dangerText)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("blocks.cycle.preview.problem")
            case .failed(let text):
                Text(text).apexBody().accessibilityIdentifier("blocks.cycle.preview.failed")
            case .ready(let response):
                if let conflict = response.conflict {
                    Text("This overlaps “\(conflict.name)” (\(BlocksModel.periodLabel(startDate: conflict.startDate, endDateExclusive: conflict.endDateExclusive))). Move the start date, or shorten the cycle.")
                        .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                        .foregroundStyle(ApexPalette.dangerText)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("blocks.cycle.conflict")
                }
                rows(response)
            }
        }
        .accessibilityIdentifier("blocks.cycle.preview")
    }

    private func rows(_ response: CyclePreviewResponse) -> some View {
        SettingsSection {
            ForEach(Array((response.blocks ?? []).enumerated()), id: \.offset) { index, block in
                if index > 0 { SettingsDivider() }
                HStack(alignment: .center, spacing: Spacing.md) {
                    Chip(block.phase ?? "block", tint: block.phase == "recovery" ? ApexColor.borderSubtle : nil)
                        .frame(width: 88, alignment: .leading)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(block.name)
                            .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                            .foregroundStyle(ApexColor.textPrimary)
                            .lineLimit(1)
                        Text(BlocksModel.periodLabel(startDate: block.startDate, endDateExclusive: block.endDateExclusive))
                            .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                            .foregroundStyle(ApexColor.textSecondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, Spacing.lg)
                .padding(.vertical, Spacing.sm)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("blocks.cycle.preview.row.\(index)")
            }
        }
    }

    private var actionBar: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            if let problem { InlineError(problem, identifier: "blocks.cycle.problem") }
            HStack(spacing: Spacing.sm) {
                ApexButton("Cancel", kind: .secondary, action: onClose).disabled(isSaving)
                ApexButton(ready.map { "Create \(($0.blocks ?? []).count) blocks" } ?? "Create blocks", isLoading: isSaving) {
                    Task { await create() }
                }
                .disabled(!canCreate)
                .accessibilityIdentifier("blocks.cycle.create")
            }
        }
        .padding(Spacing.screen)
        .background(ApexColor.bgSurface)
        .overlay(alignment: .top) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 1) }
    }

    private func create() async {
        guard let ready else { return }
        isSaving = true
        defer { isSaving = false }
        if let refusal = await model.commitCycle(ready) { problem = refusal } else { onClose() }
    }

    private static func int(_ text: String, fallback: Int) -> Int {
        guard let n = Int(text.trimmingCharacters(in: .whitespaces)), n >= 0 else { return fallback }
        return n
    }
}
