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
    public func applyDraft(_ draft: WorkoutDraft, action: WorkoutDraftAction) async -> WorkoutDraftResponse? {
        let response: WorkoutDraftResponse
        do {
            let data = try await deps.client.data(for: .workoutDraft(draft: draft, today: today.string, action: action))
            response = try JSONDecoder().decode(WorkoutDraftResponse.self, from: data)
        } catch {
            ToastBus.shared.post(Self.isNetwork(error) ? "No connection — couldn't save. Try again when you're back online." : "Failed to save — try again", level: .failure)
            return nil
        }
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

    /// The picker's inline create (`ExercisePicker` on the web): the id is the
    /// slug, the row lands immediately so the entry can reference it.
    public func createDefinition(name: String, category: String, isUnilateral: Bool) async -> ExerciseDefinition? {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        let id = Slug.name(trimmed)
        guard !id.isEmpty else { return nil }
        do {
            _ = try await deps.client.data(for: .createDefinition(id: id, canonicalName: trimmed, category: category, isUnilateral: isUnilateral))
        } catch {
            ToastBus.shared.post("Couldn't add the exercise — try again", level: .failure)
            return nil
        }
        let definition = ExerciseDefinition(
            id: id, canonicalName: trimmed, aliases: [], category: category, muscleGroups: [], equipment: [], isUnilateral: isUnilateral
        )
        let updated = await definitions().filter { $0.id != id } + [definition]
        if let json = try? JSONEncoder().encode(updated) {
            try? await deps.cache.write(CacheEntry(kind: .definitions, key: ScheduleCacheKey.definitions, json: json, fetchedAt: deps.clock.now))
        }
        return definition
    }
}
