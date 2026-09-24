import ApexCore
import ApexUI
import SwiftUI

/// The first-run tour (W13, U32): the web's `WelcomeFlow` as a native paged
/// flow — swipe or Next between pages, a step's own button where it has one,
/// Skip at any point, Start training at the end. Shows exactly once per
/// account: finishing or skipping latches `profiles.onboarding_dismissed_at`.
///
/// Four pages, one step each, the same four as the web (D-O05; the page table
/// is `OnboardingModel.welcomePages`). One progress indicator, the dots — the
/// "STEP 2 OF 8" eyebrow said the same thing a third time, after the dots and
/// Back/Next.
public struct WelcomeFlowView: View {
    @Bindable private var model: OnboardingModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(model: OnboardingModel) {
        self.model = model
    }

    private var pages: [OnboardingModel.WelcomePage] { model.welcomePages }
    private var isLast: Bool { model.pageIndex >= pages.count - 1 }

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

            TabView(selection: $model.pageIndex) {
                ForEach(Array(pages.enumerated()), id: \.element.id) { index, page in
                    self.page(page)
                        .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .animation(reduceMotion ? nil : Motion.spring, value: model.pageIndex)

            footer
        }
        .background(ApexColor.bgPrimary.ignoresSafeArea())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.welcome")
    }

    private func page(_ page: OnboardingModel.WelcomePage) -> some View {
        // The identifiers the smoke drives are the page's, not the step's, so
        // they stay unique however the steps regroup: the page's first step
        // carries the bare id, the rest carry theirs suffixed.
        let firstActionID = page.steps.first { $0.action != nil }?.id
        return ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                ForEach(Array(page.steps.enumerated()), id: \.element.id) { position, step in
                    section(step, isPageTitle: position == 0, ownsPageAction: step.id == firstActionID)
                }
                if let row = model.extraRow(for: page) {
                    checklistSection(row)
                }
            }
            .frame(maxWidth: 480, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Spacing.screen)
            .padding(.vertical, Spacing.xl)
        }
    }

    @ViewBuilder
    private func section(_ step: OnboardingCatalog.Step, isPageTitle: Bool, ownsPageAction: Bool) -> some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            title(step, isPageTitle: isPageTitle)
            // Markdown, so a button named in **bold** reads bold, as on the web.
            Text(Self.markdown(step.body))
                .apexBody()
                .fixedSize(horizontal: false, vertical: true)
            if let action = step.action {
                ApexButton(action.label, kind: .secondary, isLoading: action.kind == .copyTemplate && model.isCopying) {
                    Task { await model.run(action, for: step.id) }
                }
                .accessibilityIdentifier(ownsPageAction ? "onboarding.welcome.action" : "onboarding.welcome.action.\(step.id)")
                .padding(.top, Spacing.xs)
            }
            if let link = step.link, let url = model.destination(for: link) {
                Link(link.label, destination: url)
                    .font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textSecondary)
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("onboarding.welcome.link")
            }
        }
    }

    /// A checklist row shown inside the flow — same shape as a step, different
    /// source (`OnboardingModel.extraRow(for:)`).
    private func checklistSection(_ row: OnboardingCatalog.ChecklistItem) -> some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            Text(row.label)
                .font(.apex(.display, size: TypeScale.lg, weight: .semibold, relativeTo: .headline))
                .foregroundStyle(ApexColor.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("onboarding.welcome.title.\(row.id.rawValue)")
            Text(row.hint)
                .apexBody()
                .fixedSize(horizontal: false, vertical: true)
            ApexButton(row.action.label, kind: .secondary) {
                Task { await model.run(row.action, for: row.id.rawValue) }
            }
            .accessibilityIdentifier("onboarding.welcome.action.\(row.id.rawValue)")
            .padding(.top, Spacing.xs)
        }
    }

    @ViewBuilder
    private func title(_ step: OnboardingCatalog.Step, isPageTitle: Bool) -> some View {
        let text = Text(step.title).fixedSize(horizontal: false, vertical: true)
        if isPageTitle {
            text
                .apexTitle()
                .accessibilityIdentifier("onboarding.welcome.title")
        } else {
            // A second heading on the same page, a step down from the page's
            // own title — sentence case, because it is a sentence, and the
            // smoke matches these labels verbatim.
            text
                .font(.apex(.display, size: TypeScale.lg, weight: .semibold, relativeTo: .headline))
                .foregroundStyle(ApexColor.textPrimary)
                .accessibilityIdentifier("onboarding.welcome.title.\(step.id)")
        }
    }

    /// `**bold**` → bold; the plain string if the copy is not valid markdown,
    /// so a stray asterisk shows as itself rather than blanking the step.
    static func markdown(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }

    private var footer: some View {
        VStack(spacing: Spacing.lg) {
            HStack(spacing: Spacing.sm) {
                ForEach(pages.indices, id: \.self) { index in
                    Circle()
                        .fill(index == model.pageIndex ? ApexColor.textPrimary : ApexColor.borderSubtle)
                        .frame(width: 6, height: 6)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Page")
            .accessibilityValue("\(model.pageIndex + 1) of \(pages.count)")
            .accessibilityIdentifier("onboarding.welcome.count")
            HStack(spacing: Spacing.md) {
                if model.pageIndex > 0 {
                    ApexButton("Back", kind: .secondary) { model.pageIndex -= 1 }
                        .frame(maxWidth: 120)
                        .accessibilityIdentifier("onboarding.welcome.back")
                }
                ApexButton(isLast ? "Start training" : "Next") {
                    if isLast {
                        Task { await model.dismissWelcome() }
                    } else {
                        model.pageIndex += 1
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
