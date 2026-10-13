'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/contexts/AuthContext';
import { roomOptions, roomView } from '@/lib/node-api';
import type { RoomDoc } from '@/lib/node-api';
import { contextApi } from '@/lib/context-api';
import type { CtxSnapshot } from '@/lib/context-api';
import type { RoomPerson } from '@/components/device/RoomScene';

const RoomScene = dynamic(() => import('@/components/device/RoomScene'), { ssr: false });

interface Zone { id: number; name: string; polygon: [number, number][] }
interface Placement {
  device_id: string; device_name: string; space_id: number;
  x: number; y: number; rotation_deg: number; fov_deg: number; range_m: number;
}
interface Space {
  id: number; name: string; parent_id: number | null;
  width_m: number | null; height_m: number | null;
  zones: Zone[]; devices: Placement[];
}
interface ZoneState { occupied: boolean; people_count: number; confidence: number }
interface SpaceState {
  space_id: number; name: string; occupied: boolean;
  people_count: number; confidence: number;
  zones: Record<string, ZoneState>; last_activity: string | null;
}
interface DeviceInfo { device_id: string; device_name: string; online: boolean }
interface SyncedRoom {
  device_id: string;
  device_name: string;
  updated_at?: string | null;
  room: RoomDoc;
}

function freshRoomPeople(snapshot: CtxSnapshot | null, room: RoomDoc): RoomPerson[] {
  if (!snapshot) return [];
  const roomId = room.room_id || '';
  const placeIds = new Set(snapshot.entities.filter((entity) =>
    ['place', 'space', 'building'].includes(entity.kind)
    && (entity.id === roomId || entity.id === `place:${roomId}`
      || entity.attributes?.room_id === roomId)).map((entity) => entity.id));
  if (!placeIds.size) return [];
  const now = Date.now() / 1000;
  const currentEdges = snapshot.relationships.filter((relation) =>
    relation.predicate === 'located_in' && placeIds.has(relation.object)
    && relation.valid_from != null && now - relation.valid_from <= 120
    && relation.valid_from <= now + 5
    && (relation.valid_until == null || relation.valid_until > now)
    && relation.confidence >= 0.8);
  const configured = new Map((room.persons ?? []).map((person) => [
    person.person_id, person,
  ]));
  return snapshot.entities.filter((entity) => entity.kind === 'person'
    && currentEdges.some((relation) => relation.subject === entity.id))
    .map((person) => {
      const associations = snapshot.relationships.filter((relation) =>
        relation.subject === person.id
        && ['associated_devices', 'carries'].includes(relation.predicate)
        && relation.valid_from != null && now - relation.valid_from <= 120
        && relation.valid_from <= now + 5
        && (relation.valid_until == null || relation.valid_until > now)
        && relation.confidence >= 0.8).map((relation) => relation.object);
      const configuredDevices = person.attributes?.associated_devices;
      if (Array.isArray(configuredDevices))
        associations.push(...configuredDevices.map(String));
      const watch = snapshot.states.filter((state) =>
        state.key === 'watch.worn.v1' && associations.includes(state.entity_id)
        && state.since != null && now - state.since <= 120
        && state.since <= now + 5
        && (state.valid_until == null || state.valid_until > now)
        && state.confidence >= 0.8)
        .sort((a, b) => (b.since ?? 0) - (a.since ?? 0))[0];
      const watchValue = typeof watch?.value === 'object' && watch.value !== null
        ? (watch.value as Record<string, unknown>).worn : watch?.value;
      return {
        id: person.id,
        name: person.name || person.id,
        pos: configured.get(person.id)?.pos,
        wearingWatch: typeof watchValue === 'boolean' ? watchValue : null,
        live: true,
      };
    });
}

