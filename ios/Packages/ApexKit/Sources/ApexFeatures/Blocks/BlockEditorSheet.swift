import ApexCore
import ApexUI
import SwiftUI

/// The block editor (`BlockEditor.tsx`) as a sheet: name, intent, phase,
/// objective (with the inline "new objective" nothing else creates), the
/// dates snapping to Monday and Sunday as they are picked (U9), the six
/// weekly targets with their unit pickers. A refusal — the server's 409 for
/// an overlap, its 23514 text for a bad range — is an `InlineError` above
/// the buttons (#167); Delete unfolds into a confirmation, as the event
/// sheet's does.
public struct BlockEditorSheet: View {
    private let model: BlocksModel
    private let block: BlockSummary?
    private let onClose: () -> Void
    @State private var form: BlockForm
    @State private var problem: String?
    @State private var isSaving = false
    @State private var confirmDelete = false
    @State private var addingObjective = false
    @State private var objectiveName = ""
    @State private var objectiveHasDate = false
    @State private var objectiveDate: DayKey
    @State private var objectiveDiscipline = ""

    public init(model: BlocksModel, block: BlockSummary?, onClose: @escaping () -> Void) {
        self.model = model
        self.block = block
        self.onClose = onClose
        _form = State(initialValue: block.map(BlockForm.init(block:)) ?? BlockForm.new(today: model.today))
        _objectiveDate = State(initialValue: model.today)
    }

    private var isEditing: Bool { block != nil }

