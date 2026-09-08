import ApexCore
import ApexUI
import SwiftUI

/// `DurationInput.tsx` over `ApexCore.DurationEntry`: digits fill right-to-left
/// on the decimal pad; a non-digit (or the accessory's "Abc") switches to free
/// text and the default keyboard. The keyboard swap is a programmatic refocus
/// — no blur/refocus dance for the user (U29). Typing "0" into an empty buffer
/// clears the stored value (leading zeros are stripped).
struct DurationField: View {
    @Binding var value: String
    let ghost: String?
    let id: FieldID
    var focus: FocusState<FieldID?>.Binding
    let modeToggle: Int

    @State private var entry: DurationEntry
    @State private var lastToggle: Int

    init(value: Binding<String>, ghost: String?, id: FieldID, focus: FocusState<FieldID?>.Binding, modeToggle: Int) {
        self._value = value
        self.ghost = ghost
        self.id = id
        self.focus = focus
        self.modeToggle = modeToggle
        self._entry = State(initialValue: DurationEntry(value: value.wrappedValue))
        self._lastToggle = State(initialValue: modeToggle)
    }

    private var isFocused: Bool { focus.wrappedValue == id }

    var body: some View {
        TextField(
            "",
            text: Binding(
                get: { entry.display(stored: value) },
                set: { raw in
                    if let stored = entry.change(raw: raw), stored != value { value = stored }
                }
            ),
            prompt: Text(entry.placeholder(stored: value, ghost: ghost))
                .italic()
                .foregroundStyle(ApexColor.textSecondary.opacity(0.9))
        )
        .font(.apex(.mono, size: TypeScale.sm, relativeTo: .callout))
        .foregroundStyle(ApexColor.textPrimary)
        .keyboardType(entry.mode == .stopwatch ? .decimalPad : .default)
        .multilineTextAlignment(entry.mode == .stopwatch ? .trailing : .leading)
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        .focused(focus, equals: id)
        .padding(.horizontal, Spacing.sm)
        .frame(height: 44)
        .background(ApexColor.bgElevated, in: .rect(cornerRadius: Radius.md))
        .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(
            isFocused ? ApexColor.accent.opacity(0.7) : ApexColor.borderSubtle, lineWidth: 1
        ))
        .onChange(of: isFocused) { _, focused in
            if focused { entry.beginEditing() } else { entry.endEditing() }
        }
        .onChange(of: value) { _, stored in entry.sync(stored: stored) }
        .onChange(of: entry.mode) { _, _ in refocusForKeyboardChange() }
        .onChange(of: modeToggle) { _, count in
            guard count != lastToggle else { return }
            lastToggle = count
            guard isFocused else { return }
            let target: DurationEntry.Mode = entry.mode == .stopwatch ? .text : .stopwatch
            if let stored = entry.setMode(target, stored: value), stored != value { value = stored }
        }
    }

    /// `keyboardType` only takes effect on the next focus.
    private func refocusForKeyboardChange() {
        guard isFocused else { return }
        focus.wrappedValue = nil
        DispatchQueue.main.async { focus.wrappedValue = id }
    }
}
