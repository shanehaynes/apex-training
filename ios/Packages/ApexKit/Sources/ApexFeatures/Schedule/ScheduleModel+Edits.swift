import ApexCore
import ApexUI
import Foundation

// The event sheet's and the builder's writes (W7). Direct, online-only,
// optimistic against the index with a rollback — the completion toggle's
// pattern, never the tracker's queue (D-027).
extension ScheduleModel {
    /// Apply → send → on failure roll back and toast; on success write the
    /// window back (an offline relaunch shows the edit) and refresh, because
    /// realtime does not announce every row a write touches.
    @discardableResult
    public func commit(_ edit: ScheduleEdit) async -> Bool {
        guard let before = index else { return false }
        index = edit.apply(to: before)
        do {
            _ = try await deps.client.data(for: edit.endpoint())
        } catch {
            index = before
            ToastBus.shared.post(Self.isNetwork(error) ? "No connection — \(edit.failureToast.lowercased())" : edit.failureToast, level: .failure)
            return false
        }
        await persistIndex()
        await refresh(reason: .afterEdit)
        return true
    }

    /// The builder's Apply. nil = the request never landed (toasted here);
    /// `ok: false` = the server's validation, for the sheet to show inline.
    public func applyDraft(_ draft: WorkoutDraft, action: WorkoutDraftAction) async throws -> WorkoutDraftResponse {
        let data = try await deps.client.data(for: .workoutDraft(draft: draft, today: today.string, action: action))
        let response = try JSONDecoder().decode(WorkoutDraftResponse.self, from: data)
        guard response.ok else { return response }
        if let current = index, let event = response.event, let id = response.id, let date = response.date {
            switch action {
            case .create where response.isRecurring != true:
                let stamp = response.completedOnCreate == true ? CompletionRows.isoTimestamp(deps.clock.now) : nil
                index = current.inserting(base: event, occurrence: Occurrence(
                    id: id, baseId: id, date: date, originalDate: date, startTime: event.startTime, endTime: event.endTime,
                    isCompleted: response.completedOnCreate == true, completedAt: stamp
                ))
            case .create:
                // A new series: the server expands it; the refresh below shows it.
                break
            case .update:
                index = current.replacing(base: event)
            case .detach(let eventId, _):
                index = current.removing(occurrenceId: eventId).inserting(base: event, occurrence: Occurrence(
                    id: id, baseId: id, date: date, originalDate: date, startTime: event.startTime, endTime: event.endTime
                ))
            }
            await persistIndex()
        }
        await refresh(reason: .afterEdit)
        return response
    }

    /// The Builder's Save with no signal (the user's call against D-027's
    /// online-only line): queued in the outbox, said, and shown on its day as
    /// waiting to sync until the server has it. A new event carries the id it
    /// will take, so a replay of a save whose answer was lost lands once.
    /// false = no queue (signed out) or the queue would not take it.
    public func queueDraft(_ draft: WorkoutDraft, action: WorkoutDraftAction) async -> Bool {
        guard let queue = writeQueue else { return false }
        let payload = WorkoutDraftOpPayload(
            draft: draft, today: today.string, action: action, clientId: "ai-" + UUID().uuidString.lowercased()
        )
        do {
            try await queue.enqueue(.workoutDraft(payload), for: .outbox)
        } catch {
            return false
        }
        ToastBus.shared.post("No connection — saved here. It appears on the calendar once you're back online.", level: .info)
        await reloadOutbox()
        // As with an offline create: the failed try may have been a timeout
        // with the path still up, and then no "network back" will come.
        Task { await queue.flush(.outbox) }
        return true
    }

    /// Drops a refused save — fixed and saved again, or let go.
    public func dismissRefusedSave(_ id: Int64) async {
        await writeQueue?.discard(id, in: .outbox)
        await reloadOutbox()
    }

    /// Archive (or restore) a library template; the cached list follows.
    public func archiveTemplate(id: String, archived: Bool) async -> Bool {
        let stamp = archived ? CompletionRows.isoTimestamp(deps.clock.now) : nil
        do {
            _ = try await deps.client.data(for: .archiveTemplate(id: id, archivedAt: stamp))
        } catch {
            ToastBus.shared.post(archived ? "Couldn't remove it from the library — try again" : "Couldn't restore it — try again", level: .failure)
            return false
        }
        let updated = await templates().map { template -> WorkoutTemplate in
            guard template.id == id else { return template }
            return WorkoutTemplate(
                id: template.id, title: template.title, type: template.type, sport: template.sport, scoringType: template.scoringType,
                timeCapMinutes: template.timeCapMinutes, estimatedDuration: template.estimatedDuration, difficulty: template.difficulty,
                description: template.description, warmup: template.warmup, exercises: template.exercises, cooldown: template.cooldown,
                location: template.location, tags: template.tags, equipment: template.equipment, cardioTargets: template.cardioTargets,
                climbingTargets: template.climbingTargets, archivedAt: stamp, updatedAt: template.updatedAt
            )
        }
        if let json = try? JSONEncoder().encode(updated) {
            try? await deps.cache.write(CacheEntry(kind: .templates, key: ScheduleCacheKey.templates, json: json, fetchedAt: deps.clock.now))
        }
        return true
    }

    /// The picker's inline create (`ExercisePicker` on the web) — the Library's
    /// and the Builder's: the id is the slug, the row lands immediately so the
    /// entry can reference it. With no signal the write waits in the queue's
    /// outbox lane instead of failing, and the row is offered here meanwhile
    /// (`definitions()` overlays it); a refusal is a toast.
    public func createDefinition(name: String, category: String, isUnilateral: Bool) async -> ExerciseDefinition? {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        let id = Slug.name(trimmed)
        guard !id.isEmpty else { return nil }
        let definition = ExerciseDefinition(
            id: id, canonicalName: trimmed, aliases: [], category: category, muscleGroups: [], equipment: [], isUnilateral: isUnilateral
        )
        do {
            _ = try await deps.client.data(for: .createDefinition(id: id, canonicalName: trimmed, category: category, isUnilateral: isUnilateral))
        } catch {
            guard Self.isNetwork(error), let queue = writeQueue else {
                ToastBus.shared.post("Couldn't add the exercise — try again", level: .failure)
                return nil
            }
            let payload = DefinitionCreatePayload(id: id, canonicalName: trimmed, category: category, isUnilateral: isUnilateral)
            do {
                try await queue.enqueue(.createDefinition(payload), for: .outbox)
            } catch {
                ToastBus.shared.post("Couldn't add the exercise — try again", level: .failure)
                return nil
            }
            ToastBus.shared.post("No connection — “\(trimmed)” is added here and syncs when you're back online", level: .info)
            // Start the lane now: the try above may have timed out with the
            // path still up, and then no "network back" trigger will come.
            Task { await queue.flush(.outbox) }
        }
        await rememberDefinition(definition)
        return definition
    }

    /// Puts a definition in the cached list every picker reads, ahead of the
    /// server: the create above after its write, and the tracker's queued
    /// create (made offline mid-workout) before its write lands.
    public func rememberDefinition(_ definition: ExerciseDefinition) async {
        let updated = await definitions().filter { $0.id != definition.id } + [definition]
        if let json = try? JSONEncoder().encode(updated) {
            try? await deps.cache.write(CacheEntry(kind: .definitions, key: ScheduleCacheKey.definitions, json: json, fetchedAt: deps.clock.now))
        }
    }
}
