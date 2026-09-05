import ApexCore
import ApexUI
import SwiftUI

/// `WorkoutSummary.tsx` as an overlay inside the tracker cover: the coach's
/// summary streaming in, the PR trophies (server-described), the full log,
/// and Back to calendar. Offline it says so and fills in when the flush lands.
struct SummaryOverlay: View {
    let model: TrackerModel
    let summary: TrackerModel.Summary
    let onBack: () -> Void

    var body: some View {
        ZStack {
            ApexColor.bgPrimary.opacity(0.92).ignoresSafeArea()
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: Spacing.lg) {
                        header
                        if summary.pendingSync { pendingLine }
                        coach
                        if !summary.prs.isEmpty || summary.scoreRecord != nil { trophies }
                        log
                    }
                    .padding(Spacing.screen)
                }
                ApexButton("Back to calendar", kind: .primary, action: onBack)
                    .padding(.horizontal, Spacing.screen)
                    .padding(.vertical, Spacing.md)
                    .accessibilityIdentifier("tracker.summary.back")
            }
            .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.lg))
            .overlay(alignment: .top) {
                UnevenRoundedRectangle(topLeadingRadius: Radius.lg, topTrailingRadius: Radius.lg)
                    .fill(ApexColor.accent).frame(height: 3)
            }
            .overlay(alignment: .topTrailing) {
                Button { model.dismissSummary() } label: {
                    ApexIcon.close.image
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(ApexColor.textMuted)
                        .frame(width: 44, height: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close summary")
                .accessibilityIdentifier("tracker.summary.close")
            }
            .padding(Spacing.md)
            .frame(maxWidth: 640)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tracker.summary")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(spacing: Spacing.sm) {
                ApexIcon.checkCircle.image.font(.system(size: 20, weight: .semibold)).foregroundStyle(ApexPalette.positive)
                Text("Workout Complete").apexTitle()
            }
            Text(meta)
                .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                .foregroundStyle(ApexColor.textMuted)
        }
        .padding(.trailing, 44)
    }

    private var meta: String {
        var line = "\(model.event.title) · \(MonthNames.weekdayShort[model.event.day.weekday - 1]), \(MonthNames.short[model.event.day.month - 1]) \(model.event.day.day)"
        if let score = summary.score {
            line += " · \(score.formatted)"
        } else if let seconds = summary.durationSeconds {
            line += " · \(Self.duration(seconds))"
        }
        return line
    }

    static func duration(_ seconds: Int) -> String {
        let minutes = max(0, seconds) / 60
        if minutes < 60 { return "\(minutes) min" }
        return "\(minutes / 60)h \(minutes % 60)m"
    }

    private var pendingLine: some View {
        HStack(spacing: Spacing.sm) {
            ApexIcon.pendingSync.image.font(.system(size: 12))
            Text("PRs pending sync — they fill in once the workout reaches the server.")
                .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
        }
        .foregroundStyle(ApexColor.textMuted)
        .accessibilityIdentifier("tracker.summary.pending")
    }

    private var coach: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Coach's Summary").apexEyebrow()
            switch summary.coachStatus {
            case .loading:
                if let text = summary.coachText, !text.isEmpty {
                    Text(text).apexBody().foregroundStyle(ApexColor.textPrimary)
                } else {
                    Text("Your coach is writing…").apexBody().italic()
                }
            case .ready:
                Text(summary.coachText ?? "").apexBody().foregroundStyle(ApexColor.textPrimary)
            case .unavailable(let message):
                Text(message).apexBody().italic()
            }
        }
        .accessibilityIdentifier("tracker.summary.coach")
    }

    private var trophies: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Personal Records").apexEyebrow()
            if let record = summary.scoreRecord, let description = record.description {
                trophy(title: model.event.title, description: description)
            }
            ForEach(Array(summary.prs.enumerated()), id: \.offset) { _, pr in
                trophy(title: pr.exerciseName, description: pr.description)
            }
        }
        .accessibilityIdentifier("tracker.summary.prs")
    }

    private func trophy(title: String, description: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
            ApexIcon.trophy.image.font(.system(size: 14)).foregroundStyle(ApexPalette.positive)
            Text(title).font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .callout)).foregroundStyle(ApexColor.textPrimary)
            + Text(" — \(description)").font(.apex(.display, size: TypeScale.sm, relativeTo: .callout)).foregroundStyle(ApexColor.textSecondary)
        }
        .padding(Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ApexColor.bgElevated, in: .rect(cornerRadius: Radius.md))
    }

    private var log: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            ForEach(model.editor.groups, id: \.section) { group in
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    Text(group.label).apexEyebrow()
                    ForEach(group.exercises, id: \.exercise.id) { tracked in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(tracked.exercise.name)
                                .font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .callout))
                                .foregroundStyle(ApexColor.textPrimary)
                            if let cardio = tracked.cardio {
                                logLine(Self.cardioLabel(cardio), muted: Self.cardioLabel(cardio) == nil)
                            } else {
                                ForEach(tracked.sets, id: \.setNumber) { set in
                                    HStack(spacing: Spacing.sm) {
                                        Text("\(set.setNumber)")
                                            .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                                            .foregroundStyle(ApexColor.textMuted)
                                            .frame(width: 18, alignment: .leading)
                                        logLine(Self.setLabel(set), muted: Self.setLabel(set) == nil)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        .accessibilityIdentifier("tracker.summary.log")
    }

    private func logLine(_ text: String?, muted: Bool) -> some View {
        Text(text ?? (muted ? "skipped" : ""))
            .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
            .italic(muted)
            .foregroundStyle(muted ? ApexColor.textMuted : ApexColor.textSecondary)
    }

    /// "185lb × 5 2:30"; nil for a skipped or empty set.
    static func setLabel(_ set: TrackedSet) -> String? {
        if set.isAutofilled { return nil }
        var parts: [String] = []
        if !set[.weight].isEmpty { parts.append(set[.weight]) }
        if !set[.reps].isEmpty { parts.append("× \(set[.reps])") }
        if !set[.duration].isEmpty { parts.append(set[.duration]) }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    /// "45 min · 5 mi · ↑ 800 ft · 145 bpm"; nil when nothing was logged.
    static func cardioLabel(_ cardio: CardioLog) -> String? {
        var parts: [String] = []
        if !cardio[.durationMinutes].isEmpty { parts.append("\(cardio[.durationMinutes]) min") }
        if !cardio[.distance].isEmpty { parts.append(cardio[.distance]) }
        if !cardio[.elevationGain].isEmpty { parts.append("↑ \(cardio[.elevationGain])") }
        if !cardio[.avgHeartRate].isEmpty { parts.append("\(cardio[.avgHeartRate]) bpm") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
