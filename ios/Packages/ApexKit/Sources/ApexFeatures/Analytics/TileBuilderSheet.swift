import ApexCore
import ApexUI
import SwiftUI

/// The tile builder (`TileBuilder.tsx`): the live preview pinned under the
/// title, the form scrolling beneath it, the coach drawer under a sparkle,
/// Save in a bottom bar the keyboard lifts (U3). `.large` only; a dirty draft
/// cannot be swiped away (architecture §3).
///
/// ux-review §3.7: the preview used to sit at the *bottom* of the form, below
/// every control, so it was never on screen while the user was choosing — the
/// one thing the whole sheet exists to show. It is now a pinned band, and the
/// chart redraws under the title as each choice lands.
public struct TileBuilderSheet: View {
    /// The pinned band's chart area. Tall enough to read a trend, short enough
    /// that the first form fields are still above the fold on a 6.1" phone.
    static let previewHeight: CGFloat = 120

    let onClose: () -> Void
    @State private var builder: TileBuilderModel

    public init(model: AnalyticsModel, tile: AnalyticsTile?, coachServices: CoachServices? = nil, onClose: @escaping () -> Void) {
        self.onClose = onClose
        _builder = State(initialValue: TileBuilderModel(model: model, tile: tile, coachServices: coachServices))
    }

    /// Over a prepared model — previews and snapshots open the sheet mid-flow.
    public init(builder: TileBuilderModel, onClose: @escaping () -> Void) {
        self.onClose = onClose
        _builder = State(initialValue: builder)
    }

    public var body: some View {
        @Bindable var builder = builder
        VStack(spacing: 0) {
            header
            // The band travels with the form into the split rather than
            // sitting above it: the coach drawer keeps exactly the half of
            // the sheet it had before, and the preview is still on screen
            // while the coach rewrites the draft under it.
            if builder.coachOpen, let coach = builder.coach {
                VSplit(top: { formPane }, bottom: { DraftCoachDrawer(coach: coach, copy: .analytics) })
            } else {
                formPane
            }
        }
        .background(ApexColor.bgSurface)
        .safeAreaInset(edge: .bottom, spacing: 0) { actionBar }
        .interactiveDismissDisabled(builder.isDirty)
        .confirmationDialog("Discard this tile?", isPresented: $builder.confirmDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive, action: onClose)
            Button("Keep editing", role: .cancel) {}
        }
        .task { await builder.start() }
        .onDisappear { builder.shutdown() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("analytics.builder")
    }

    private var formPane: some View {
        VStack(spacing: 0) {
            previewBand
            TileBuilderFormView(builder: builder)
        }
    }

    private var header: some View {
        HStack(spacing: Spacing.sm) {
            Text(builder.title).apexTitle().lineLimit(1).accessibilityIdentifier("analytics.builder.heading")
            Spacer(minLength: 0)
            if builder.canCoach {
                Button { Motion.animate { builder.coachOpen.toggle() } } label: {
                    ApexIcon.sparkles.image
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(builder.coachOpen ? ApexColor.bgPrimary : ApexColor.textMuted)
                        .frame(width: 44, height: 44)
                        .background(builder.coachOpen ? ApexColor.accent : .clear, in: .circle)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(builder.coachOpen ? "Hide coach" : "Ask your coach to configure the tile")
                .accessibilityIdentifier("analytics.builder.coach.toggle")
            }
            Button {
                if builder.isDirty { builder.confirmDiscard = true } else { onClose() }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(ApexColor.textMuted)
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
            .accessibilityIdentifier("analytics.builder.close")
        }
        .padding(.leading, Spacing.screen)
        .padding(.trailing, Spacing.xs)
        .padding(.top, Spacing.sm)
    }

    /// The live preview, pinned: the server's chart, or its problem in the
    /// web's words. A hairline is all that separates it from the form — the
    /// band and the sheet share `bgSurface` so the chart reads as part of the
    /// sheet's chrome rather than as the first card in the list.
    private var previewBand: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(spacing: Spacing.sm) {
                Text("Preview").apexFieldLabel()
                if builder.preview == .loading {
                    ProgressView().controlSize(.mini).tint(ApexColor.textMuted)
                }
                Spacer(minLength: 0)
            }
            previewBody
                .frame(maxWidth: .infinity)
                .frame(height: Self.previewHeight)
        }
        .padding(.horizontal, Spacing.screen)
        .padding(.top, Spacing.sm)
        .padding(.bottom, Spacing.md)
        .background(ApexColor.bgSurface)
        .overlay(alignment: .bottom) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 1) }
    }

    @ViewBuilder
    private var previewBody: some View {
        switch builder.preview {
        case .idle, .loading:
            // Not "no data" — the request is in flight, and the spinner above
            // says so. An empty ground keeps the band from jumping.
            Color.clear
        // `children: .contain` is load-bearing: every renderer under here sets
        // identifiers of its own (`tile.kpi.<key>`, `tile.problem`), and a
        // modifier nearer the leaf wins — without a container element of its
        // own the band's name would simply not exist. It stopped existing the
        // moment a sparse line started drawing through `KPIRowView`.
        case .ready(let data):
            TileBodyView(chartType: builder.draft.chartType, data: data)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("analytics.builder.preview")
        case .problem(let text):
            TileProblemView(text: text)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("analytics.builder.problem")
        case .failed(let text):
            TileProblemView(text: text)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("analytics.builder.failed")
        }
    }

    /// Cancel + Save, with the last refusal above them: a toast would render
    /// under the sheet, so the server's text lives here until the next edit.
    private var actionBar: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            if let problem = builder.saveProblem {
                InlineError(problem, identifier: "analytics.builder.saveproblem")
            }
            HStack(spacing: Spacing.sm) {
                ApexButton("Cancel", kind: .secondary) {
                    if builder.isDirty { builder.confirmDiscard = true } else { onClose() }
                }
                .disabled(builder.isSaving)
                ApexButton(builder.isEditing ? "Save changes" : "Save tile", isLoading: builder.isSaving) {
                    Task { if await builder.save() { onClose() } }
                }
                .accessibilityIdentifier("analytics.builder.save")
            }
        }
        .padding(Spacing.screen)
        .background(ApexColor.bgSurface)
        .overlay(alignment: .top) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 1) }
    }
}
