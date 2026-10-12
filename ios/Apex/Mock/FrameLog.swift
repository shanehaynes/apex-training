#if DEBUG
import os
import QuartzCore
import UIKit

/// `-apexFrameLog` (DEBUG): a `CADisplayLink` on the main run loop, in the
/// common modes so it keeps firing while a scroll view tracks a finger, that
/// logs every frame the main thread delivered late. The simulator has no
/// Hitches instrument, so this is how a scroll's smoothness is measured there:
///
///   xcrun simctl spawn <udid> log show --last 2m --info \
///     --predicate 'subsystem == "com.shanehaynes.apextraining" AND category == "frames"'
///
/// Each line is one late frame — the gap since the previous frame and how
/// many frame periods it spanned — plus a running total. A fling that
/// realizes a card mid-scroll shows as a burst of `late` lines; a smooth one
/// shows none. The same line is a proxy for a hitch on a device: the period is
/// the link's own cadence (`targetTimestamp - timestamp`, not `duration`, which
/// reports the panel's rate), and the link asks for 120 Hz so a ProMotion
/// phone is judged against 8.3 ms rather than the 60 Hz a plain link gets.
@MainActor
enum FrameLog {
    private static let logger = Logger(subsystem: "com.shanehaynes.apextraining", category: "frames")
    private static var link: CADisplayLink?
    private static var lastTimestamp: CFTimeInterval = 0
    private static var frames = 0
    private static var late = 0
    private static var lateTime: CFTimeInterval = 0

    static func startIfRequested() {
        guard CommandLine.arguments.contains("-apexFrameLog"), link == nil else { return }
        let link = CADisplayLink(target: Target.self, selector: #selector(Target.tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        self.link = link
        logger.info("frame log started")
    }

    /// Late is anything past 1.5 periods: the frame after it was presented
    /// at least one vsync behind.
    fileprivate static func tick(_ link: CADisplayLink) {
        defer { lastTimestamp = link.timestamp }
        guard lastTimestamp > 0 else { return }
        frames += 1
        let gap = link.timestamp - lastTimestamp
        let cadence = link.targetTimestamp - link.timestamp
        let period = cadence > 0 ? cadence : 1.0 / 60
        guard gap > period * 1.5 else { return }
        late += 1
        lateTime += gap - period
        let missed = Int((gap / period).rounded()) - 1
        logger.info("late frame gap=\(Int(gap * 1000))ms missed=\(missed) frames=\(frames) late=\(late) lateTotal=\(Int(lateTime * 1000))ms")
    }

    @MainActor private final class Target: NSObject {
        @objc static func tick(_ link: CADisplayLink) { FrameLog.tick(link) }
    }
}
#endif
