import ApexCore
import ApexUI
import SwiftUI

/// `ConnectorGuide.tsx` as a pushed screen: the same prose for someone who has
/// never heard of MCP, with the web's annotated drawings rendered as images
/// (`gen-connector-figures.ts`) and their callouts under each.
public struct ConnectorGuideView: View {
    private let endpoint: String
    @State private var client: Client = .claude

    enum Client: String, CaseIterable, Hashable, Sendable {
        case claude, chatgpt, code, other

        var label: String {
            switch self {
            case .claude: "Claude"
            case .chatgpt: "ChatGPT"
            case .code: "Claude Code"
            case .other: "Something else"
            }
        }
    }

    public init(endpoint: String) {
        self.endpoint = endpoint
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                intro
                section("Step one, whichever app you use") {
                    paragraph("Every app needs the same thing first: your Apex address. Copy it now and paste it when the app asks for a server URL.")
                    CopyField(value: endpoint, toast: "Address copied", identifier: "guide.endpoint")
                    muted("Treat this address as public — it is useless to anyone who cannot sign in as you. The sign-in step is what grants access, not the address.")
                }
                section("Which app are you setting up?") {
                    ChipRow(options: Client.allCases.map { ($0, $0.label) }, selection: $client, identifier: "guide.client")
                    muted("The pictures below are drawings of Claude and ChatGPT, not photographs. Both apps change often, so a button may sit an inch from where it appears here — the wording is what to look for.")
                }
                steps
                askSection
                offSection
                troubleSection
                glossary
            }
            .padding(Spacing.screen)
        }
        .youScreen("Connecting an AI assistant")
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("guide")
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            paragraph("This connects your Apex training log to an AI assistant, so you can ask about your own training in plain English — “How did my squat progress this block?”, “What's on my calendar this week?”, “Any PRs last month?” — and get answers from your real numbers instead of guesses.")
            paragraph("Setting it up means giving the assistant one web address and signing in once to prove the account is yours. It takes about two minutes. There is nothing to install and no code to write.")
            callout(symbol: ApexIcon.shield.systemName, "The assistant can only read. It can look at your workouts, schedule, meals and records. It cannot add, change or delete anything — not a workout, not a meal, not a single set. You can cut off its access at any moment from the AI connector screen you just came from.")
        }
    }

    @ViewBuilder
    private var steps: some View {
        switch client {
        case .claude:
            step(1, "Open Claude's connector settings") {
                paragraph("In the Claude desktop app, open Settings — under the Claude menu at the top of the screen on a Mac, or the ☰ menu on Windows. On the website, click your name in the bottom-left corner and choose Settings. Then pick Connectors.")
                FigureView(ConnectorFigures.claudeConnectors)
            }
            step(2, "Add the Apex address") {
                paragraph("Click Add custom connector, paste the address you copied above, and — this is the important part — leave the OAuth boxes empty.")
                FigureView(ConnectorFigures.claudeAddDialog)
                callout("Why are those boxes empty? Some services make you register by hand and email you a pair of secret codes. Apex does not. When Claude first knocks on the door, Apex hands it a set of credentials automatically. Typing anything into those boxes will break the connection.")
            }
            step(3, "Sign in to Apex and allow it") {
                paragraph("Claude opens your web browser at an Apex page asking whether to allow the connection. Sign in with your normal Apex email and password if you are not already signed in, then click Allow. You are handed back to Claude, and that is the whole setup.")
                FigureView(ConnectorFigures.apexConsent)
            }
            step(4, "Switch it on in a conversation") {
                paragraph("Claude does not use a connector until you turn it on for that chat. Open a new conversation, click the + button in the message box, and switch on Apex Training.")
                FigureView(ConnectorFigures.claudeChat)
                paragraph("Now ask it something. A good first question is “Using Apex, what did I train last week?” — naming Apex nudges it to actually look rather than answer from memory. The first time it reaches for your data it will ask your permission; say yes.")
            }
        case .chatgpt:
            callout("Before you start: custom connectors in ChatGPT need a paid plan — Plus, Pro, Business, Enterprise or Edu. On the free plan the options below will not appear, and there is no way around that from the Apex side.")
            step(1, "Turn on developer mode") {
                paragraph("Open Settings → Apps & Connectors → Advanced settings and switch on Developer mode. The name sounds alarming; all it does is let you add a connector that is not in ChatGPT's official list. It changes nothing else about your account.")
                FigureView(ConnectorFigures.gptDeveloperMode)
            }
            step(2, "Create the Apex connector") {
                paragraph("Back on Settings → Apps & Connectors, click Create. Give it a name, paste your Apex address, choose OAuth for authentication, and leave any client ID or secret boxes empty — same reason as in Claude: ChatGPT and Apex sort that out between themselves.")
                FigureView(ConnectorFigures.gptCreate)
            }
            step(3, "Sign in to Apex and allow it") {
                paragraph("ChatGPT sends you to an Apex page asking whether to allow the connection. Check the web address really is your Apex site, sign in, and click Allow.")
                FigureView(ConnectorFigures.apexConsent)
            }
            step(4, "Switch it on in a conversation") {
                paragraph("In a chat, open the + or Tools menu in the message box and enable Apex Training, then ask your question.")
                FigureView(ConnectorFigures.gptChat)
                callout("Deep research is different. ChatGPT's deep-research mode only accepts connectors built in one specific shape, which Apex is not. Apex works in normal chat; it will not show up as a deep-research source.")
            }
        case .code:
            paragraph("Claude Code can do the same browser sign-in as the Claude app, but it also accepts an access token — a long password you create here and paste into a command. Tokens are handy on a machine where opening a browser is awkward.")
            step(1, "Create a token in Apex") {
                paragraph("Go back one screen to AI connector, type a name for the token, and press Create token. Copy the result straight away — Apex keeps only a scrambled copy and can never show it to you again.")
                FigureView(ConnectorFigures.apexToken)
            }
            step(2, "Add Apex to Claude Code") {
                paragraph("Run this in a terminal, replacing apx_… with the token you just copied:")
                code("claude mcp add --transport http apex \\\n  \(endpoint) \\\n  --header \"Authorization: Bearer apx_...\"")
                CopyField(value: "claude mcp add --transport http apex \(endpoint) --header \"Authorization: Bearer apx_...\"", toast: "Command copied", identifier: "guide.command")
                paragraph("Prefer the browser sign-in? Leave the header off — claude mcp add --transport http apex \(endpoint) — then type /mcp inside Claude Code and follow the prompts.")
            }
            step(3, "Check it worked") {
                paragraph("Type /mcp in Claude Code. Apex should be listed as connected. Then ask it something like “what's my best bench press?”")
            }
        case .other:
            paragraph("Any app that speaks MCP over the web will work. There are two shapes it might take:")
            step(1, "If the app can sign you in") {
                paragraph("Give it the Apex address and nothing else. It will discover how to authenticate on its own and send you to the Apex permission page.")
            }
            step(2, "If the app only accepts a token") {
                paragraph("Create a token on the previous screen and have the app send it as a header:")
                code("Authorization: Bearer apx_...")
            }
            step(3, "If the app cannot do either") {
                paragraph("Older apps that only run local programs can be bridged. With Node.js installed:")
                code("npx mcp-remote \(endpoint) \\\n  --header \"Authorization: Bearer apx_...\"")
            }
        }
    }

    private var askSection: some View {
        section("What you can ask it") {
            paragraph("You never have to name a tool or learn any syntax — ask the question you would ask a coach. Behind the scenes the assistant picks from these:")
            VStack(alignment: .leading, spacing: Spacing.sm) {
                ask("“What's planned this week?”", "Your schedule, and what you have already ticked off")
                ask("“How did Tuesday's session go?”", "The full workout with every set you logged")
                ask("“Is my bench pressing progressing?”", "One exercise over time, best ever and recent trend")
                ask("“Any records lately?”", "PRs, all-time or within a stretch of time, and what they beat")
                ask("“Summarise July.”", "Sessions, tonnage, distance, elevation, streaks")
                ask("“Am I on target this block?”", "Training blocks and how attainment is tracking")
                ask("“How was my protein this week?”", "Meals with daily totals")
            }
            muted("Every number — estimated one-rep maxes, tonnage, streaks — is worked out by Apex itself using the same code the app screens use. The assistant repeats those figures rather than doing its own arithmetic, so what it tells you matches what you see here.")
        }
    }

    private var offSection: some View {
        section("Turning it off again") {
            paragraph("Everything is reversible from the AI connector screen you came from:")
            bullet("Connected apps — each app that signed in is listed with an ✕ beside it. Tapping it cuts that app off immediately and completely.")
            bullet("Access tokens — listed by the name you gave them, with the last four characters so you can tell them apart. Revoking one stops it working at once.")
            bullet("Inside Claude, the connector's own settings also let you block individual abilities, and Claude asks before using each one for the first time in a conversation.")
        }
    }

    private var troubleSection: some View {
        section("If something isn't working") {
            faq("The assistant says it can't see any training data.", "Nine times out of ten the connector is simply switched off for that conversation. Open the + menu in the message box and check the toggle. Starting a fresh chat and turning it on there also works.")
            faq("It answers with numbers that look invented.", "Ask it to check Apex again, by name. Assistants will happily answer from what they remember earlier in the conversation rather than looking things up a second time.")
            faq("Adding the connector fails, or sign-in never starts.", "Check the address you pasted ends in /api/mcp with no trailing slash and no spaces, and that you left the OAuth boxes empty. If it still fails, the site itself may not be reachable — open your Apex address in a browser and make sure the app loads.")
            faq("It worked yesterday and stopped today.", "Check the AI connector screen: if the app is no longer under Connected apps, someone disconnected it — just set it up again. If you were using a token, it may have been revoked.")
            faq("It complains about being rate limited.", "There is a ceiling of 300 requests an hour on your account, which normal conversation never approaches. Wait a few minutes.")
        }
    }

    private var glossary: some View {
        section("The words these apps use") {
            term("Connector", "The link between an assistant and an outside service. Apex is one connector among however many you add.")
            term("MCP server", "The technical name for the thing at the end of your Apex address. When an app asks for an “MCP server URL”, it wants that address.")
            term("OAuth", "The sign-in dance that lets you approve an app without ever giving it your password. It is what the Allow screen is doing.")
            term("Access token", "A long password-like string that stands in for signing in, for tools that cannot open a browser. Anyone holding it can read your training data, so treat it like a password.")
            term("Read-only", "The connection can look but not touch. Everything Apex offers through it is read-only.")
        }
    }

    // MARK: - Pieces

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text(title)
                .font(.apex(.display, size: TypeScale.lg, weight: .semibold, relativeTo: .headline))
                .foregroundStyle(ApexColor.textPrimary)
            content()
        }
    }

    private func step(_ n: Int, _ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            HStack(spacing: Spacing.sm) {
                Text("\(n)")
                    .font(.apex(.mono, size: TypeScale.xs, weight: .medium, relativeTo: .caption))
                    .foregroundStyle(ApexColor.bgPrimary)
                    .frame(width: 22, height: 22)
                    .background(ApexPalette.positive, in: .circle)
                Text(title)
                    .font(.apex(.display, size: TypeScale.base, weight: .semibold, relativeTo: .headline))
                    .foregroundStyle(ApexColor.textPrimary)
            }
            content()
        }
    }

    private func paragraph(_ text: String) -> some View {
        Text(text).apexBody().fixedSize(horizontal: false, vertical: true)
    }

    private func muted(_ text: String) -> some View {
        Text(text)
            .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
            .foregroundStyle(ApexColor.textMuted)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func callout(symbol: String? = nil, _ text: String) -> some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            if let symbol {
                Image(systemName: symbol).fontWeight(.light).foregroundStyle(ApexPalette.positive)
            }
            Text(text)
                .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                .foregroundStyle(ApexColor.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.md))
        .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
    }

    private func code(_ text: String) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(text)
                .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                .foregroundStyle(ApexColor.textPrimary)
                .padding(Spacing.md)
        }
        .background(ApexColor.bgElevated, in: .rect(cornerRadius: Radius.md))
    }

    private func ask(_ question: String, _ answer: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(question).font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout)).italic().foregroundStyle(ApexColor.textPrimary)
            Text(answer).font(.apex(.display, size: TypeScale.sm, relativeTo: .callout)).foregroundStyle(ApexColor.textSecondary)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            Text("•").foregroundStyle(ApexColor.textMuted)
            paragraph(text)
        }
    }

    private func faq(_ question: String, _ answer: String) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(question).font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .callout)).foregroundStyle(ApexColor.textPrimary)
            Text(answer).font(.apex(.display, size: TypeScale.sm, relativeTo: .callout)).foregroundStyle(ApexColor.textSecondary)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func term(_ word: String, _ meaning: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(word).font(.apex(.mono, size: TypeScale.xs, weight: .medium, relativeTo: .caption)).foregroundStyle(ApexColor.textPrimary)
            Text(meaning).font(.apex(.display, size: TypeScale.sm, relativeTo: .callout)).foregroundStyle(ApexColor.textSecondary)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// One annotated drawing with its numbered callouts beneath — the web's
/// `<Figure>`: the pins are text, so they stay selectable and readable.
struct FigureView: View {
    private let figure: ConnectorFigures.Figure

    init(_ figure: ConnectorFigures.Figure) { self.figure = figure }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Image(figure.assetName, bundle: ApexUIBundle.bundle)
                .resizable()
                .scaledToFit()
                .clipShape(.rect(cornerRadius: Radius.md))
                .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
                .accessibilityLabel(figure.title)
            Text(figure.title)
                .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                .foregroundStyle(ApexColor.textPrimary)
            ForEach(Array(figure.pins.enumerated()), id: \.offset) { index, pin in
                HStack(alignment: .top, spacing: Spacing.sm) {
                    Text("\(index + 1)")
                        .font(.apex(.mono, size: TypeScale.micro, weight: .medium, relativeTo: .caption2))
                        .foregroundStyle(ApexColor.bgPrimary)
                        .frame(width: 18, height: 18)
                        .background(ApexPalette.positive, in: .circle)
                    Text(pin)
                        .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                        .foregroundStyle(ApexColor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let note = figure.note {
                Text(note)
                    .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityIdentifier("guide.figure.\(figure.id)")
    }
}
