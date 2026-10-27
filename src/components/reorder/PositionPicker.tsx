import '../../styles/exercise-reorder.css';

/**
 * A far move in one step: dragging the tenth exercise to the top of a long
 * list means a long scroll, which picking "1" here skips.
 */
export default function PositionPicker({ index, count, name, onMove }: {
  index: number;
  count: number;
  name: string;
  onMove: (to: number) => void;
}) {
  if (count < 2) return null;
  return (
    <select
      className="reorder-position"
      value={index}
      onChange={e => onMove(Number(e.target.value))}
      aria-label={`Position of ${name}`}
      title="Move to position"
    >
      {Array.from({ length: count }, (_, i) => (
        <option key={i} value={i}>{i + 1}</option>
      ))}
    </select>
  );
}
