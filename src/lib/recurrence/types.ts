export type Weekday = 'SU' | 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA';

export const WEEKDAYS: readonly Weekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export interface RecurrenceRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;          // default 1
  byDay?: Weekday[];         // WEEKLY only
  byMonthDay?: number[];     // MONTHLY only, 1-31
  count?: number;            // mutually exclusive with `until`
  until?: string;            // 'YYYY-MM-DD', inclusive, floating
}
