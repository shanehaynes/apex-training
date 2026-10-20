import ApexCore
import ApexSpeech
import ApexUI
import SwiftUI

/// The tracker's voice line (W17, D-059): what the recognizer hears, what the
/// set became, or what to do next. A pure view over `VoiceLogState`, in the
/// sync strip's chrome; every tap is a callback into the model.
public struct VoiceStrip: View {
    public let state: VoiceLogState
    public var onUndo: () -> Void
    public var onConfirm: (SpokenExercise.Candidate) -> Void
    public var onPick: () -> Void
    public var onRetry: () -> Void
    public var onSettings: () -> Void
    public var onDismiss: () -> Void

    public init(
        state: VoiceLogState,
        onUndo: @escaping () -> Void = {},
        onConfirm: @escaping (SpokenExercise.Candidate) -> Void = { _ in },
        onPick: @escaping () -> Void = {},
        onRetry: @escaping () -> Void = {},
        onSettings: @escaping () -> Void = {},
        onDismiss: @escaping () -> Void = {}
    ) {
        self.state = state
        self.onUndo = onUndo
        self.onConfirm = onConfirm
        self.onPick = onPick
        self.onRetry = onRetry
        self.onSettings = onSettings
        self.onDismiss = onDismiss
    }

    public var body: some View {
        content
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ApexColor.bgSurface)
            .overlay(alignment: .bottom) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 1) }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("tracker.voice.strip")
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case .idle, .unavailable:
            EmptyView()
        case .requesting:
            line(icon: .mic, "Allow the microphone to log sets by voice")
        case .activating:
            line(icon: .mic, "Starting…")
        case .listening(let partial, _), .finishing(let partial):
            HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                PulsingDot()
                Text("Listening…")
                    .font(.apex(.display, size: TypeScale.xs, weight: .medium, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textSecondary)
                Text(partial)
                    .font(.apex(.mono, size: TypeScale.sm, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textPrimary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityHidden(true)
                    .accessibilityIdentifier("tracker.voice.transcript")
            }
            .accessibilityAddTraits(.updatesFrequently)
        case .applied(_, let label):
            HStack(spacing: Spacing.sm) {
                ApexIcon.check.image.font(.system(size: 12, weight: .semibold)).foregroundStyle(ApexPalette.positive)
                Text(label)
                    .font(.apex(.display, size: TypeScale.xs, weight: .medium, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textPrimary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("tracker.voice.applied")
                stripButton("Undo", identifier: "tracker.voice.undo", action: onUndo)
            }
        case .confirming(_, let candidates):
            VStack(alignment: .leading, spacing: Spacing.xs) {
                HStack {
                    Text("Did you mean")
                        .font(.apex(.display, size: TypeScale.xs, weight: .medium, relativeTo: .caption))
                        .foregroundStyle(ApexColor.textSecondary)
                    Spacer()
                    dismissButton
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Spacing.xs) {
                        ForEach(candidates, id: \.id) { candidate in
                            Chip(candidate.name) { onConfirm(candidate) }
                                .accessibilityIdentifier("tracker.voice.chip.\(candidate.id)")
                        }
                        Chip("Pick…", action: onPick)
                            .accessibilityIdentifier("tracker.voice.pick")
                    }
                }
            }
        case .unresolved(let phrase, _):
            VStack(alignment: .leading, spacing: Spacing.xs) {
                HStack {
                    Text("No exercise named “\(phrase)”")
                        .font(.apex(.display, size: TypeScale.xs, weight: .medium, relativeTo: .caption))
                        .foregroundStyle(ApexColor.textPrimary)
                        .lineLimit(2)
                    Spacer()
                    dismissButton
                }
                HStack(spacing: Spacing.xs) {
                    Chip("Pick…", action: onPick)
                        .accessibilityIdentifier("tracker.voice.pick")
                    Chip("Try again", action: onRetry)
                        .accessibilityIdentifier("tracker.voice.retry")
                }
            }
        case .denied(let reason):
            HStack(spacing: Spacing.sm) {
                ApexIcon.warning.image.font(.system(size: 12)).foregroundStyle(ApexPalette.dangerText)
                Text(reason)
                    .font(.apex(.display, size: TypeScale.xs, weight: .medium, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textPrimary)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                stripButton("Settings", identifier: "tracker.voice.settings", action: onSettings)
                dismissButton
            }
        case .failed(_, let reason):
            HStack(spacing: Spacing.sm) {
                Text(reason)
                    .font(.apex(.display, size: TypeScale.xs, weight: .medium, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textPrimary)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                stripButton("Try again", identifier: "tracker.voice.retry", action: onRetry)
                dismissButton
            }
        }
    }

    private func line(icon: ApexIcon, _ text: String) -> some View {
        HStack(spacing: Spacing.sm) {
            icon.image.font(.system(size: 12))
            Text(text).font(.apex(.display, size: TypeScale.xs, weight: .medium, relativeTo: .caption))
        }
        .foregroundStyle(ApexColor.textSecondary)
    }

    private func stripButton(_ title: String, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.apex(.display, size: TypeScale.xs, weight: .semibold, relativeTo: .caption))
                .foregroundStyle(ApexColor.accent)
                .padding(.horizontal, Spacing.sm)
                // The HIG minimum, like the header's buttons.
                .frame(minHeight: 44)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
    }

    private var dismissButton: some View {
        Button(action: onDismiss) {
            ApexIcon.close.image
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(ApexColor.textMuted)
                .frame(width: 32, height: 44)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Dismiss")
        .accessibilityIdentifier("tracker.voice.dismiss")
    }
}

/// The accent dot that breathes while listening; still under Reduce Motion.
struct PulsingDot: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        Circle()
            .fill(ApexColor.accent)
            .frame(width: 8, height: 8)
            .opacity(dim ? 0.3 : 1)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) { dim = true }
            }
            .accessibilityHidden(true)
    }
}

/// The header's microphone (W17): 44 pt, quiet at rest, accent with the dot
/// while listening. Its value tells VoiceOver what the strip shows.
struct VoiceMicButton: View {
    let state: VoiceLogState
    let isDisabled: Bool
    let action: () -> Void

    private var isLive: Bool {
        switch state {
        case .requesting, .activating, .listening, .finishing: true
        default: false
        }
    }

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                ApexIcon.mic.image
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(isLive ? ApexColor.accent : ApexColor.textSecondary)
                    .frame(width: 44, height: 44)
                if isLive {
                    PulsingDot().offset(x: -8, y: 10)
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.5 : 1)
        .accessibilityLabel("Log a set by voice")
        .accessibilityValue(Self.value(for: state))
        .accessibilityIdentifier("tracker.voice")
    }

    static func value(for state: VoiceLogState) -> String {
        switch state {
        case .idle, .unavailable: "Not listening"
        case .requesting: "Asking for permission"
        case .activating: "Starting"
        case .listening(let partial, let heard): heard && !partial.isEmpty ? "Listening: \(partial)" : "Listening"
        case .finishing: "Finishing"
        case .applied(_, let label): label
        case .confirming: "Choose the exercise"
        case .unresolved(let phrase, _): "No exercise named \(phrase)"
        case .failed(_, let reason), .denied(let reason): reason
        }
    }
}
