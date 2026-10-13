import ApexCore
import ApexUI
import SwiftUI

/// `PlannedSetsEditor.tsx`: the "Per-set targets" disclosure under an
/// entry's prescription. One row per set, a column per dimension the
/// prescription names, and three presets that fill the rows — ramp,
/// pyramid, top set + back-offs. Rows stay editable after a preset. Every
/// edit writes `plannedSets` whole through `PlannedSets` (ApexCore); this
/// view only renders.
///
/// Editing the base prescription no longer clears the table — "Apply to all
/// sets" refills it from the base on purpose, "Remove per-set targets"
/// drops it on purpose.
struct PlannedSetsEditor: View {
    @Binding var entry: Exercise
    @State private var isOpen: Bool
    @State private var preset: Preset?

    enum Preset: String, CaseIterable, Identifiable {
        case ramp, pyramid, topSet
        var id: String { rawValue }
        var label: String {
            switch self {
            case .ramp: "Ramp"
            case .pyramid: "Pyramid"
            case .topSet: "Top set + back-offs"
            }
        }
    }

    init(entry: Binding<Exercise>) {
        _entry = entry
        _isOpen = State(initialValue: !(entry.wrappedValue.plannedSets ?? []).isEmpty)
    }

    private var isAuthored: Bool { !(entry.plannedSets ?? []).isEmpty }
    private var fields: [PlannedSets.Field] { PlannedSets.fields(for: entry) }
    private var rows: [PlannedSet] { PlannedSets.tableRows(for: entry) }
    private var count: Int { PlannedSets.count(for: entry) }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Button {
                Motion.animate { isOpen.toggle() }
            } label: {
                HStack(spacing: Spacing.xs) {
                    ApexIcon.chevronRight.image
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                    Text("Per-set targets")
                    if isAuthored {
                        Text("\(count) \(count == 1 ? "set" : "sets") authored")
                            .textCase(nil)
                            .tracking(0)
                            .lineLimit(1)
                            .fixedSize()
                            .padding(.horizontal, Spacing.xs + 2)
                            .padding(.vertical, 1)
                            .background(ApexColor.bgElevated, in: .rect(cornerRadius: Radius.sm))
                    }
                }
                .apexFieldLabel()
                .frame(minHeight: 32, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(isOpen ? [.isSelected] : [])
            .accessibilityIdentifier("editor.planned.\(entry.id).toggle")

            if isOpen {
                presets
                if let preset {
                    PresetForm(preset: preset, fields: fields, entry: entry, rows: rows) { filled in
                        entry.plannedSets = filled
                        self.preset = nil
                    } onCancel: {
                        self.preset = nil
                    }
                    .id(preset)
                }
                table
                if isAuthored {
                    HStack(spacing: Spacing.sm) {
                        chip("Apply to all sets") { entry.plannedSets = PlannedSets.uniform(count, base: entry) }
                            .accessibilityIdentifier("editor.planned.\(entry.id).applyBase")
                        chip("Remove per-set targets", tint: ApexPalette.dangerText) {
                            entry.plannedSets = nil
                            preset = nil
                        }
                        .accessibilityIdentifier("editor.planned.\(entry.id).remove")
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("editor.planned.\(entry.id)")
    }

    private var presets: some View {
        HStack(spacing: Spacing.xs) {
            ForEach(Preset.allCases) { option in
                chip(option.label, isOn: preset == option) {
                    preset = preset == option ? nil : option
                }
                .accessibilityIdentifier("editor.planned.\(entry.id).preset.\(option.rawValue)")
            }
        }
    }

    private var table: some View {
        VStack(spacing: Spacing.xs) {
            HStack(spacing: Spacing.xs) {
                Text("Set").apexFieldLabel().frame(width: 28, alignment: .trailing)
                ForEach(fields, id: \.self) { field in
                    Text(field.label).apexFieldLabel().frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            ForEach(rows, id: \.setNumber) { row in
                HStack(spacing: Spacing.xs) {
                    Text("\(row.setNumber)")
                        .font(.apex(.mono, size: TypeScale.sm, weight: .semibold, relativeTo: .callout))
                        .foregroundStyle(ApexColor.textSecondary)
                        .frame(width: 28, alignment: .trailing)
                    ForEach(fields, id: \.self) { field in
                        cell(Binding(
                            get: { value(of: row, field) },
                            set: { entry.plannedSets = PlannedSets.setting(rows, setNumber: row.setNumber, field: field, to: $0) }
                        ))
                        .accessibilityLabel("Set \(row.setNumber) \(field.label.lowercased())")
                        .accessibilityIdentifier("editor.planned.\(entry.id).\(row.setNumber).\(field.rawValue)")
                    }
                }
            }
        }
    }

    private func value(of row: PlannedSet, _ field: PlannedSets.Field) -> String {
        switch field {
        case .weight: row.targetWeight ?? ""
        case .reps: row.targetReps ?? ""
        case .duration: row.targetDuration ?? ""
        }
    }

    private func cell(_ text: Binding<String>) -> some View {
        TextField("", text: text, prompt: Text("—").foregroundStyle(ApexColor.textMuted))
            .font(.apex(.mono, size: TypeScale.sm, relativeTo: .callout))
            .foregroundStyle(ApexColor.textPrimary)
            .autocorrectionDisabled()
            .padding(.horizontal, Spacing.sm)
            .frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
            .background(ApexColor.bgElevated, in: .rect(cornerRadius: Radius.sm))
            .overlay(RoundedRectangle(cornerRadius: Radius.sm).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
    }

    private func chip(_ title: String, isOn: Bool = false, tint: Color? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.apex(.display, size: TypeScale.xs, weight: .medium, relativeTo: .caption))
                .foregroundStyle(tint ?? (isOn ? ApexColor.textPrimary : ApexColor.textSecondary))
                .padding(.horizontal, Spacing.sm + 2)
                .frame(minHeight: 30)
                .background(ApexColor.bgElevated, in: .rect(cornerRadius: Radius.sm))
                .overlay(RoundedRectangle(cornerRadius: Radius.sm).strokeBorder(isOn ? ApexColor.accent : ApexColor.borderSubtle, lineWidth: 1))
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

/// The inputs one preset needs, and Fill. Numbers are parsed the way the
/// builders do (`PlannedSets.parse`), so "20 lbs" and "20" both work and the
/// unit comes off what was typed, else off the base target.
private struct PresetForm: View {
    let preset: PlannedSetsEditor.Preset
    let fields: [PlannedSets.Field]
    let entry: Exercise
    let rows: [PlannedSet]
    let onFill: ([PlannedSet]) -> Void
    let onCancel: () -> Void

    @State private var field: PlannedSets.Field
    @State private var first = ""
    @State private var second = ""
    @State private var backoffs: String
    @State private var percent = "80"

    init(
        preset: PlannedSetsEditor.Preset, fields: [PlannedSets.Field], entry: Exercise, rows: [PlannedSet],
        onFill: @escaping ([PlannedSet]) -> Void, onCancel: @escaping () -> Void
    ) {
        self.preset = preset
        self.fields = fields
        self.entry = entry
        self.rows = rows
        self.onFill = onFill
        self.onCancel = onCancel
        _field = State(initialValue: fields.first ?? .weight)
        _backoffs = State(initialValue: String(max(0, rows.count - 1)))
    }

    private var base: String? {
        switch field {
        case .weight: entry.weight
        case .reps: entry.reps
        case .duration: entry.duration
        }
    }

    private var isReady: Bool {
        guard PlannedSets.parse(first) != nil else { return false }
        if preset == .topSet {
            guard let n = Int(backoffs), n >= 0, let pct = Double(percent), pct > 0 else { return false }
            return true
        }
        return PlannedSets.parse(second) != nil
    }

    private var placeholder: String {
        if let base, PlannedSets.parse(base) != nil { return base }
        return field.label.lowercased()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(alignment: .bottom, spacing: Spacing.xs) {
                if fields.count > 1 {
                    labelled("Field") {
                        Menu {
                            ForEach(fields, id: \.self) { option in
                                Button(option.label) { field = option }
                            }
                        } label: {
                            HStack(spacing: Spacing.xs) {
                                Text(field.label)
                                    .font(.apex(.mono, size: TypeScale.sm, relativeTo: .callout))
                                    .foregroundStyle(ApexColor.textPrimary)
                                Spacer(minLength: 0)
                                ApexIcon.chevronDown.image.font(.system(size: 10)).foregroundStyle(ApexColor.textMuted)
                            }
                            .padding(.horizontal, Spacing.sm)
                            .frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
                            .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.sm))
                            .overlay(RoundedRectangle(cornerRadius: Radius.sm).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
                        }
                        .accessibilityIdentifier("editor.planned.\(entry.id).form.field")
                    }
                }
                labelled(preset == .ramp ? "First" : preset == .pyramid ? "Start" : "Top") {
                    input($first, prompt: placeholder, keyboard: .default)
                        .accessibilityIdentifier("editor.planned.\(entry.id).form.first")
                }
                if preset == .topSet {
                    labelled("Back-offs") {
                        input($backoffs, prompt: "0", keyboard: .numberPad)
                            .accessibilityIdentifier("editor.planned.\(entry.id).form.backoffs")
                    }
                    .frame(maxWidth: 72)
                    labelled("At %") {
                        input($percent, prompt: "80", keyboard: .decimalPad)
                            .accessibilityIdentifier("editor.planned.\(entry.id).form.percent")
                    }
                    .frame(maxWidth: 64)
                } else {
                    labelled(preset == .ramp ? "Last" : "Peak") {
                        input($second, prompt: placeholder, keyboard: .default)
                            .accessibilityIdentifier("editor.planned.\(entry.id).form.second")
                    }
                }
            }
            HStack(spacing: Spacing.sm) {
                ApexButton("Fill", kind: .primary, action: fill)
                    .disabled(!isReady)
                    .opacity(isReady ? 1 : 0.5)
                    .accessibilityIdentifier("editor.planned.\(entry.id).form.fill")
                ApexButton("Cancel", kind: .secondary, action: onCancel)
            }
        }
        .padding(Spacing.sm)
        .background(ApexColor.bgElevated, in: .rect(cornerRadius: Radius.md))
    }

    private func fill() {
        guard let a = PlannedSets.parse(first) else { return }
        let unit = PlannedSets.unit(typed: first, base: base)
        switch preset {
        case .ramp:
            guard let b = PlannedSets.parse(second) else { return }
            onFill(PlannedSets.ramp(rows, field: field, first: a.value, last: b.value, unit: unit))
        case .pyramid:
            guard let b = PlannedSets.parse(second) else { return }
            onFill(PlannedSets.pyramid(rows, field: field, low: a.value, peak: b.value, unit: unit))
        case .topSet:
            guard let n = Int(backoffs), let pct = Double(percent) else { return }
            onFill(PlannedSets.topSetBackoffs(rows, field: field, top: a.value, backoffs: n, percent: pct, unit: unit))
        }
    }

    private func labelled(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).apexFieldLabel()
            content()
        }
    }

    private func input(_ text: Binding<String>, prompt: String, keyboard: UIKeyboardType) -> some View {
        TextField("", text: text, prompt: Text(prompt).foregroundStyle(ApexColor.textMuted))
            .font(.apex(.mono, size: TypeScale.sm, relativeTo: .callout))
            .foregroundStyle(ApexColor.textPrimary)
            .keyboardType(keyboard)
            .autocorrectionDisabled()
            .padding(.horizontal, Spacing.sm)
            .frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
            .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.sm))
            .overlay(RoundedRectangle(cornerRadius: Radius.sm).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
    }
}
