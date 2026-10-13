/**
 * Node API client for the portal device page (plans/CONTRACT.md §5).
 *
 * Every call hits `/api/node/{deviceId}/<node path>` — the Next route
 * wraps it into Brain's `/v1/nodes/{id}/api` WS relay, so the paths here
 * are the *node's own* `/api/*` paths, identical to the local dashboard.
 *
 * `/api/brain/<v1 path>` reaches Brain v1 endpoints directly (events,
 * usage, cached room).
 */

export interface NodeStatus {
  device_id?: string;
  name?: string;
  state?: string;
  uptime_s?: number;
  sensors?: number;
  actuators?: number;
  models_active?: number;
  brain?: { paired?: boolean; url?: string; online?: boolean };
  capture?: { active?: boolean; capture_id?: string | null };
  [key: string]: unknown;
}

export interface NodeSensor {
  id: string;
  type?: string;
  driver?: string;
  online?: boolean;
  sample_rate?: number | null;
  units?: Record<string, string>;
  metadata?: { name?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Human label: product name from the descriptor, falling back to id. */
export function sensorLabel(s: NodeSensor): string {
  return s.metadata?.name || s.id;
}

export interface SensorTail {
  cursor?: number;
  samples?: Array<Record<string, unknown>>;
  state?: string;
  [key: string]: unknown;
}

export interface CaptureRecord {
  id?: string;
  capture_id?: string;
  state?: string;
  started_at?: number | null;
  stopped_at?: number | null;
  sensors?: string[];
  labels?: Array<{ label?: string; source?: string } | string>;
  manifest?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface NodeModel {
  runtime_model_id?: string;
  id?: string;
  name?: string;
  processor?: string;
  active?: boolean;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface Automation {
  id: string;
  name?: string;
  enabled?: boolean;
  trigger?: Record<string, unknown>;
  action?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MetadataDoc {
  inferred?: {
    location?: { lat?: number; lon?: number; postal_code?: string; city?: string; updated_at?: number };
    activity?: { kind?: string; confidence?: number; updated_at?: number };
    battery?: { percent?: number | null; charging?: boolean | null; updated_at?: number };
    application?: { foreground?: string; platform?: string; updated_at?: number };
    [key: string]: unknown;
  };
  manual?: { room_name?: string; friendly_name?: string; room_id?: string };
  [key: string]: unknown;
}

export type V3 = [number, number, number];

/** Room-to-world anchor: origin = room floor centre in ENU metres
 * from the building origin; heading is clockwise from north toward the
 * room's -Z direction. `surveyed` flags user-confirmed dimensions. */
export interface RoomSpatial {
  surveyed?: boolean;
  origin_enu_m?: [number, number, number] | null;
  heading_deg?: number | null;
  floor?: number | null;
}

/** Building anchor: shared house identity + geographic origin every
 * node in the same house must agree on for a combined map. */
export interface BuildingAnchor {
  id?: string;
  name?: string;
  anchor?: {
    latitude: number | null;
    longitude: number | null;
    altitude_m: number | null;
  };
}

/** room/v1 document — the synced node↔Brain room layout (CONTRACT §1.2).
 * Multi-room: `devices[].room_id` assigns a device to a named room;
 * `rooms[]` holds extra rooms (primary room uses the top-level fields). */
export interface RoomDoc {
  format?: string;
  room_id?: string;
  name?: string;
  dims?: { w: number; d: number; h: number };
  walls?: Array<{ p: V3; s: V3 }>;
  spatial?: RoomSpatial;
  building?: BuildingAnchor;
  furniture?: Array<{
    type: string;
    pos: V3;
    rot_y?: number;
    dims: V3;
  }>;
  devices?: Array<{
    device_id: string;
    device_name?: string;
    pos: V3;
    rot_y?: number;
    mount?: 'wall' | 'table' | 'floor' | 'ceiling' | string;
    room_id?: string;
    position_uncertainty_m?: number | null;
    sensors?: Array<{
      type: 'radar' | 'camera' | 'csi_rx' | 'csi_tx' | 'mic' | string;
      pos: V3;
      rot_y?: number;
      tilt?: number;
      fov_deg?: number;
      range_m?: number;
    }>;
  }>;
  persons?: Array<{
    person_id: string;
    name?: string;
    pos: V3;
    room_id?: string;
  }>;
  rooms?: Array<{
    room_id: string;
    name?: string;
    dims?: { w: number; d: number; h: number };
    walls?: Array<{ p: V3; s: V3 }>;
    spatial?: RoomSpatial;
    furniture?: RoomDoc['furniture'];
  }>;
  updated_at?: number;
  [key: string]: unknown;
}

/** All selectable rooms in a doc: primary first, then `rooms[]`. */
export function roomOptions(doc: RoomDoc):
    Array<{ room_id: string; name: string }> {
  const out = [{ room_id: doc.room_id || '',
                 name: doc.name || 'main room' }];
  for (const r of doc.rooms ?? [])
    out.push({ room_id: r.room_id,
               name: r.name || r.room_id });
  return out;
}

/** Renderable RoomDoc for one room — its geometry/furniture plus only the
 * devices assigned to it (unassigned devices land in the primary room). */
export function roomView(doc: RoomDoc, roomId: string): RoomDoc {
  const primary = doc.room_id || '';
  if (roomId === primary) {
    return { ...doc,
      devices: (doc.devices ?? []).filter(
        (d) => !d.room_id || d.room_id === primary),
      persons: (doc.persons ?? []).filter(
        (person) => !person.room_id || person.room_id === primary) };
  }
  const r = (doc.rooms ?? []).find((x) => x.room_id === roomId);
  if (!r) return { ...doc, devices: [], persons: [] };
  return {
    ...doc,
    room_id: r.room_id,
    name: r.name || r.room_id,
    dims: r.dims ?? doc.dims,
    walls: r.walls ?? [],
    spatial: r.spatial ?? doc.spatial,
    furniture: r.furniture ?? [],
    devices: (doc.devices ?? []).filter((d) => d.room_id === roomId),
    persons: (doc.persons ?? []).filter((person) => person.room_id === roomId),
  };
}

export interface NodeEventRow {
  id: string;
  device_id: string;
  kind: string;
  data: Record<string, unknown>;
  ts: number;
  created_at?: string;
}

export interface UsageRow {
  id: string;
  device_id: string;
  ts: number;
  source: string;
  kind: string;
  model_id?: string | null;
  latency_ms?: number | null;
  tokens?: number | null;
  meta?: Record<string, unknown>;
  created_at?: string;
}

export class NodeApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'NodeApiError';
  }
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  try {
    const token =
      localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    /* storage unavailable — cookie session still applies */
  }
  return headers;
}

/** Raw fetch to a node path through the relay — needed for binary bodies
 * (capture zip downloads) where a JSON envelope would corrupt the bytes. */
export function nodeFetch(
  deviceId: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return fetch(`/api/node/${encodeURIComponent(deviceId)}${clean}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers || {}) },
    cache: 'no-store',
  });
}

async function parseBody(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** JSON call to a node path; throws NodeApiError on non-2xx. */
export async function nodeJson<T = any>(
  deviceId: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await nodeFetch(deviceId, path, init);
  const data = await parseBody(res);
  if (!res.ok) {
    const detail =
      (data && typeof data === 'object' && (data.detail || data.error)) ||
      (typeof data === 'string' && data) ||
      `node request failed (${res.status})`;
    throw new NodeApiError(res.status, String(detail));
  }
  return data as T;
}

export async function nodeGet<T = any>(deviceId: string, path: string): Promise<T> {
  return nodeJson<T>(deviceId, path);
}

export async function nodePost<T = any>(
  deviceId: string,
  path: string,
  body?: unknown,
): Promise<T> {
  return nodeJson<T>(deviceId, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? '{}' : JSON.stringify(body),
  });
}

export async function nodePut<T = any>(
  deviceId: string,
  path: string,
  body?: unknown,
): Promise<T> {
  return nodeJson<T>(deviceId, path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? '{}' : JSON.stringify(body),
  });
}

export async function nodeDelete<T = any>(
  deviceId: string,
  path: string,
): Promise<T> {
  return nodeJson<T>(deviceId, path, { method: 'DELETE' });
}

/** Brain v1 call through `/api/brain/*` (events, usage, cached room). */
export async function brainJson<T = any>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const clean = path.startsWith('/') ? path : `/${path}`;
  const res = await fetch(`/api/brain${clean}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers || {}) },
    cache: 'no-store',
  });
  const data = await parseBody(res);
  if (!res.ok) {
    const detail =
      (data && typeof data === 'object' && (data.detail || data.error)) ||
      `brain request failed (${res.status})`;
    throw new NodeApiError(res.status, String(detail));
  }
  return data as T;
}
