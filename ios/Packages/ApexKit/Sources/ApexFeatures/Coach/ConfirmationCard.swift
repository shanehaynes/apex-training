import ApexCore
import ApexUI
import SwiftUI

/// The confirmation card for one pending coach action: the server-built label,
/// "k of N", Cancel and Confirm. Sits in the bottom inset in place of the
/// composer, so nothing can be typed until it settles.
///
/// Confirm stays the primary even when the action deletes — the coach proposes
/// and the user decides, which is the product. What changes is the eyebrow: it
/// reads in `dangerText` so the card announces what kind of change it is before
/// the label is read (ux-review §3.6).
struct ConfirmationCard: View {
    let label: String
    let index: Int
    let total: Int
    let isBusy: Bool
    var isDestructive: Bool = false
    let onConfirm: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            HStack(alignment: .firstTextBaseline) {
                eyebrow
                Spacer()
                if total > 1 {
                    Text(ChatCopy.cardPosition(index: index, total: total))
                        .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                        .foregroundStyle(ApexColor.textMuted)
                        .accessibilityIdentifier("coach.card.position")
                }
            }
            Text(Self.humanized(label))
                .font(.apex(.display, size: TypeScale.base, weight: .medium, relativeTo: .body))
                .foregroundStyle(ApexColor.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("coach.card.label")
            HStack(spacing: Spacing.sm) {
                ApexButton("Cancel", kind: .secondary, action: onCancel)
                    .disabled(isBusy)
                    .accessibilityIdentifier("coach.card.cancel")
                ApexButton("Confirm", kind: .primary, isLoading: isBusy, action: onConfirm)
                    .accessibilityIdentifier("coach.card.confirm")
            }
        }
        .padding(.horizontal, Spacing.screen)
        .padding(.vertical, Spacing.md)
        .frame(maxWidth: .infinity)
        .background(ApexColor.bgElevated)
        .overlay(alignment: .top) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("coach.card")
    }

    /// `apexEyebrow()` bakes in `textMuted`, and a `foregroundStyle` outside it
    /// cannot win against a style applied closer to the Text — so the destructive
    /// variant spells the same type out with its own colour.
    private var eyebrow: some View {
        Text("Coach wants to")
            .font(.apex(.display, size: TypeScale.micro, weight: .bold, relativeTo: .caption))
            .tracking(1.4)
            .textCase(.uppercase)
            .foregroundStyle(isDestructive ? ApexPalette.dangerText : ApexColor.textMuted)
    }
}

extension ConfirmationCard {
    /// The label is built by the server ("Delete: Fixture Push Day · 2026-09-29
    /// (this instance)"), so the ISO date is turned into prose here rather than
    /// in ApexCore: `2026-09-29` → "Tue, Sep 29", and a `2026-08-06 17:30` that
    /// carries a time → "Thu, Aug 6, 5:30 PM".
    static func humanized(_ label: String) -> String {
        guard let regex = Self.isoDate else { return label }
        let full = NSRange(label.startIndex..<label.endIndex, in: label)
        var out = ""
        var cursor = label.startIndex
        for match in regex.matches(in: label, range: full) {
            guard let range = Range(match.range, in: label) else { continue }
            let time = match.range(at: 1).location == NSNotFound
                ? nil
                : Range(match.range(at: 1), in: label).map { String(label[$0]).trimmingCharacters(in: .whitespaces) }
            guard let pretty = Self.prose(date: String(label[range].prefix(10)), time: time) else { continue }
            out += String(label[cursor..<range.lowerBound])
            out += pretty
            cursor = range.upperBound
        }
        out += String(label[cursor...])
        return out
    }

    nonisolated(unsafe) private static let isoDate = try? NSRegularExpression(
        pattern: #"\d{4}-\d{2}-\d{2}(?:[ T](\d{2}:\d{2}))?"#
    )

    private static func prose(date: String, time: String?) -> String? {
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.timeZone = .current
        parser.dateFormat = time == nil ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm"
        guard let parsed = parser.date(from: time.map { "\(date) \($0)" } ?? date) else { return nil }
        let out = DateFormatter()
        out.locale = Locale(identifier: "en_US_POSIX")
        out.timeZone = .current
        out.dateFormat = time == nil ? "EEE, MMM d" : "EEE, MMM d, h:mm a"
        return out.string(from: parsed)
    }
}
