import Foundation

/// The block structure of the coach's text (D-014). The model emits light
/// markdown — headings, lists, bold, the odd code fence — that the web shows
/// raw. Splitting into blocks is plain `String` work and lives here so Linux
/// can test it; the inline pass (`AttributedString(markdown:)`) is Apple-only
/// and lives in `ApexUI`. Streaming-tolerant: an unterminated fence renders
/// as code rather than swallowing the rest of the message.
public enum MarkdownBlock: Sendable, Equatable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case list(ordered: Bool, items: [String])
    case code(String, language: String?)
}

public enum MarkdownBlocks {
    public static func parse(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var list: (ordered: Bool, items: [String])?
        var code: (language: String?, lines: [String])?

        func flushParagraph() {
            if !paragraph.isEmpty {
                blocks.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph = []
            }
        }
        func flushList() {
            if let current = list {
                blocks.append(.list(ordered: current.ordered, items: current.items))
                list = nil
            }
        }

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine).replacingOccurrences(of: "\r", with: "")
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if var open = code {
                if trimmed.hasPrefix("```") {
                    blocks.append(.code(open.lines.joined(separator: "\n"), language: open.language))
                    code = nil
                } else {
                    open.lines.append(line)
                    code = open
                }
                continue
            }

            if trimmed.hasPrefix("```") {
                flushParagraph()
                flushList()
                let language = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                code = (language: language.isEmpty ? nil : language, lines: [])
                continue
            }

            if trimmed.isEmpty {
                flushParagraph()
                flushList()
                continue
            }

            if let heading = headingLine(trimmed) {
                flushParagraph()
                flushList()
                blocks.append(.heading(level: heading.level, text: heading.text))
                continue
            }

            if let item = listItem(trimmed) {
                flushParagraph()
                if let current = list, current.ordered == item.ordered {
                    list = (ordered: current.ordered, items: current.items + [item.text])
                } else {
                    flushList()
                    list = (ordered: item.ordered, items: [item.text])
                }
                continue
            }

            flushList()
            paragraph.append(trimmed)
        }

        flushParagraph()
        flushList()
        if let open = code {
            blocks.append(.code(open.lines.joined(separator: "\n"), language: open.language))
        }
        return blocks
    }

    private static func headingLine(_ line: String) -> (level: Int, text: String)? {
        let hashes = line.prefix { $0 == "#" }
        guard (1...3).contains(hashes.count) else { return nil }
        let rest = line.dropFirst(hashes.count)
        guard rest.first == " " else { return nil }
        let text = rest.trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : (hashes.count, text)
    }

    private static func listItem(_ line: String) -> (ordered: Bool, text: String)? {
        if let first = line.first, "-*•".contains(first) {
            let rest = line.dropFirst()
            guard rest.first == " " else { return nil }
            return (false, rest.trimmingCharacters(in: .whitespaces))
        }
        let digits = line.prefix { $0.isNumber }
        guard !digits.isEmpty, digits.count <= 3 else { return nil }
        let afterDigits = line.dropFirst(digits.count)
        guard let marker = afterDigits.first, marker == "." || marker == ")" else { return nil }
        let rest = afterDigits.dropFirst()
        guard rest.first == " " else { return nil }
        return (true, rest.trimmingCharacters(in: .whitespaces))
    }
}
