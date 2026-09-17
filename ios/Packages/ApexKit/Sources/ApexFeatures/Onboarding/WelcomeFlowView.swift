import ApexCore
import ApexUI
import SwiftUI

/// The first-run tour (W13, U32): the web's `WelcomeFlow` as a native paged
/// flow — swipe or Next between steps, a step's own button where it has one,
/// Skip at any point, Start training at the end. Shows exactly once per
/// account: finishing or skipping latches `profiles.onboarding_dismissed_at`.
public struct WelcomeFlowView: View {
    @Bindable private var model: OnboardingModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(model: OnboardingModel) {
        self.model = model
    }

    private var steps: [OnboardingCatalog.Step] { model.welcomeSteps }
    private var isLast: Bool { model.stepIndex >= steps.count - 1 }

    public var body: some View {
        VStack(spacing: 0) {
            HStack {
                Wordmark()
                Spacer()
                Button { Task { await model.dismissWelcome() } } label: {
                    ApexIcon.close.image
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(ApexColor.textSecondary)
                        .frame(width: 44, height: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Skip setup")
                .accessibilityIdentifier("onboarding.welcome.skip")
            }
            .padding(.horizontal, Spacing.screen)
            .padding(.top, Spacing.sm)

            TabView(selection: $model.stepIndex) {
                ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                    page(step, index: index)
                        .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .animation(reduceMotion ? nil : Motion.spring, value: model.stepIndex)

            footer
        }
        .background(ApexColor.bgPrimary.ignoresSafeArea())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.welcome")
    }

    private func page(_ step: OnboardingCatalog.Step, index: Int) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                Text("Step \(index + 1) of \(steps.count)")
                    .apexEyebrow()
                    .monospacedDigit()
                    .accessibilityIdentifier("onboarding.welcome.count")
                Text(step.title)
                    .apexTitle()
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("onboarding.welcome.title")
                Text(step.body)
                    .apexBody()
                    .fixedSize(horizontal: false, vertical: true)
                if let action = step.action {
                    ApexButton(action.label, kind: .secondary, isLoading: action.kind == .copyTemplate && model.isCopying) {
                        Task { await model.run(action, for: step.id) }
                    }
                    .accessibilityIdentifier("onboarding.welcome.action")
                    .padding(.top, Spacing.sm)
                }
                if let link = step.link, let url = URL(string: link.href) {
                    Link(link.label, destination: url)
                        .font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .callout))
                        .foregroundStyle(ApexColor.textSecondary)
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("onboarding.welcome.link")
                }
            }
            .frame(maxWidth: 480, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Spacing.screen)
            .padding(.vertical, Spacing.xl)
        }
    }

    private var footer: some View {
        VStack(spacing: Spacing.lg) {
            HStack(spacing: Spacing.sm) {
                ForEach(steps.indices, id: \.self) { index in
                    Circle()
                        .fill(index == model.stepIndex ? ApexColor.textPrimary : ApexColor.borderSubtle)
                        .frame(width: 6, height: 6)
                }
            }
            .accessibilityHidden(true)
            HStack(spacing: Spacing.md) {
                if model.stepIndex > 0 {
                    ApexButton("Back", kind: .secondary) { model.stepIndex -= 1 }
                        .frame(maxWidth: 120)
                        .accessibilityIdentifier("onboarding.welcome.back")
                }
                ApexButton(isLast ? "Start training" : "Next") {
                    if isLast {
                        Task { await model.dismissWelcome() }
                    } else {
                        model.stepIndex += 1
                    }
                }
                .accessibilityIdentifier("onboarding.welcome.next")
            }
        }
        .padding(.horizontal, Spacing.screen)
        .padding(.top, Spacing.md)
        .padding(.bottom, Spacing.lg)
        .background(ApexColor.bgPrimary)
    }
}
