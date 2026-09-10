import ApexCore
import ApexUI
import SwiftUI

/// The workout builder (`WorkoutBuilderView.tsx`): the template search, then
/// the form, with the coach drawer under a sparkle; Apply / Save changes in a
/// bottom bar the keyboard lifts (U3), the scope bar when a series is being
/// edited. `.large` only; a dirty draft cannot be swiped away (architecture §3).
public struct BuilderSheet: View {
    let model: ScheduleModel
    let route: BuilderRoute
    let coachServices: CoachServices?
    let onClose: () -> Void

    @State private var builder: BuilderModel

    public init(model: ScheduleModel, route: BuilderRoute, coachServices: CoachServices? = nil, onClose: @escaping () -> Void) {
        self.model = model
        self.route = route
        self.coachServices = coachServices
        self.onClose = onClose
        _builder = State(initialValue: BuilderModel(model: model, route: route, coachServices: coachServices))
    }

    /// Over a prepared model — previews and snapshots open the sheet mid-flow.
    public init(builder: BuilderModel, onClose: @escaping () -> Void) {
        self.model = builder.scheduleModel
        self.route = builder.route
        self.coachServices = nil
        self.onClose = onClose
        _builder = State(initialValue: builder)
    }

    public var body: some View {
        @Bindable var builder = builder
        VStack(spacing: 0) {
            header
            if builder.step == .search {
                TemplateSearchView(builder: builder)
            } else if builder.coachOpen, let coach = builder.coach {
                VSplit(top: { BuilderFormView(builder: builder) }, bottom: { BuilderCoachDrawer(builder: builder, coach: coach) })
            } else {
                BuilderFormView(builder: builder)
            }
        }
        .background(ApexColor.bgSurface)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if builder.step == .form { actionBar }
        }
        .interactiveDismissDisabled(builder.isDirty)
        .confirmationDialog("Discard this workout?", isPresented: $builder.confirmDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive, action: onClose)
            Button("Keep editing", role: .cancel) {}
        }
        .task { await builder.start() }
        .onDisappear { builder.shutdown() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("builder")
    }

    private var header: some View {
        HStack(spacing: Spacing.sm) {
            if !builder.isEditing, builder.step == .form {
                Button { withAnimation(Motion.spring) { builder.backToSearch() } } label: {
                    ApexIcon.chevronLeft.image.font(.system(size: 15, weight: .medium)).foregroundStyle(ApexColor.textMuted)
                        .frame(width: 44, height: 44).contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Back to workout search")
                .accessibilityIdentifier("builder.back")
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(builder.title).apexTitle().lineLimit(1).accessibilityIdentifier("builder.title")
                Text(builder.subtitle)
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textMuted)
            }
            Spacer(minLength: 0)
            if builder.canCoach {
                Button { withAnimation(Motion.spring) { builder.coachOpen.toggle() } } label: {
                    ApexIcon.sparkles.image
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(builder.coachOpen ? ApexColor.bgPrimary : ApexColor.textMuted)
                        .frame(width: 44, height: 44)
                        .background(builder.coachOpen ? ApexColor.accent : .clear, in: .circle)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(builder.coachOpen ? "Hide coach" : "Ask your coach to fill the form")
                .accessibilityIdentifier("builder.coach.toggle")
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
            .accessibilityIdentifier("builder.close")
        }
        .padding(.leading, builder.isEditing || builder.step == .search ? Spacing.screen : Spacing.xs)
        .padding(.trailing, Spacing.xs)
        .padding(.top, Spacing.sm)
    }

    /// `BuilderForm`'s action bar: Cancel + Apply / Save changes, or — for a
    /// recurring series — the scope question first.
    @ViewBuilder
    private var actionBar: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            if builder.choosingScope {
                Text("Apply to this event only — it leaves the series for good, keeping anything logged — or to the whole series?")
                    .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: Spacing.sm) {
                    ApexButton("Back", kind: .secondary) { builder.choosingScope = false }
                        .disabled(builder.isSaving)
                    ApexButton("This event only", isLoading: builder.isSaving) { Task { if await builder.apply(scope: .occurrence) { onClose() } } }
                        .accessibilityIdentifier("builder.scope.occurrence")
                    ApexButton("Whole series", isLoading: builder.isSaving) { Task { if await builder.apply(scope: .series) { onClose() } } }
                        .accessibilityIdentifier("builder.scope.series")
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("builder.scope")
            } else {
                if !builder.isEditing {
                    Text("Apply saves this workout to your library and adds it to the calendar.")
                        .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
                        .foregroundStyle(ApexColor.textMuted)
                }
                HStack(spacing: Spacing.sm) {
                    ApexButton("Cancel", kind: .secondary) {
                        if builder.isDirty { builder.confirmDiscard = true } else { onClose() }
                    }
                    .disabled(builder.isSaving)
                    ApexButton(builder.isEditing ? "Save changes" : "Apply", isLoading: builder.isSaving) {
                        if builder.asksScope {
                            withAnimation(Motion.spring) { builder.choosingScope = true }
                        } else {
                            Task { if await builder.apply() { onClose() } }
                        }
                    }
                    .accessibilityIdentifier("builder.apply")
                }
            }
        }
        .padding(Spacing.screen)
        .background(ApexColor.bgSurface)
        .overlay(alignment: .top) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 1) }
    }
}

/// Two panes stacked, the bottom one (the coach) taking a fixed share.
private struct VSplit<Top: View, Bottom: View>: View {
    @ViewBuilder let top: () -> Top
    @ViewBuilder let bottom: () -> Bottom

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                top().frame(height: geometry.size.height * 0.5)
                Rectangle().fill(ApexColor.borderSubtle).frame(height: 1)
                bottom().frame(maxHeight: .infinity)
            }
        }
    }
}
