import ApexCore
import SwiftUI

/// The web's `.library-field` + `__input`: a mono label over a 44pt input on
/// the elevated surface (design-spec §5). `apexFieldChrome()` gives any other
/// control (a date picker, a chip row) the same box.
public struct FormField: View {
    private let label: String
    @Binding private var text: String
    private let placeholder: String
    private let keyboard: UIKeyboardType
    private let isMultiline: Bool
    private let identifier: String?

    public init(
        _ label: String, text: Binding<String>, placeholder: String = "", keyboard: UIKeyboardType = .default,
        isMultiline: Bool = false, identifier: String? = nil
    ) {
        self.label = label
        self._text = text
        self.placeholder = placeholder
        self.keyboard = keyboard
        self.isMultiline = isMultiline
        self.identifier = identifier
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(label).apexFieldLabel()
            TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(ApexColor.textMuted), axis: isMultiline ? .vertical : .horizontal)
                .lineLimit(isMultiline ? 2...6 : 1...1)
                .font(.apex(.display, size: TypeScale.base, relativeTo: .body))
                .foregroundStyle(ApexColor.textPrimary)
                .keyboardType(keyboard)
                .autocorrectionDisabled(keyboard != .default)
                .apexFieldChrome()
                .accessibilityIdentifier(identifier ?? "field.\(label.lowercased().replacingOccurrences(of: " ", with: "-"))")
        }
    }
}

extension View {
    /// The input box every form control sits in: 44pt, elevated fill, subtle border.
    public func apexFieldChrome() -> some View {
        padding(.horizontal, Spacing.md)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(ApexColor.bgElevated, in: .rect(cornerRadius: Radius.md))
            .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
    }
}

/// A labelled row of `Chip`s with one selected — the web's `.builder-type-chip`
/// radio groups (type, sport, scoring).
public struct ChipRow<Value: Hashable & Sendable>: View {
    private let label: String?
    private let options: [(value: Value, label: String)]
    @Binding private var selection: Value
    private let identifier: String?

    public init(_ label: String? = nil, options: [(value: Value, label: String)], selection: Binding<Value>, identifier: String? = nil) {
        self.label = label
        self.options = options
        self._selection = selection
        self.identifier = identifier
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            if let label { Text(label).apexFieldLabel() }
            FlowLayout(spacing: Spacing.xs) {
                ForEach(options, id: \.value) { option in
                    Chip(option.label, isSelected: option.value == selection) {
                        withAnimation(Motion.spring) { selection = option.value }
                    }
                    .accessibilityAddTraits(option.value == selection ? .isSelected : [])
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier ?? "chips.\((label ?? "row").lowercased())")
    }
}

/// A native date picker in the field box (U9: dark, never a light-mode
/// control). Values are `DayKey`s: the picker works in UTC so the day never
/// slides across a zone boundary.
public struct DateField: View {
    private let label: String
    @Binding private var day: DayKey
    private let identifier: String?

    public init(_ label: String, day: Binding<DayKey>, identifier: String? = nil) {
        self.label = label
        self._day = day
        self.identifier = identifier
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(label).apexFieldLabel()
            DatePicker("", selection: Binding(
                get: { day.utcMidnight },
                set: { day = DayKey.fromUTCMidnight($0) }
            ), displayedComponents: .date)
            .labelsHidden()
            .datePickerStyle(.compact)
            .environment(\.timeZone, TimeZone(identifier: "UTC")!)
            .tint(ApexColor.accent)
            .apexFieldChrome()
            .accessibilityIdentifier(identifier ?? "field.date")
        }
    }
}

/// A native time-of-day picker in the field box, holding minutes since
/// midnight (nil = unset, shown as "Add"), with a clear affordance.
public struct TimeField: View {
    private let label: String
    @Binding private var minutes: Int?
    private let identifier: String?

    public init(_ label: String, minutes: Binding<Int?>, identifier: String? = nil) {
        self.label = label
        self._minutes = minutes
        self.identifier = identifier
    }

    private static let utc = TimeZone(identifier: "UTC")!
    private static let anchor = Date(timeIntervalSince1970: 0)

    public var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(label).apexFieldLabel()
            HStack(spacing: Spacing.sm) {
                if minutes != nil {
                    DatePicker("", selection: Binding(
                        get: { Self.anchor.addingTimeInterval(Double(minutes ?? 0) * 60) },
                        set: { minutes = Int($0.timeIntervalSince(Self.anchor) / 60) % (24 * 60) }
                    ), displayedComponents: .hourAndMinute)
                    .labelsHidden()
                    .datePickerStyle(.compact)
                    .environment(\.timeZone, Self.utc)
                    .tint(ApexColor.accent)
                    Spacer(minLength: 0)
                    Button {
                        minutes = nil
                    } label: {
                        ApexIcon.close.image.font(.system(size: 13)).foregroundStyle(ApexColor.textMuted)
                            .frame(width: 32, height: 32).contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear \(label)")
                } else {
                    Button("Add") { minutes = 9 * 60 }
                        .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                        .foregroundStyle(ApexColor.accent)
                    Spacer(minLength: 0)
                }
            }
            .apexFieldChrome()
            .accessibilityIdentifier(identifier ?? "field.time")
        }
    }
}
