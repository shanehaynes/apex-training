import ApexCore
import ApexUI
import SwiftUI

/// Every schedule and library change, You / Coach badged, newest first.
public struct ActivityLogView: View {
    private let model: ActivityLogModel

    public init(model: ActivityLogModel) {
        self.model = model
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                Hint("Every schedule and library change, and whether you or the AI coach made it. Recent first.")
                if model.failed {
                    Text("The log could not be loaded.").apexBody()
                } else if let entries = model.entries {
                    if entries.isEmpty {
                        Text("No changes logged yet.").apexBody()
                    } else {
                        // Lazy: the log is every schedule and library change.
                        SettingsSection(lazy: true) {
                            ForEach(Array(entries.enumerated()), id: \.offset) { index, entry in
                                if index > 0 { SettingsDivider() }
                                row(entry, index: index)
                            }
                        }
                    }
                } else {
                    ProgressView().tint(ApexColor.textMuted).frame(maxWidth: .infinity)
                }
            }
            .padding(Spacing.screen)
        }
        .youScreen("Activity log")
        .task { await model.load() }
        .refreshable { await model.load() }
    }

    private func row(_ entry: ActivityLogEntry, index: Int) -> some View {
        HStack(alignment: .top, spacing: Spacing.md) {
            Text(entry.isUserTriggered ? "You" : "Coach")
                .font(.apex(.mono, size: TypeScale.micro, weight: .medium, relativeTo: .caption2))
                .foregroundStyle(entry.isUserTriggered ? ApexColor.textPrimary : ApexColor.bgPrimary)
                .padding(.horizontal, Spacing.sm)
                .padding(.vertical, 3)
                .background(entry.isUserTriggered ? ApexColor.bgElevated : ApexPalette.positive, in: .capsule)
                .frame(width: 56, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                (Text(ActivityLogModel.operationLabel(entry.operation) + " ")
                    + Text(entry.title).fontWeight(.semibold)
                    + Text(ActivityLogModel.suffix(entry)))
                    .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(model.time(entry))
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textMuted)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.vertical, Spacing.md)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("activity.row.\(index)")
    }
}
