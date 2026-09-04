import ApexCore
import ApexUI
import SwiftUI

/// The Schedule tab: Day (default) ⇄ Month under one period bar, sheets for a
/// day and an event, the freshness line when the cache has to speak for itself.
public struct ScheduleTab: View {
    @Bindable private var model: ScheduleModel
    @State private var sheet: ScheduleSheet?

    public init(model: ScheduleModel) {
        self.model = model
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                PeriodBar(model: model)
                if let label = model.freshnessLabel {
                    FreshnessBanner(label)
                }
                content
            }
            .background(ApexColor.bgPrimary)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { Wordmark() }
            }
            .toolbarBackground(ApexColor.bgPrimary, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
        .sheet(item: $sheet) { item in
            Group {
                switch item {
                case .event(let id):
                    EventSheet(model: model, eventId: id) { sheet = nil }
                case .day(let day):
                    DaySheet(model: model, day: day, onOpenEvent: { sheet = .event(id: $0.id) }, onClose: { sheet = nil })
                }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
            .presentationBackground(ApexColor.bgSurface)
        }
        .task { await model.start() }
    }

    @ViewBuilder
    private var content: some View {
        if model.index == nil, let error = model.loadError {
            VStack(spacing: Spacing.md) {
                EmptyState(eyebrow: "Schedule", message: error, symbol: ApexIcon.offline.systemName)
                    .frame(maxHeight: 220)
                ApexButton("Retry", kind: .secondary, isLoading: model.isRefreshing) {
                    Task { await model.refresh(reason: .retry) }
                }
                .frame(maxWidth: 200)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(ApexColor.bgPrimary)
        } else if model.index == nil {
            ZStack {
                ApexColor.bgPrimary.ignoresSafeArea()
                ProgressView().tint(ApexColor.textMuted)
            }
        } else {
            switch model.mode {
            case .day:
                DayView(model: model, onOpen: { sheet = .event(id: $0.id) })
            case .month:
                MonthView(model: model, onOpenDay: { sheet = .day($0) }, onOpenEvent: { sheet = .event(id: $0.id) })
            }
        }
    }
}

/// `‹ title ›` · Today · Day|Month — the web's TopNav, minus the "+" that
/// arrives with the builder (W7).
struct PeriodBar: View {
    @Bindable var model: ScheduleModel

    var body: some View {
        VStack(spacing: Spacing.sm) {
            HStack(spacing: Spacing.sm) {
                stepButton(ApexIcon.chevronLeft, label: "Previous", delta: -1)
                Text(model.periodTitle)
                    .font(.apex(.display, size: TypeScale.base, weight: .semibold, relativeTo: .headline))
                    .foregroundStyle(ApexColor.textPrimary)
                    .frame(maxWidth: .infinity)
                    .contentTransition(.numericText())
                    .accessibilityIdentifier("schedule.period")
                stepButton(ApexIcon.chevronRight, label: "Next", delta: 1)
                Button("Today") { withAnimation(Motion.spring) { model.goToToday() } }
                    .font(.apex(.display, size: TypeScale.xs, weight: .semibold, relativeTo: .caption))
                    .foregroundStyle(model.isShowingToday ? ApexColor.textMuted : ApexColor.textPrimary)
                    .padding(.horizontal, Spacing.md)
                    .frame(minHeight: 32)
                    .background(ApexColor.bgSurface, in: .capsule)
                    .overlay(Capsule().strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
                    .disabled(model.isShowingToday)
                    .frame(minHeight: 44)
            }
            ApexSegmented(selection: $model.mode, options: [(.day, "Day"), (.month, "Month")])
                .frame(maxWidth: 220)
        }
        .padding(.horizontal, Spacing.screen)
        .padding(.top, Spacing.sm)
        .padding(.bottom, Spacing.md)
        .background(ApexColor.bgPrimary)
    }

    private func stepButton(_ icon: ApexIcon, label: String, delta: Int) -> some View {
        Button { withAnimation(Motion.spring) { model.step(delta) } } label: {
            icon.image
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(ApexColor.textSecondary)
                .frame(width: 44, height: 44)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}
