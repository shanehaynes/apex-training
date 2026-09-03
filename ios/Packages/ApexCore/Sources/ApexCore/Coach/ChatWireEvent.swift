import Foundation

/// One NDJSON line from `POST /api/chat` (src/lib/coach/wire.ts).
public enum ChatWireEvent: Decodable, Sendable, Equatable {
    case text(delta: String)
    /// A tool the coach wants to run. `label` is server-built, human-readable,
    /// and what the confirmation card shows — Swift never composes it.
    case toolUse(id: String, name: String, input: Data, label: String?)
    case done
    case error(message: String)

    private enum CodingKeys: String, CodingKey {
        case type, delta, id, name, input, label, error, message
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "text":
            self = .text(delta: try container.decodeIfPresent(String.self, forKey: .delta) ?? "")
        case "tool_use":
            // The input is arbitrary per-tool JSON; keep it as bytes and let the
            // feature that owns the tool decode it.
            let input = try container.decode(AnyCodable.self, forKey: .input)
            self = .toolUse(
                id: try container.decode(String.self, forKey: .id),
                name: try container.decode(String.self, forKey: .name),
                input: try JSONEncoder().encode(input),
                label: try container.decodeIfPresent(String.self, forKey: .label)
            )
        case "done":
            self = .done
        case "error":
            let message = try container.decodeIfPresent(String.self, forKey: .error)
                ?? container.decodeIfPresent(String.self, forKey: .message)
                ?? "Unknown error"
            self = .error(message: message)
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: container, debugDescription: "unknown chat event type \"\(type)\""
            )
        }
    }
}

/// Just enough to carry an arbitrary JSON value through without inspecting it.
struct AnyCodable: Codable {
    let value: Any?

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { value = nil }
        else if let v = try? container.decode(Bool.self) { value = v }
        else if let v = try? container.decode(Int.self) { value = v }
        else if let v = try? container.decode(Double.self) { value = v }
        else if let v = try? container.decode(String.self) { value = v }
        else if let v = try? container.decode([AnyCodable].self) { value = v }
        else if let v = try? container.decode([String: AnyCodable].self) { value = v }
        else {
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "unsupported JSON value"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case nil: try container.encodeNil()
        case let v as Bool: try container.encode(v)
        case let v as Int: try container.encode(v)
        case let v as Double: try container.encode(v)
        case let v as String: try container.encode(v)
        case let v as [AnyCodable]: try container.encode(v)
        case let v as [String: AnyCodable]: try container.encode(v)
        default:
            throw EncodingError.invalidValue(
                value as Any,
                EncodingError.Context(codingPath: container.codingPath, debugDescription: "unsupported")
            )
        }
    }
}
