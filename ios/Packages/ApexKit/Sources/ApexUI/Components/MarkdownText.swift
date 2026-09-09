import ApexCore
import SwiftUI

/// The coach's text, rendered (D-014). Block structure comes from
/// `ApexCore.MarkdownBlocks` (tested on Linux); each block's inline styles —
/// bold, italic, code, links — go through `AttributedString(markdown:)` with
/// whitespace preserved, so a single newline still breaks the line the way
/// the web's `pre-wrap` did. Anything the parser refuses renders as plain text.
public struct MarkdownText: View {
    private let blocks: [MarkdownBlock]
    private let color: Color

    public init(_ text: String, color: Color = ApexColor.textPrimary) {
        self.blocks = MarkdownBlocks.parse(text)
        self.color = color
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                render(block)
            }
        }
        .foregroundStyle(color)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func render(_ block: MarkdownBlock) -> some View {
        switch block {
        case .paragraph(let text):
            inline(text)
                .font(.apex(.display, size: TypeScale.base, relativeTo: .body))
                .fixedSize(horizontal: false, vertical: true)
        case .heading(let level, let text):
            inline(text)
                .font(.apex(.display, size: level == 1 ? TypeScale.lg : TypeScale.base, weight: .semibold, relativeTo: .headline))
                .padding(.top, Spacing.xs)
                .fixedSize(horizontal: false, vertical: true)
        case .list(let ordered, let items):
            VStack(alignment: .leading, spacing: Spacing.xs) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                        Text(ordered ? "\(index + 1)." : "•")
                            .font(.apex(.mono, size: TypeScale.sm, relativeTo: .body))
                            .foregroundStyle(ApexColor.textMuted)
                            .frame(minWidth: 16, alignment: .trailing)
                        inline(item)
                            .font(.apex(.display, size: TypeScale.base, relativeTo: .body))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        case .code(let text, _):
            Text(text)
                .font(.apex(.mono, size: TypeScale.sm, relativeTo: .callout))
                .padding(Spacing.sm)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(ApexColor.bgPrimary, in: .rect(cornerRadius: Radius.sm))
                .overlay(RoundedRectangle(cornerRadius: Radius.sm).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
        }
    }

    private func inline(_ text: String) -> Text {
        var options = AttributedString.MarkdownParsingOptions()
        options.interpretedSyntax = .inlineOnlyPreservingWhitespace
        if let attributed = try? AttributedString(markdown: text, options: options) {
            return Text(attributed)
        }
        return Text(text)
    }
}
