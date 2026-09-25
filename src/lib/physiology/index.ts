// Physiology panel (coach initiative, lane A02): the athlete's last five
// weeks of measured data as a pre-computed prompt block. Pure; reachable
// from api/** (relative .js imports, no React, no supabase-js).
export type {
  ActivityInput,
  CardioLogInput,
  HrvSummary,
  LoadSummary,
  PhysiologyInputs,
  PhysiologySummary,
  SetLogInput,
  WeekTonnage,
  WeekZoneMinutes,
  ZoneMethod,
  ZoneMinutes,
} from './types.js';
export { computePhysiology, parseHrZones, physiologyWindowStart } from './compute.js';
export { describePhysiology } from './describe.js';
