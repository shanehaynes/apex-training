import ApexCore
import ApexUI
import SwiftUI

/// The ICS feed: copy, share, and subscribe in Calendar over `webcal://` (U19).
/// The URL is composed server-side from the profile's token (D-028); the
/// `webcal` spelling is the same URL with the scheme swapped.
public struct CalendarFeedView: View {
    private let model: YouModel
    @Environment(\.openURL) private var openURL

    public init(model: YouModel) {
        self.model = model
    }

    private var feedURL: URL? { model.profile?.calendarFeedUrl.flatMap(URL.init(string:)) }

    private var webcalURL: URL? {
        guard let feedURL, var components = URLComponents(url: feedURL, resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = "webcal"
        return components.url
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                Hint("Subscribe from Apple or Google Calendar to see your workouts. Anyone with this URL can read your schedule — treat it like a password.")
                if let feedURL {
                    CopyField("Feed URL", value: feedURL.absoluteString, toast: "Feed URL copied", identifier: "you.feed")
                    if let webcalURL {
                        ApexButton("Subscribe in Calendar") { openURL(webcalURL) }
                            .accessibilityIdentifier("you.feed.subscribe")
                    }
                    ShareLink(item: feedURL) {
                        HStack(spacing: Spacing.sm) {
                            ApexIcon.share.image
                            Text("Share feed URL")
                        }
                        .font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .body))
                        .foregroundStyle(ApexColor.textPrimary)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.md))
                        .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
                    }
                    .accessibilityIdentifier("you.feed.share")
                } else if model.profile != nil {
                    Text("No feed token on this account yet.").apexBody()
                } else {
                    ProgressView().tint(ApexColor.textMuted).frame(maxWidth: .infinity)
                }
            }
            .padding(Spacing.screen)
        }
        .youScreen("Calendar feed")
    }
}
