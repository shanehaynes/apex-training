import ApexCore
import ApexUI
import SwiftUI

/// Pieces of the tracker exposed for snapshot tests and previews, which live
/// outside this module and cannot reach the internal views.
public enum TrackerPreviews {
    public static func scoreCard(model: TrackerModel) -> some View {
        VStack {
            Spacer()
            ScoreCard(model: model)
        }
    }

    /// Every exercise card of the model, one under another, with its own focus.
    public static func exerciseCards(model: TrackerModel) -> some View {
        ExerciseCardsPreview(model: model)
    }

    public static func summary(model: TrackerModel, summary: TrackerModel.Summary) -> some View {
        SummaryOverlay(model: model, summary: summary, onBack: {})
    }
}

private struct ExerciseCardsPreview: View {
    let model: TrackerModel
    @FocusState private var focus: FieldID?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                ForEach(model.editor.groups, id: \.section) { group in
                    ForEach(group.exercises, id: \.exercise.id) { tracked in
                        TrackedExerciseView(
                            model: model, tracked: tracked,
                            palette: WorkoutTypeTokens.palette(for: model.event.type.rawValue),
                            focus: $focus, durationModeToggle: 0, onSwap: {}
                        )
                    }
                }
            }
            .padding(Spacing.screen)
        }
        .background(ApexColor.bgPrimary)
    }
}
