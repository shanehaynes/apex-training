import ApexCore
import ApexUI
import SwiftUI

/// Where the Schedule tab's setup card remembers that it was closed.
///
/// D-035 made the close session-only on the grounds that nothing is lost — the
/// full list lives on the You tab. What it did not weigh is that the card comes
/// back *every launch* until all three rows are done, which is the definition of
/// an unasked-for nudge (ux-review §3.2, principle 2). The server's
/// `onboarding_dismissed` flag cannot carry this: it latches the welcome flow,
/// and the card is shown precisely *because* it is set — so the flag is already
/// true by the time the card exists. A local flag is the whole of the state.
enum SetupNudgeDismissal {
    private static let key = "apex.onboarding.nudge.dismissed"

    /// The XCUITest smoke asserts the card is up on a fixed fixture world, and
    /// its app container survives between runs — a dismissal written by one run
    /// would silently hide the card from the next. The UI-test world starts
    /// from nothing by contract.
    private static var isUITest: Bool { ProcessInfo.processInfo.arguments.contains("-apexUITest") }

    static var isDismissed: Bool {
        !isUITest && UserDefaults.standard.bool(forKey: key)
    }

    static func dismiss() {
        guard !isUITest else { return }
        UserDefaults.standard.set(true, forKey: key)
    }
}

/// The slim "Finish setting up" card at the top of the Schedule tab's scrolling
/// content (W13, U32) — the web's `SetupNudge`: the three rows the profile
/// answers without another request, a score, a close that persists. Collapsed it
/// is one line; tapping it opens the rows, each button going straight to the
/// thing it names.
public struct SetupNudgeCard: View {
    private let model: OnboardingModel
    @State private var isExpanded = false
    @State private var isDismissed = SetupNudgeDismissal.isDismissed
    @Environment(\.dynamicTypeSize) private var typeSize

    /// `initiallyExpanded` is for previews and snapshots — the card opens
    /// closed for a user.
    public init(model: OnboardingModel, initiallyExpanded: Bool = false) {
        self.model = model
        _isExpanded = State(initialValue: initiallyExpanded)
    }

    public var body: some View {
        if isDismissed {
            EmptyView()
        } else {
            card
        }
    }

    private var card: some View {
        let rows = model.nudgeRows
        return VStack(alignment: .leading, spacing: isExpanded ? Spacing.sm : 0) {
            summary(count: rows.count)
            if isExpanded {
                ForEach(rows) { row in
                    checklistRow(row)
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(row.item.label), \(row.done ? "done" : "not done")")
                        .accessibilityIdentifier("onboarding.nudge.row.\(row.id.rawValue)")
                }
            }
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.vertical, isExpanded ? Spacing.md : 0)
        .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.nudge")
    }

    /// "Finish setting up · 1 of 3 ›" — one line high, the whole of the card
    /// until it is asked for.
    private func summary(count: Int) -> some View {
        HStack(spacing: Spacing.sm) {
            Button {
                Motion.animate { isExpanded.toggle() }
            } label: {
                ViewThatFits(in: .horizontal) {
                    summaryLabel(count: count, axis: .horizontal)
                    summaryLabel(count: count, axis: .vertical)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("onboarding.nudge.summary")
            .accessibilityHint(isExpanded ? "Hides the setup steps" : "Shows the setup steps")

            Button {
                SetupNudgeDismissal.dismiss()
                model.nudgeHidden = true
                isDismissed = true
            } label: {
                ApexIcon.close.image
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(ApexColor.textMuted)
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
            .accessibilityIdentifier("onboarding.nudge.dismiss")
        }
    }

    @ViewBuilder
    private func summaryLabel(count: Int, axis: Axis) -> some View {
        let title = Text("Finish setting up")
            .font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .subheadline))
            .foregroundStyle(ApexColor.textPrimary)
        let score = Text("\(model.nudgeDoneCount) of \(count)")
            .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
            .foregroundStyle(ApexColor.textMuted)
        let chevron = ApexIcon.chevronRight.image
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(ApexColor.textMuted)
            .rotationEffect(.degrees(isExpanded ? 90 : 0))

        if axis == .horizontal {
            HStack(spacing: Spacing.sm) {
                title
                Text("·").foregroundStyle(ApexColor.textMuted).accessibilityHidden(true)
                score.accessibilityIdentifier("onboarding.nudge.score")
                chevron
            }
            .lineLimit(1)
        } else {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Spacing.sm) {
                    title
                    chevron
                }
                score.accessibilityIdentifier("onboarding.nudge.score")
            }
        }
    }

    /// Wrap, never truncate (ux-review §3.10): at accessibility sizes the row's
    /// button claimed the width and the label lost its tail ("Add a start…").
    @ViewBuilder
    private func checklistRow(_ row: OnboardingModel.NudgeRow) -> some View {
        if typeSize >= .accessibility1 {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                rowLabel(row)
                if !row.done { rowAction(row) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Spacing.sm) {
                    rowLabel(row)
                    Spacer(minLength: Spacing.sm)
                    if !row.done { rowAction(row) }
                }
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    rowLabel(row)
                    if !row.done { rowAction(row) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func rowLabel(_ row: OnboardingModel.NudgeRow) -> some View {
        HStack(spacing: Spacing.sm) {
            ZStack {
                Circle()
                    .strokeBorder(row.done ? ApexPalette.positive : ApexColor.borderSubtle, lineWidth: 1)
                    .background(Circle().fill(row.done ? ApexPalette.positive : .clear))
                if row.done {
                    ApexIcon.check.image
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(ApexColor.bgPrimary)
                }
            }
            .frame(width: 18, height: 18)
            .accessibilityHidden(true)
            Text(row.item.label)
                .font(.apex(.display, size: TypeScale.sm, relativeTo: .subheadline))
                .foregroundStyle(row.done ? ApexColor.textMuted : ApexColor.textPrimary)
                .strikethrough(row.done, color: ApexColor.textMuted)
                .fixedSize(horizontal: false, vertical: true)
                .multilineTextAlignment(.leading)
        }
    }

    private func rowAction(_ row: OnboardingModel.NudgeRow) -> some View {
        Button {
            Task { await model.run(row.item.action, for: row.id.rawValue) }
        } label: {
            Text(row.item.action.label)
                .font(.apex(.display, size: TypeScale.xs, weight: .semibold, relativeTo: .caption))
                .foregroundStyle(ApexColor.textPrimary)
                .lineLimit(1)
                .padding(.horizontal, Spacing.md)
                .frame(minHeight: 32)
                .background(ApexColor.bgElevated, in: .capsule)
                .overlay(Capsule().strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .frame(minHeight: 44)
        .disabled(row.id == .template && model.isCopying)
        .accessibilityIdentifier("onboarding.nudge.action.\(row.id.rawValue)")
    }
}
