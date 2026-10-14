import { describe, it, expect } from 'vitest';
import { updateChartDraftSchema } from '../schemas';
import { MEASURE_IDS, SPORTS, WEIGHT_DISPLAY_UNITS } from '../../analytics/spec';

// schemas.ts must stay dependency-free (api/chat.ts imports it), so its
// enum lists are hand-mirrored from the analytics catalog. This test is the
// drift lock: a measure added to the catalog without updating the tool
// schema (or vice versa) fails here, not in production tool calls.

type SchemaObject = { properties?: Record<string, SchemaObject>; items?: SchemaObject; enum?: string[] };

const input = updateChartDraftSchema.input_schema as SchemaObject;
const seriesItem = input.properties!.series.items!;

describe('update_chart_draft schema mirrors the analytics catalog', () => {
  it('measure enum equals MEASURE_IDS', () => {
    expect(seriesItem.properties!.measure.enum).toEqual(MEASURE_IDS);
  });

  it('sports enum equals SPORTS', () => {
    expect(seriesItem.properties!.sports.items!.enum).toEqual(SPORTS);
  });

  it('group_by enum covers exactly the GroupBy union', () => {
    expect(seriesItem.properties!.group_by.enum!.sort()).toEqual(
      ['event-type', 'sport', 'exercise', 'category', 'meal-type', 'hr-zone', 'unit'].sort(),
    );
  });

  it('chart-level enums match the spec', () => {
    expect(input.properties!.chart_type.enum).toEqual(['line', 'bar', 'stacked-bar', 'area', 'kpi', 'table']);
    expect(input.properties!.bucket.enum).toEqual(['day', 'week', 'iso-month', 'total']);
    expect(input.properties!.display_unit.enum).toEqual(['mi', 'km', 'm', 'ft']);
  });

  it('weight_unit enum equals WEIGHT_DISPLAY_UNITS', () => {
    expect(input.properties!.weight_unit.enum).toEqual(['lb', 'kg']);
    expect(input.properties!.weight_unit.enum).toEqual(WEIGHT_DISPLAY_UNITS);
  });
});
