import Foundation

/// Splits a byte stream into complete lines.
///
/// The coach stream is NDJSON over a chunked response, so a chunk boundary can
/// land anywhere — mid-line, or mid-UTF-8-character. Decoding each chunk as text
/// on arrival corrupts multi-byte characters at those boundaries, so this buffers
/// bytes and only decodes once a newline has been seen.
public struct NDJSONLineParser: Sendable {
    private var buffer = Data()

    public init() {}

    /// Complete lines contained in everything received so far. Blank lines are
    /// dropped: the protocol has no use for them and `JSONDecoder` would throw.
    public mutating func consume(_ chunk: Data) -> [String] {
        buffer.append(chunk)
        var lines: [String] = []
        while let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let raw = buffer[buffer.startIndex..<newline]
            buffer = buffer[buffer.index(after: newline)...]
            if let line = Self.text(raw) { lines.append(line) }
        }
        // Re-base so the next append does not keep growing a sliced Data.
        buffer = Data(buffer)
        return lines
    }

    /// Whatever is left when the stream ends. A well-behaved server ends with a
    /// newline, but a truncated stream leaves a final partial line that would
    /// otherwise be dropped silently.
    public mutating func finish() -> [String] {
        defer { buffer = Data() }
        return Self.text(buffer).map { [$0] } ?? []
    }

    private static func text(_ bytes: some DataProtocol) -> String? {
        var line = String(decoding: bytes, as: UTF8.self)
        if line.hasSuffix("\r") { line.removeLast() }
        return line.trimmingCharacters(in: .whitespaces).isEmpty ? nil : line
    }
}