    public var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: isEditing ? "Edit block" : "New block", onClose: onClose)
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    FormField("Name", text: $form.name, placeholder: "Spring base", identifier: "blocks.editor.name")
                    FormField("Intent", text: $form.intent, placeholder: "What this block is for", isMultiline: true, identifier: "blocks.editor.intent")
                    ChipRow("Phase", options: [("", "—")] + BlockPhase.all.map { ($0, $0.capitalized) }, selection: phaseBinding, identifier: "blocks.editor.phase")
                    objectivePicker
                    dates
                    targets
                }
                .padding(Spacing.screen)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background(ApexColor.bgSurface)
        .safeAreaInset(edge: .bottom, spacing: 0) { actionBar }
        .interactiveDismissDisabled(isDirty)
        .onChange(of: form) { _, _ in problem = nil }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("blocks.editor")
    }

    private var isDirty: Bool {
        if let block { return form.row() != BlockForm(block: block).row() }
        return !form.name.isEmpty || !form.intent.isEmpty || !form.weeklyTargets().isEmpty
    }

    private var phaseBinding: Binding<String> {
        Binding(get: { form.phase ?? "" }, set: { form.phase = $0.isEmpty ? nil : $0 })
    }

    // MARK: - Objective

    private var objectivePicker: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text("Objective").apexFieldLabel()
            Menu {
                Button("None") { form.objectiveId = nil }
                ForEach(model.objectives) { objective in
                    Button(objective.name) { form.objectiveId = objective.id }
                }
                Divider()
                Button { Motion.animate { addingObjective = true } } label: {
                    Label("New objective", systemImage: ApexIcon.plus.systemName)
                }
            } label: {
                HStack {
                    Text(model.objective(id: form.objectiveId)?.name ?? "None")
                        .font(.apex(.display, size: TypeScale.base, relativeTo: .body))
                        .foregroundStyle(form.objectiveId == nil ? ApexColor.textMuted : ApexColor.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    ApexIcon.chevronDown.image.font(.system(size: 12, weight: .medium)).foregroundStyle(ApexColor.textMuted)
                }
                .apexFieldChrome()
                .contentShape(.rect)
            }
            .accessibilityIdentifier("blocks.editor.objective")
            if addingObjective { newObjective }
        }
    }

    /// `CycleEditor.tsx`'s inline objective form: the select is otherwise
    /// permanently empty for a new account.
    private var newObjective: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            FormField("Objective name", text: $objectiveName, placeholder: "Rainier in May", identifier: "blocks.objective.name")
            Toggle(isOn: $objectiveHasDate) {
                Text("Target date").font(.apex(.display, size: TypeScale.sm, relativeTo: .callout)).foregroundStyle(ApexColor.textPrimary)
            }
            .tint(ApexColor.accent)
            .accessibilityIdentifier("blocks.objective.hasdate")
            if objectiveHasDate {
                DateField("Target date", day: $objectiveDate, identifier: "blocks.objective.date")
            }
            ChipRow("Discipline", options: [("", "—")] + ObjectiveDiscipline.all.map { ($0, $0.capitalized) }, selection: $objectiveDiscipline, identifier: "blocks.objective.discipline")
            HStack(spacing: Spacing.sm) {
                ApexButton("Cancel", kind: .secondary) { Motion.animate { addingObjective = false } }
                ApexButton("Add objective", isLoading: isSaving) { Task { await addObjective() } }
                    .disabled(objectiveName.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityIdentifier("blocks.objective.add")
            }
        }
        .padding(Spacing.md)
        .background(ApexColor.bgElevated, in: .rect(cornerRadius: Radius.lg))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("blocks.objective.new")
    }

    private func addObjective() async {
        isSaving = true
        defer { isSaving = false }
        switch await model.createObjective(
            name: objectiveName, targetDate: objectiveHasDate ? objectiveDate : nil,
            discipline: objectiveDiscipline.isEmpty ? nil : objectiveDiscipline
        ) {
        case .created(let objective):
            form.objectiveId = objective.id
            objectiveName = ""
            Motion.animate { addingObjective = false }
        case .problem(let text):
            problem = text
        }
    }

    // MARK: - Dates and targets

    private var dates: some View {
        HStack(spacing: Spacing.sm) {
            DateField("Starts (Monday)", day: $form.startDay, identifier: "blocks.editor.start")
                .onChange(of: form.startDay) { _, day in
                    let monday = BlockDates.mondayOf(day)
                    if monday != day { form.startDay = monday }
                }
            DateField("Ends (Sunday)", day: $form.endInclusive, identifier: "blocks.editor.end")
                .onChange(of: form.endInclusive) { _, day in
                    let sunday = BlockDates.sundayOf(day)
                    if sunday != day { form.endInclusive = sunday }
                }
        }
    }

    private var targets: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Weekly targets").apexEyebrow()
            Text("Leave a target blank to derive it from what's on the calendar.")
                .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
                .foregroundStyle(ApexColor.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: Spacing.sm) {
                FormField("Cardio (min)", text: $form.cardioMinutes, keyboard: .numberPad, identifier: "blocks.editor.cardio")
                FormField("Strength sessions", text: $form.strengthSessions, keyboard: .numberPad, identifier: "blocks.editor.strength")
            }
            HStack(spacing: Spacing.sm) {
                FormField("Climbing sessions", text: $form.climbingSessions, keyboard: .numberPad, identifier: "blocks.editor.climbing")
                FormField("Long session (min)", text: $form.longSessionMinutes, keyboard: .numberPad, identifier: "blocks.editor.long")
            }
            HStack(alignment: .bottom, spacing: Spacing.sm) {
                FormField("Vertical gain", text: $form.vert, keyboard: .numberPad, identifier: "blocks.editor.vert")
                ApexSegmented(selection: $form.vertUnit, options: [("ft", "ft"), ("m", "m")])
                    .frame(width: 96)
                    .accessibilityIdentifier("blocks.editor.vertunit")
            }
            HStack(alignment: .bottom, spacing: Spacing.sm) {
                FormField("Distance", text: $form.distance, keyboard: .numberPad, identifier: "blocks.editor.distance")
                ApexSegmented(selection: $form.distanceUnit, options: [("mi", "mi"), ("km", "km")])
                    .frame(width: 96)
                    .accessibilityIdentifier("blocks.editor.distanceunit")
            }
        }
    }

    // MARK: - Actions

    private var actionBar: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            if let problem { InlineError(problem, identifier: "blocks.editor.problem") }
            if let block, confirmDelete {
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    Text("Delete “\(block.name)”? Its targets go with it; nothing logged is touched.")
                        .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                        .foregroundStyle(ApexColor.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: Spacing.sm) {
                        ApexButton("Keep", kind: .secondary) { confirmDelete = false }.disabled(isSaving)
                        ApexButton("Delete block", kind: .destructive, isLoading: isSaving) { Task { await remove(block) } }
                            .accessibilityIdentifier("blocks.editor.delete.confirm")
                    }
                }
                .padding(Spacing.md)
                .background(ApexPalette.destructive.opacity(0.12), in: .rect(cornerRadius: Radius.lg))
                .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(ApexPalette.danger.opacity(0.4), lineWidth: 1))
            }
            HStack(spacing: Spacing.sm) {
                if isEditing, !confirmDelete {
                    Button {
                        Motion.animate { confirmDelete = true }
                    } label: {
                        Label("Delete", systemImage: ApexIcon.trash.systemName)
                            .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                            .foregroundStyle(ApexPalette.dangerText)
                            .frame(minHeight: 44)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .disabled(isSaving)
                    .accessibilityIdentifier("blocks.editor.delete")
                }
                Spacer(minLength: 0)
                ApexButton("Cancel", kind: .secondary, action: onClose).disabled(isSaving)
                ApexButton(isEditing ? "Save" : "Create block", isLoading: isSaving) { Task { await save() } }
                    .disabled(!form.canSave)
                    .accessibilityIdentifier("blocks.editor.save")
            }
        }
        .padding(Spacing.screen)
        .background(ApexColor.bgSurface)
        .overlay(alignment: .top) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 1) }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        let refusal = if let block { await model.updateBlock(block, form) } else { await model.createBlock(form) }
        if let refusal { problem = refusal } else { onClose() }
    }

    private func remove(_ block: BlockSummary) async {
        isSaving = true
        defer { isSaving = false }
        if let refusal = await model.deleteBlock(block) { problem = refusal } else { onClose() }
    }
}
