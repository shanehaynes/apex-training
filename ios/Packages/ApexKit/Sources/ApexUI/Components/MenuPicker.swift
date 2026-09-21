import SwiftUI

/// One value in a menu or sheet picker: the value itself and the words the
/// user reads. A tuple array is the house shape (`ChipRow`, `ApexSegmented`),
/// but a tuple cannot be `Identifiable`, so the sheet needs this.
///
/// `nonisolated` on purpose: ApexUI defaults to `MainActor`, and a model that
/// assembles its options off the main actor (or a test target that does not
/// default to it) would otherwise not be able to name one.
public nonisolated struct PickerOption<Value: Hashable>: Identifiable {
    public let value: Value
    public let label: String

    public init(_ value: Value, _ label: String) {
        self.value = value
        self.label = label
    }

    public var id: Value { value }
}

extension PickerOption: Sendable where Value: Sendable {}

/// A single-choice field that opens a menu instead of spending a row of pills
/// on every option (ux-review §1.3: pills are the default control and should be
/// the exception). The trigger is the house field box — mono uppercase label
/// over a 44pt elevated row, `Radius.md`, subtle border — showing the current
/// value and a chevron.
///
/// The menu itself is a SwiftUI `Picker`, so the native checkmark, the
/// single-selection semantics and VoiceOver's menu handling all come for free.
/// `.pickerStyle(.menu)` is deliberately *not* used for the trigger: that style
/// draws its own row — system font, trailing-aligned value, its own chevron —
/// which `apexFieldChrome()` can only sit behind, never own. Wrapping the
/// `Picker` in a `Menu` keeps the picker and gives the row back.
public struct MenuPicker<Value: Hashable>: View {
    private let label: String?
    private let options: [PickerOption<Value>]
    @Binding private var selection: Value
    private let placeholder: String
    private let identifier: String?

    public init(
        _ label: String? = nil, options: [(value: Value, label: String)], selection: Binding<Value>,
        placeholder: String = "—", identifier: String? = nil
    ) {
        self.init(
            label, options: options.map { PickerOption($0.value, $0.label) }, selection: selection,
            placeholder: placeholder, identifier: identifier
        )
    }

    public init(
        _ label: String? = nil, options: [PickerOption<Value>], selection: Binding<Value>,
        placeholder: String = "—", identifier: String? = nil
    ) {
        self.label = label
        self.options = options
        self._selection = selection
        self.placeholder = placeholder
        self.identifier = identifier
    }

    /// The `Identifiable` form: any array of items plus the key path that names
    /// them. The bound value is the item's `id`.
    public init<Item: Identifiable>(
        _ label: String? = nil, items: [Item], labelKey: KeyPath<Item, String>, selection: Binding<Value>,
        placeholder: String = "—", identifier: String? = nil
    ) where Value == Item.ID {
        self.init(
            label, options: items.map { PickerOption($0.id, $0[keyPath: labelKey]) }, selection: selection,
            placeholder: placeholder, identifier: identifier
        )
    }

    /// The words on the row. A bound value with no option (a stale id, a server
    /// type this build does not know) shows the placeholder rather than blank.
    public var currentLabel: String {
        options.first { $0.value == selection }?.label ?? placeholder
    }

    private var resolvedIdentifier: String {
        identifier ?? "picker.\((label ?? "value").lowercased().replacingOccurrences(of: " ", with: "-"))"
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            if let label { Text(label).apexFieldLabel() }
            Menu {
                // The menu body stays a Picker: `.inline` is what renders it as
                // a checked radio group inside a menu.
                Picker(label ?? "", selection: animated) {
                    ForEach(options) { option in
                        Text(option.label).tag(option.value)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } label: {
                HStack(spacing: Spacing.sm) {
                    Text(currentLabel)
                        .font(.apex(.display, size: TypeScale.base, relativeTo: .body))
                        .foregroundStyle(ApexColor.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: Spacing.sm)
                    ApexIcon.chevronDown.image
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(ApexColor.textMuted)
                }
                .apexFieldChrome()
                .contentShape(.rect)
            }
            .menuOrder(.fixed)
            .accessibilityIdentifier(resolvedIdentifier)
            .accessibilityValue(currentLabel)
        }
        // design-spec §9: `.selection` on a choice change, like ChipRow's.
        .sensoryFeedback(.selection, trigger: selection)
    }

    /// The menu writes through here so a collapsed `ChipRow` animates exactly
    /// as the chip flow it replaced — and not at all under Reduce Motion.
    private var animated: Binding<Value> {
        Binding(get: { selection }, set: { next in Motion.animate { selection = next } })
    }
}
