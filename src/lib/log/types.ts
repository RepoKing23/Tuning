/** Group used to organise the channel checkbox list in the viewer. */
export type ChannelGroup =
  | 'Engine'
  | 'Fuel'
  | 'Spark'
  | 'Airflow'
  | 'Temps'
  | 'Trans'
  | 'Other';

export interface LogChannel {
  name: string;
  unit: string;
  group: ChannelGroup;
  /** NaN marks "not logged" — never conflated with a real 0. */
  values: Float64Array;
  min: number;
  max: number;
  mean: number;
  /** Count of finite samples. */
  n: number;
}

export interface LogFile {
  id: string;
  name: string;
  /** Seconds from log start, monotonic. */
  time: Float64Array;
  channels: LogChannel[];
  byName: Map<string, LogChannel>;
  rowCount: number;
  duration: number;
  /** Median sample interval, seconds. */
  sampleInterval: number;
  startedAt: string | null;
  /** Columns that were text rather than numeric (LogNotes, dates, ...). */
  textColumns: string[];
}
