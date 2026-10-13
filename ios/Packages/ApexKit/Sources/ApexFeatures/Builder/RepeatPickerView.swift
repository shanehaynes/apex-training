import ApexCore
import ApexUI
import SwiftUI

/// `RepeatPicker.tsx`: On/Off, Weekly (the Monday-first day chips) or Daily,
/// every N, and Ends (never / a date / after N times). A rule the picker can't
/// express is shown read-only and kept verbatim; editing a series hides the
/// switch (ending a series is an Ends date, or delete on the sheet).
struct RepeatPickerView: View {
    @Binding var repeatRule: DraftRepeat
    let anchorDate: String
    var lockOff = false

    private var isWeekly: Bool { repeatRule.frequency == .weekly }
    /// "After N times" is chosen: nil means it is not, so clearing the
    /// field mid-edit keeps it on screen (an empty count saves as never-ending).
    private var hasCount: Bool { repeatRule.count != nil }

    /// Days belong to weekly rules only: a daily rule drops them, so nothing
    /// downstream can snap the anchor to a chip the user no longer sees.
    private func setFrequency(_ freq: RepeatFrequency) {
        repeatRule.freq = freq
        if freq == .daily { repeatRule.days = [] }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack {
                Text("Repeat").apexFieldLabel()
                Spacer()
                if !lockOff {
                    Toggle("", isOn: Binding(
                        get: { repeatRule.enabled },
                        set: { on in
                            if on { repeatRule.enabled = true } else { repeatRule = .off }
                        }
                    ))
                    .labelsHidden()
                    .tint(ApexColor.accent)
                    .accessibilityLabel("Repeat")
                    .accessibilityIdentifier("builder.repeat.toggle")
                }
            }
            if let custom = repeatRule.custom {
                Text("This series uses a repeat pattern the picker can't edit (\(custom)). It is kept as is.")
                    .apexBody()
                    .fixedSize(horizontal: false, vertical: true)
            } else if repeatRule.enabled {
                HStack(spacing: Spacing.sm) {
                    Chip("Weekly", isSelected: isWeekly) { setFrequency(.weekly) }
                        .accessibilityIdentifier("builder.repeat.freq.weekly")
                    Chip("Daily", isSelected: !isWeekly) { setFrequency(.daily) }
                        .accessibilityIdentifier("builder.repeat.freq.daily")
                }
                if isWeekly {
                    HStack(spacing: Spacing.xs) {
                        ForEach(Weekday.chipOrder, id: \.rawValue) { day in
                            let on = repeatRule.days.contains(day)
                            Button {
                                if on { repeatRule.days.removeAll { $0 == day } } else { repeatRule.days.append(day) }
                            } label: {
                                Text(day.label)
                                    .font(.apex(.mono, size: TypeScale.sm, weight: .semibold, relativeTo: .callout))
                                    .foregroundStyle(on ? ApexColor.bgPrimary : ApexColor.textSecondary)
                                    .frame(width: 40, height: 40)
                                    .background(on ? ApexColor.accent : ApexColor.bgElevated, in: .circle)
                                    .overlay(Circle().strokeBorder(on ? .clear : ApexColor.borderSubtle, lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Repeat on \(day.rawValue)")
                            .accessibilityAddTraits(on ? .isSelected : [])
                            .accessibilityIdentifier("builder.repeat.\(day.rawValue)")
                        }
                    }
                }
                HStack(spacing: Spacing.sm) {
                    Text("Every").apexBody()
                    TextField("", text: $repeatRule.interval)
                        .keyboardType(.numberPad)
                        .font(.apex(.mono, size: TypeScale.base, relativeTo: .body))
                        .foregroundStyle(ApexColor.textPrimary)
                        .multilineTextAlignment(.center)
                        .frame(width: 56, height: 40)
                        .background(ApexColor.bgElevated, in: .rect(cornerRadius: Radius.md))
                        .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
                        .accessibilityIdentifier("builder.repeat.interval")
                    Text((isWeekly ? "week" : "day") + (Int(repeatRule.interval) == 1 ? "" : "s")).apexBody()
                }
                // One end at a time: picking a date clears the count and the
                // count clears the date, as on the web.
                HStack(spacing: Spacing.sm) {
                    Text("Ends").apexBody()
                    Chip("Never", isSelected: repeatRule.until.isEmpty && !hasCount) {
                        repeatRule.until = ""
                        repeatRule.count = nil
                    }
                    .accessibilityIdentifier("builder.repeat.ends.never")
                    Chip("On a date", isSelected: !repeatRule.until.isEmpty) {
                        repeatRule.count = nil
                        if repeatRule.until.isEmpty { repeatRule.until = (DayKey(anchorDate) ?? DayKey(year: 2026, month: 1, day: 1)).adding(days: 28).string }
                    }
                    .accessibilityIdentifier("builder.repeat.ends.date")
                    Chip("After N times", isSelected: hasCount) {
                        repeatRule.until = ""
                        if !hasCount { repeatRule.count = "10" }
                    }
                    .accessibilityIdentifier("builder.repeat.ends.count")
                }
                if hasCount {
                    HStack(spacing: Spacing.sm) {
                        Text("After").apexBody()
                        TextField("", text: Binding(
                            get: { repeatRule.countText },
                            set: { repeatRule.count = $0 }
                        ))
                        .keyboardType(.numberPad)
                        .font(.apex(.mono, size: TypeScale.base, relativeTo: .body))
                        .foregroundStyle(ApexColor.textPrimary)
                        .multilineTextAlignment(.center)
                        .frame(width: 56, height: 40)
                        .background(ApexColor.bgElevated, in: .rect(cornerRadius: Radius.md))
                        .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
                        .accessibilityLabel("Repeat count")
                        .accessibilityIdentifier("builder.repeat.count")
                        Text("times").apexBody()
                    }
                }
                if !repeatRule.until.isEmpty {
                    DateField("Last day", day: Binding(
                        get: { DayKey(repeatRule.until) ?? DayKey(anchorDate) ?? DayKey(year: 2026, month: 1, day: 1) },
                        set: { repeatRule.until = $0.string }
                    ), identifier: "builder.repeat.until")
                }
            }
        }
        .padding(Spacing.md)
        .background(ApexColor.bgElevated.opacity(0.5), in: .rect(cornerRadius: Radius.lg))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("builder.repeat")
    }
}
