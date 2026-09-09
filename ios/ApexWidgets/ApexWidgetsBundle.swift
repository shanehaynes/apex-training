import ActivityKit
import ApexActivity
import ApexUI
import SwiftUI
import WidgetKit

/// The widget extension (W12, D-016). One Live Activity today; a home-screen
/// widget for today's workout would join this bundle (Backlog).
///
/// Thin on purpose: every view lives in `ApexActivity` so the app's snapshot
/// tests can render them, and the attributes type is shared with the app
/// through the same module (ActivityKit pairs by type).
@main
struct ApexWidgetsBundle: WidgetBundle {
    init() {
        // The bundled faces are SwiftPM resources, not `UIAppFonts`, so the
        // extension process registers them itself — same as the app's init.
        ApexFonts.register()
    }

    var body: some Widget {
        TrackerLiveActivity()
    }
}

struct TrackerLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TrackerActivityAttributes.self) { context in
            // Every placement opens the tracker on this session. PR B teaches
            // `DeepLink` the route; until then `DeepLink.parse` returns nil and
            // the app just comes to the front.
            TrackerActivityViews.LockScreen(attributes: context.attributes, state: context.state)
                .activityBackgroundTint(ApexColor.bgSurface)
                .activitySystemActionForegroundColor(ApexColor.textPrimary)
                .widgetURL(context.attributes.url)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    TrackerActivityViews.ExpandedLeading(state: context.state)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    TrackerActivityViews.ExpandedTrailing(state: context.state)
                }
                DynamicIslandExpandedRegion(.center) {
                    TrackerActivityViews.ExpandedCenter(attributes: context.attributes, state: context.state)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    TrackerActivityViews.ExpandedBottom(state: context.state)
                }
            } compactLeading: {
                TrackerActivityViews.CompactLeading(state: context.state)
            } compactTrailing: {
                TrackerActivityViews.CompactTrailing(state: context.state)
            } minimal: {
                TrackerActivityViews.Minimal(state: context.state)
            }
            .keylineTint(ApexColor.accent)
            .widgetURL(context.attributes.url)
        }
    }
}
