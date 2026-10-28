/** Models matching docs/contract.md (HTTP API, v1). */

export interface Health {
  ok: boolean;
  version: string;
}

export interface Home {
  homeId: string;
  online: boolean;
  /** Unix epoch milliseconds; may be absent/null if the home never reported. */
  lastSeenTs?: number | null;
}

export interface Entity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  updated_ts?: number;
}

export interface EntityList {
  entities: Entity[];
  updatedTs?: number;
  /** history_entities globs (`*` wildcards): entities that can have history. */
  historyEntities?: string[];
}

export type HistoryRes = 'raw' | 'day';

export interface RawPoint {
  /** ISO time of the state change. */
  t: string;
  state: string | null;
}

export interface DayPoint {
  /** YYYY-MM-DD (the home's history day, see contract.md). Numeric entities carry min/max/avg; others carry dur (state -> seconds). */
  date: string;
  min?: number;
  max?: number;
  avg?: number;
  dur?: Record<string, number>;
  n: number;
}

export interface History<R extends HistoryRes = HistoryRes> {
  entityId: string;
  res: R;
  from: number;
  to: number;
  /** Last change before `from` (raw only), or null. */
  prev: RawPoint | null;
  /** Empty when there is no history yet: that is not an error. */
  points: R extends 'raw' ? RawPoint[] : DayPoint[];
}

export interface HistoryOptions {
  res?: HistoryRes;
  /** Epoch ms. */
  from?: number;
  to?: number;
}

export interface CommandRequest {
  domain: string;
  service: string;
  target: { entity_id: string | string[] };
  data?: Record<string, unknown>;
}

export interface CommandAccepted {
  id: string;
  status: 'pending';
}

export type CommandState = 'pending' | 'ok' | 'error';

export interface CommandStatus {
  id: string;
  status: CommandState;
  error?: string | null;
}

export interface ListEntitiesOptions {
  domain?: string;
}

export interface WaitForCommandOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

export interface HomeCloudClientOptions {
  /** API base URL without the `/v1` suffix, e.g. https://xyz.execute-api.us-east-1.amazonaws.com */
  apiUrl: string;
  /** Returns a Cognito JWT. Called before every authenticated request. */
  getToken: () => Promise<string>;
  /** Override fetch (tests, node, custom transports). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

/** The caller's own view prefs for one home. `prefs` is opaque to the server. */
export interface PrefsResponse<P = Record<string, unknown>> {
  prefs: P | null;
  updatedTs: number | null;
}