function freshRoomOccupancy(snapshot: CtxSnapshot | null, room: RoomDoc) {
  if (!snapshot) return null;
  const deviceIds = new Set((room.devices ?? []).map((device) => device.device_id));
  const now = Date.now() / 1000;
  const state = snapshot.states.filter((candidate) =>
    candidate.key === 'occupancy.v1' && deviceIds.has(candidate.entity_id)
    && candidate.since != null && now - candidate.since <= 60
    && candidate.since <= now + 5
    && (candidate.valid_until == null || candidate.valid_until > now)
    && candidate.confidence >= 0.8 && candidate.evidence_ids?.length > 0)
    .sort((a, b) => (b.since ?? 0) - (a.since ?? 0))[0];
  const value = typeof state?.value === 'object' && state.value !== null
    ? state.value as Record<string, unknown> : null;
  return typeof value?.occupied === 'boolean' && state
    ? { occupied: value.occupied, confidence: state.confidence, since: state.since,
        stateId: state.id, evidenceCount: state.evidence_ids.length }
    : null;
}

const PLAN_W = 10; // meters, default plan extents
const PLAN_H = 8;
const SCALE = 60;  // px per meter

type Mode = 'view' | 'zone' | 'place' | 'device';

export default function SpacesPage() {
  const { get, post, put, delete: del } = useApi();
  const { user } = useAuth();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [states, setStates] = useState<Record<number, SpaceState>>({});
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [syncedRooms, setSyncedRooms] = useState<SyncedRoom[]>([]);
  const [selectedSyncedRoom, setSelectedSyncedRoom] = useState('');
  const [syncError, setSyncError] = useState<string | null>(null);
  const [contextSnapshot, setContextSnapshot] = useState<CtxSnapshot | null>(null);
  const [selected, setSelected] = useState<Space | null>(null);
  const [newName, setNewName] = useState('');
  const [mode, setMode] = useState<Mode>('view');
  const [drawing, setDrawing] = useState<[number, number][]>([]);
  const [zoneName, setZoneName] = useState('');
  const [pickDevice, setPickDevice] = useState<string | null>(null);
  const [selPlacement, setSelPlacement] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editW, setEditW] = useState('10');
  const [editH, setEditH] = useState('8');
  const [editParent, setEditParent] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const load = useCallback(async () => {
    try {
      const [sp, st, dev] = await Promise.all([
        get('/spaces'), get('/spaces/state'), get('/device/list?include_offline=true'),
      ]);
      setSpaces(sp.spaces || []);
      const map: Record<number, SpaceState> = {};
      for (const s of st.spaces || []) map[s.space_id] = s;
      setStates(map);
      setDevices(dev.devices || dev || []);
      try {
        const shared = await get('/v1/rooms');
        const rows: SyncedRoom[] = shared.rooms || [];
        setSyncedRooms(rows);
        setSelectedSyncedRoom((previous) => previous ||
          (rows[0] ? `${rows[0].device_id}:${rows[0].room?.room_id || ''}` : ''));
        setSyncError(null);
      } catch (syncFailure: any) {
        setSyncError(syncFailure?.message || 'Synchronized room layouts are unavailable');
      }
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Failed to load spaces');
    }
  }, [get]);

  const refreshSelected = useCallback(async (id: number) => {
    const fresh = await get(`/spaces/${id}`);
    setSelected(fresh.space);
  }, [get]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const refresh = async () => {
      try { setContextSnapshot(await contextApi.snapshot()); }
      catch { setContextSnapshot(null); }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 10000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const st = await get('/spaces/state');
        const map: Record<number, SpaceState> = {};
        for (const s of st.spaces || []) map[s.space_id] = s;
        setStates(map);
      } catch { /* keep last state */ }
    }, 5000);
    return () => clearInterval(t);
  }, [get]);

  const createSpace = async () => {
    if (!newName.trim()) return;
    try {
      const res = await post('/spaces', { name: newName.trim(), width_m: PLAN_W, height_m: PLAN_H });
      setNewName('');
      await load();
      if (res.space) setSelected(res.space);
    } catch (e: any) { setError(e?.message || 'Create failed'); }
  };

  const saveSpaceEdits = async () => {
    if (!selected) return;
    try {
      await put(`/spaces/${selected.id}`, {
        name: editName.trim() || selected.name,
        width_m: parseFloat(editW) || undefined,
        height_m: parseFloat(editH) || undefined,
        parent_id: editParent === '' ? undefined
          : (editParent === 'none' ? null : parseInt(editParent, 10)),
      });
      setEditing(false);
      await load();
      await refreshSelected(selected.id);
    } catch (e: any) { setError(e?.message || 'Save failed'); }
  };

  const toPlan = (e: React.MouseEvent): [number, number] => {
    const rect = svgRef.current!.getBoundingClientRect();
    return [
      Math.round(((e.clientX - rect.left) / SCALE) * 10) / 10,
      Math.round(((e.clientY - rect.top) / SCALE) * 10) / 10,
    ];
  };

  const onPlanClick = (e: React.MouseEvent) => {
    if (!selected) return;
    const [x, y] = toPlan(e);
    if (mode === 'zone') {
      setDrawing((pts) => [...pts, [x, y]]);
    } else if (mode === 'place' && pickDevice) {
      placeDevice(pickDevice, x, y);
    } else if (mode === 'device' && selPlacement) {
      movePlacement(selPlacement, x, y);
    }
  };

  const saveZone = async () => {
    if (!selected || !zoneName.trim() || drawing.length < 3) return;
    try {
      await post(`/spaces/${selected.id}/zones`, { name: zoneName.trim(), polygon: drawing });
      setDrawing([]); setZoneName(''); setMode('view');
      await load();
      await refreshSelected(selected.id);
    } catch (e: any) { setError(e?.message || 'Zone save failed'); }
  };

  const deleteZone = async (zoneId: number) => {
    if (!selected) return;
    await del(`/spaces/${selected.id}/zones/${zoneId}`);
    await load();
    await refreshSelected(selected.id);
  };

  const placeDevice = async (deviceId: string, x: number, y: number) => {
    try {
      await put(`/spaces/devices/${deviceId}/placement`, {
        space_id: selected!.id, x, y, rotation_deg: 0, fov_deg: 90, range_m: 8,
      });
      setMode('device'); setSelPlacement(deviceId);
      await load();
      await refreshSelected(selected!.id);
    } catch (e: any) { setError(e?.message || 'Placement failed'); }
  };

  const movePlacement = async (deviceId: string, x: number, y: number) => {
    const cur = selected?.devices.find((d) => d.device_id === deviceId);
    try {
      await put(`/spaces/devices/${deviceId}/placement`, {
        space_id: selected!.id, x, y,
        rotation_deg: cur?.rotation_deg ?? 0,
        fov_deg: cur?.fov_deg ?? 90,
        range_m: cur?.range_m ?? 8,
      });
      await load();
      await refreshSelected(selected!.id);
    } catch (e: any) { setError(e?.message || 'Move failed'); }
  };

  const updatePlacement = async (deviceId: string, patch: Partial<Placement>) => {
    const cur = selected?.devices.find((d) => d.device_id === deviceId);
    if (!cur) return;
    try {
      await put(`/spaces/devices/${deviceId}/placement`, {
        space_id: selected!.id,
        x: patch.x ?? cur.x, y: patch.y ?? cur.y,
        rotation_deg: patch.rotation_deg ?? cur.rotation_deg,
        fov_deg: patch.fov_deg ?? cur.fov_deg,
        range_m: patch.range_m ?? cur.range_m,
      });
      await load();
      await refreshSelected(selected!.id);
    } catch (e: any) { setError(e?.message || 'Update failed'); }
  };

  const removePlacement = async (deviceId: string) => {
    await del(`/spaces/devices/${deviceId}/placement`);
    setSelPlacement(null); setMode('view');
    await load();
    if (selected) await refreshSelected(selected.id);
  };

  const deleteSpace = async (id: number) => {
    await del(`/spaces/${id}`);
    if (selected?.id === id) setSelected(null);
    await load();
  };

  const state = selected ? states[selected.id] : null;
  const placedIds = new Set((selected?.devices || []).map((d) => d.device_id));
  const selPl = selected?.devices.find((d) => d.device_id === selPlacement);
  const syncedGroups = new Map<string, {
    key: string; deviceName: string; updatedAt?: string | null; room: RoomDoc;
  }>();
  for (const source of syncedRooms) {
    for (const option of roomOptions(source.room)) {
      const view = roomView(source.room, option.room_id);
      const buildingKey = source.room.building?.id || source.room.building?.name;
      const key = `${buildingKey || source.device_id}:${option.room_id}`;
      const existing = syncedGroups.get(key);
      if (!existing) {
        syncedGroups.set(key, { key, deviceName: source.device_name,
          updatedAt: source.updated_at, room: view });
        continue;
      }
      const latest = !existing.updatedAt || (source.updated_at &&
        source.updated_at > existing.updatedAt);
      const base = latest ? view : existing.room;
      const allDevices = new Map<string, NonNullable<RoomDoc['devices']>[number]>();
      for (const device of [...(existing.room.devices ?? []), ...(view.devices ?? [])])
        allDevices.set(device.device_id, device);
      const allPeople = new Map<string, NonNullable<RoomDoc['persons']>[number]>();
      for (const person of [...(existing.room.persons ?? []), ...(view.persons ?? [])])
        allPeople.set(person.person_id, person);
      const sourceNames = existing.deviceName.split(', ');
      if (!sourceNames.includes(source.device_name)) sourceNames.push(source.device_name);
      syncedGroups.set(key, {
        key,
        deviceName: sourceNames.join(', '),
        updatedAt: latest ? source.updated_at : existing.updatedAt,
        room: { ...base, devices: Array.from(allDevices.values()),
          persons: Array.from(allPeople.values()) },
      });
    }
  }
  const syncedRoomViews = Array.from(syncedGroups.values());
  const activeSyncedRoom = syncedRoomViews.find(
    (entry) => entry.key === selectedSyncedRoom) ?? syncedRoomViews[0];
  const liveRoomPeople = activeSyncedRoom
    ? freshRoomPeople(contextSnapshot, activeSyncedRoom.room) : [];
  const liveOccupancy = activeSyncedRoom
    ? freshRoomOccupancy(contextSnapshot, activeSyncedRoom.room) : null;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Spaces</h1>
          <p className="text-sm text-neutral-400">
            Named areas with zones and placed devices — live occupancy state.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            value={newName} onChange={(e) => setNewName(e.target.value)}
            placeholder="New space name"
            className="rounded bg-neutral-800 px-3 py-2 text-sm"
            onKeyDown={(e) => e.key === 'Enter' && createSpace()}
          />
          <button onClick={createSpace}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500">
            Create
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* space list */}
        <div className="space-y-2">
          {spaces.map((s) => {
            const st = states[s.id];
            return (
              <button key={s.id} onClick={() => { setSelected(s); setMode('view'); setSelPlacement(null); setEditing(false); }}
                className={`flex w-full items-center justify-between rounded border px-4 py-3 text-left ${
                  selected?.id === s.id ? 'border-blue-500 bg-neutral-800' : 'border-neutral-700 bg-neutral-900'
                }`}>
                <span>
                  <span className={st?.occupied ? 'text-green-400' : 'text-neutral-500'}>
                    {st?.occupied ? '●' : '○'}
                  </span>{' '}
                  {s.name}
                  {s.parent_id && spaces.find((p) => p.id === s.parent_id) && (
                    <span className="ml-2 text-xs text-neutral-500">
                      in {spaces.find((p) => p.id === s.parent_id)?.name}
                    </span>
                  )}
                </span>
                <span className="text-xs text-neutral-400">
                  {st ? `${st.people_count} people` : ''} · {s.zones.length} zones · {s.devices.length} devices
                </span>
              </button>
            );
          })}
          {spaces.length === 0 && (
            <p className="text-sm text-neutral-500">No spaces yet — create one above.</p>
          )}
        </div>

        {/* floor plan */}
        <div className="lg:col-span-2">
          {selected ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-medium">{selected.name}</h2>
                <div className="flex gap-3 text-xs">
                  <button onClick={() => { setEditing(!editing); setEditName(selected.name);
                      setEditW(String(selected.width_m ?? PLAN_W)); setEditH(String(selected.height_m ?? PLAN_H));
                      setEditParent(selected.parent_id ? String(selected.parent_id) : 'none'); }}
                    className="text-blue-400 hover:underline">
                    {editing ? 'Cancel edit' : 'Edit space'}
                  </button>
                  <button onClick={() => deleteSpace(selected.id)}
                    className="text-red-400 hover:underline">Delete space</button>
                </div>
              </div>

              {editing && (
                <div className="flex flex-wrap items-center gap-2 rounded border border-neutral-700 bg-neutral-900 p-3 text-sm">
                  <input value={editName} onChange={(e) => setEditName(e.target.value)}
                    placeholder="Name" className="rounded bg-neutral-800 px-2 py-1" />
                  <label className="flex items-center gap-1 text-neutral-400">
                    w <input value={editW} onChange={(e) => setEditW(e.target.value)}
                      className="w-16 rounded bg-neutral-800 px-2 py-1" /> m
                  </label>
                  <label className="flex items-center gap-1 text-neutral-400">
                    h <input value={editH} onChange={(e) => setEditH(e.target.value)}
                      className="w-16 rounded bg-neutral-800 px-2 py-1" /> m
                  </label>
                  <select value={editParent} onChange={(e) => setEditParent(e.target.value)}
                    className="rounded bg-neutral-800 px-2 py-1">
                    <option value="">— no parent —</option>
                    <option value="none">none (top-level / building)</option>
                    {spaces.filter((s) => s.id !== selected.id).map((s) => (
                      <option key={s.id} value={s.id}>inside: {s.name}</option>
                    ))}
                  </select>
                  <button onClick={saveSpaceEdits}
                    className="rounded bg-blue-600 px-3 py-1">Save</button>
                </div>
              )}

              {/* mode toolbar */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {(['view', 'zone', 'place', 'device'] as const).map((m) => (
                  <button key={m}
                    onClick={() => { setMode(m); setDrawing([]); }}
                    className={`rounded px-3 py-1.5 ${mode === m ? 'bg-blue-600' : 'bg-neutral-800 hover:bg-neutral-700'}`}>
                    {{view: 'View', zone: 'Draw zone', place: 'Place device', device: 'Edit device'}[m]}
                  </button>
                ))}
                <span className="text-neutral-500">
                  {mode === 'zone' && 'Click the plan to add zone points'}
                  {mode === 'place' && (pickDevice
                    ? `Click the plan to place ${devices.find((d) => d.device_id === pickDevice)?.device_name ?? pickDevice}`
                    : 'Pick a device below, then click the plan')}
                  {mode === 'device' && (selPl
                    ? `${selPl.device_name}: click plan to move, or edit below`
                    : 'Click a placed device to edit it')}
                </span>
              </div>

              <svg ref={svgRef} onClick={onPlanClick}
                width={(selected.width_m || PLAN_W) * SCALE}
                height={(selected.height_m || PLAN_H) * SCALE}
                className={`rounded border border-neutral-700 bg-neutral-950 ${mode === 'view' ? 'cursor-default' : 'cursor-crosshair'}`}>
                {/* grid */}
                {Array.from({ length: Math.floor(selected.width_m || PLAN_W) + 1 }, (_, i) => (
                  <line key={`v${i}`} x1={i * SCALE} y1={0} x2={i * SCALE}
                    y2={(selected.height_m || PLAN_H) * SCALE} stroke="#262626" />
                ))}
                {Array.from({ length: Math.floor(selected.height_m || PLAN_H) + 1 }, (_, i) => (
                  <line key={`h${i}`} x1={0} y1={i * SCALE}
                    x2={(selected.width_m || PLAN_W) * SCALE} y2={i * SCALE} stroke="#262626" />
                ))}
                {/* zones */}
                {selected.zones.map((z) => {
                  const zs = state?.zones?.[z.name];
                  return (
                    <g key={z.id}>
                      <polygon
                        points={z.polygon.map(([x, y]) => `${x * SCALE},${y * SCALE}`).join(' ')}
                        fill={zs?.occupied ? 'rgba(34,197,94,0.25)' : 'rgba(59,130,246,0.15)'}
                        stroke={zs?.occupied ? '#22c55e' : '#3b82f6'} strokeWidth={1.5} />
                      <text x={z.polygon[0][0] * SCALE + 4} y={z.polygon[0][1] * SCALE + 14}
                        className="fill-neutral-300" fontSize={11}>
                        {z.name}{zs?.occupied ? ` (${zs.people_count})` : ''}
                      </text>
                    </g>
                  );
                })}
                {/* in-progress polygon */}
                {drawing.length > 0 && (
                  <polyline
                    points={drawing.map(([x, y]) => `${x * SCALE},${y * SCALE}`).join(' ')}
                    fill="none" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="4" />
                )}
                {/* device markers + FOV cones */}
                {selected.devices.map((d) => {
                  const cx = d.x * SCALE, cy = d.y * SCALE;
                  const half = (d.fov_deg / 2) * (Math.PI / 180);
                  const rot = d.rotation_deg * (Math.PI / 180);
                  const r = d.range_m * SCALE;
                  const a1 = rot - half - Math.PI / 2, a2 = rot + half - Math.PI / 2;
                  const sel = selPlacement === d.device_id;
                  return (
                    <g key={d.device_id} className={mode === 'device' ? 'cursor-pointer' : undefined}
                      onClick={(e) => {
                        if (mode !== 'device') return;
                        e.stopPropagation();
                        setSelPlacement(d.device_id);
                      }}>
                      <path
                        d={`M ${cx} ${cy} L ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)} A ${r} ${r} 0 0 1 ${cx + r * Math.cos(a2)} ${cy + r * Math.sin(a2)} Z`}
                        fill={sel ? 'rgba(168,85,247,0.22)' : 'rgba(168,85,247,0.12)'}
                        stroke={sel ? '#d8b4fe' : '#a855f7'} strokeWidth={sel ? 1.5 : 1} />
                      <circle cx={cx} cy={cy} r={7} fill={sel ? '#d8b4fe' : '#a855f7'} />
                      <text x={cx + 9} y={cy + 4} fontSize={11} className="fill-neutral-300">
                        {d.device_name}
                      </text>
                    </g>
                  );
                })}
              </svg>

              {mode === 'zone' && (
                <div className="flex items-center gap-2 text-sm">
                  <input value={zoneName} onChange={(e) => setZoneName(e.target.value)}
                    placeholder="Zone name" className="rounded bg-neutral-800 px-3 py-1.5" />
                  <span className="text-neutral-400">
                    {drawing.length ? `${drawing.length} points` : 'Click the plan to draw a zone'}
                  </span>
                  <button onClick={saveZone} disabled={drawing.length < 3 || !zoneName.trim()}
                    className="rounded bg-blue-600 px-3 py-1.5 disabled:opacity-40">Save zone</button>
                  <button onClick={() => setDrawing([])}
                    className="rounded bg-neutral-700 px-3 py-1.5">Clear</button>
                </div>
              )}
              {mode === 'view' && selected.zones.length > 0 && (
                <div className="flex flex-wrap gap-2 text-xs">
                  {selected.zones.map((z) => (
                    <span key={z.id} className="flex items-center gap-1 rounded bg-neutral-800 px-2 py-1">
                      {z.name}
                      <button onClick={() => deleteZone(z.id)}
                        className="text-red-400 hover:text-red-300">×</button>
                    </span>
                  ))}
                </div>
              )}

              {mode === 'place' && (
                <div className="text-sm">
                  <p className="mb-1 text-neutral-400">Pick a device, then click the plan to drop it:</p>
                  <div className="flex flex-wrap gap-2">
                    {devices.map((d) => (
                      <button key={d.device_id}
                        onClick={() => setPickDevice(d.device_id)}
                        className={`rounded border px-3 py-1 ${
                          pickDevice === d.device_id ? 'border-purple-500 bg-purple-950' : 'border-neutral-700 hover:border-purple-500'
                        }`}>
                        {d.device_name} {d.online ? '🟢' : '⚫'}
                        {placedIds.has(d.device_id) && <span className="ml-1 text-neutral-500">(placed)</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {mode === 'device' && selPl && (
                <div className="flex flex-wrap items-center gap-4 rounded border border-neutral-700 bg-neutral-900 p-3 text-sm">
                  <span className="font-medium">{selPl.device_name}</span>
                  <label className="flex items-center gap-2 text-neutral-400">
                    rot <input type="range" min={0} max={359} value={selPl.rotation_deg}
                      onChange={(e) => updatePlacement(selPl.device_id, { rotation_deg: +e.target.value })}
                      className="w-28" /> {Math.round(selPl.rotation_deg)}°
                  </label>
                  <label className="flex items-center gap-2 text-neutral-400">
                    fov <input type="range" min={15} max={360} value={selPl.fov_deg}
                      onChange={(e) => updatePlacement(selPl.device_id, { fov_deg: +e.target.value })}
                      className="w-24" /> {Math.round(selPl.fov_deg)}°
                  </label>
                  <label className="flex items-center gap-2 text-neutral-400">
                    range <input type="range" min={0.5} max={30} step={0.5} value={selPl.range_m}
                      onChange={(e) => updatePlacement(selPl.device_id, { range_m: +e.target.value })}
                      className="w-24" /> {selPl.range_m}m
                  </label>
                  <span className="text-neutral-500">x {selPl.x} · y {selPl.y}</span>
                  <button onClick={() => removePlacement(selPl.device_id)}
                    className="rounded bg-red-900/60 px-3 py-1 text-red-300">Remove</button>
                </div>
              )}

              {/* live state */}
              {state && (
                <pre className="overflow-auto rounded bg-neutral-900 p-3 text-xs text-neutral-300">
                  {JSON.stringify(state, null, 2)}
                </pre>
              )}
            </div>
          ) : (
            <p className="text-sm text-neutral-500">Select a space to view its floor plan.</p>
          )}
        </div>
      </div>

      <section className="space-y-3 rounded-xl border border-neutral-700 bg-neutral-900/70 p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium">Synchronized device room layouts</h2>
            <p className="text-sm text-neutral-400">
              Read-only views of layouts saved from your node dashboards, including placed devices and people.
            </p>
          </div>
          {syncedRoomViews.length > 0 && (
            <select aria-label="Synchronized room layout" value={activeSyncedRoom?.key || ''}
              onChange={(e) => setSelectedSyncedRoom(e.target.value)}
              className="max-w-full rounded bg-neutral-800 px-3 py-2 text-sm">
              {syncedRoomViews.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.room.name || 'Room'} · {entry.deviceName}
                </option>
              ))}
            </select>
          )}
        </div>
        {syncError ? (
          <p className="text-sm text-amber-300">{syncError}</p>
        ) : activeSyncedRoom ? (
          <>
            <p className="text-xs text-neutral-500">
              Source: {activeSyncedRoom.deviceName}
              {activeSyncedRoom.updatedAt
                ? ` · layout synced ${new Date(activeSyncedRoom.updatedAt).toLocaleString()}`
                : ''}
              {' · '}{liveOccupancy
                ? `${liveOccupancy.occupied ? 'Occupied' : 'Unoccupied'} · ${Math.round(liveOccupancy.confidence * 100)}% · state #${liveOccupancy.stateId} · ${liveOccupancy.evidenceCount} evidence · ${new Date((liveOccupancy.since ?? 0) * 1000).toLocaleTimeString()}`
                : 'occupancy unknown · no fresh high-confidence evidence'}
            </p>
            <RoomScene room={activeSyncedRoom.room} people={liveRoomPeople}
              className="w-full overflow-hidden rounded-xl" />
          </>
        ) : (
          <p className="text-sm text-neutral-500">
            No node room layouts have synced to this account yet.
          </p>
        )}
      </section>
    </div>
  );
}
