import ApexCore
import Foundation

/// The voice journal on disk (W17): one JSON file under Application Support,
/// read once and written whole on every change — at most 200 entries, a few
/// hundred KB. Transcripts and outcomes only, never audio. One instance per
/// file: the tracker appends through `TrackerServices.journal`, You → Training
/// shares and clears the same `standard` store.
public final class FileVoiceJournalStore: VoiceJournalStoring, @unchecked Sendable {
    private let lock = NSLock()
    private let url: URL
    private var journal: VoiceJournal?

    public init(url: URL) {
        self.url = url
    }

    /// `Application Support/voice-journal.json` in the app's container.
    public static let standard: FileVoiceJournalStore = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return FileVoiceJournalStore(url: base.appendingPathComponent("voice-journal.json"))
    }()

    public func load() -> VoiceJournal { lock.withLock { loaded() } }

    public func append(_ entry: VoiceJournalEntry) {
        lock.withLock {
            var current = loaded()
            current.append(entry)
            persist(current)
        }
    }

    public func markLastUndone() {
        lock.withLock {
            var current = loaded()
            current.markLastUndone()
            persist(current)
        }
    }

    public func clear() {
        lock.withLock {
            journal = VoiceJournal()
            try? FileManager.default.removeItem(at: url)
        }
    }

    private func loaded() -> VoiceJournal {
        if let journal { return journal }
        let read = (try? Data(contentsOf: url)).flatMap { try? VoiceJournal.decode($0) } ?? VoiceJournal()
        journal = read
        return read
    }

    private func persist(_ current: VoiceJournal) {
        journal = current
        guard let data = try? current.exportJSON() else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }
}
