"use client";

import { OrbitControls, RoundedBox } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { type OrthographicCamera, Vector3 } from "three";
import {
  type Campus,
  type CenterRoom,
  type CenterSession,
  MAIN_DEPTH,
  ROOM_DEPTH,
  ROOM_STATE_LABELS,
  type RoomState,
} from "@/domain/center-3d";
import { cn } from "@/lib/utils";
import logo from "../../../public/logo.png";
import { ClassroomBuilding, MainBuilding, PAVEMENT, ROOM_TOP } from "./buildings";
import { Arena, Crates, FigureMarker, type FigureSpot, Figures, RoadDashes, Robot, type Spot, Trees } from "./scene-props";
import { STATE_DOT, type SceneTheme, readSceneTheme } from "./theme";

export type SceneRoom = { room: CenterRoom; state: RoomState; session: CenterSession | null };
/** Phần khung cảnh bị các thẻ nổi che (px): cảnh được canh vào vùng còn trống. */
export type SceneInsets = { top: number; right: number; bottom: number; left: number };
/** Lệnh bay tới một phòng (null = tòa nhà chính); `nonce` tăng mỗi lần ra lệnh để chọn lại cùng một phòng vẫn bay. */
export type SceneFlight = { roomId: string | null; nonce: number };
/** Hình người đang chọn trước cửa một phòng: giáo viên, hoặc học viên thứ `index` (từ 0). */
export type SceneMarker = { roomId: string; kind: "teacher" | "student"; index: number; label: string };
/** Lệnh điều khiển máy quay cho cột nút bên cạnh cảnh. */
export type SceneApi = { zoomIn: () => void; zoomOut: () => void; rotate: () => void; reset: () => void; home: () => void };

// Góc nhìn isometric mặc định: từ hướng đông nam (chéo 45°), nghiêng khoảng 40° so với mặt đất.
const AZIMUTH = Math.PI / 4;
const ELEVATION = 0.7;
const CAMERA_DISTANCE = 120;
const MIN_ZOOM = 7;
const MAX_ZOOM = 90;
const UP = new Vector3(0, 1, 0);
/** Mã của nhãn nổi phía trên hình người đang chọn (không trùng mã phòng nào). */
const MARKER_ID = "figure-marker";
const defaultOffset = () =>
  new Vector3(Math.sin(AZIMUTH) * Math.cos(ELEVATION), Math.sin(ELEVATION), Math.cos(AZIMUTH) * Math.cos(ELEVATION)).multiplyScalar(CAMERA_DISTANCE);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
// Cấu hình máy quay ban đầu là hằng số: Canvas dựng lại (đồng hồ, chọn phòng) không đặt lại góc nhìn người dùng đang xem.
const CAMERA = { position: defaultOffset().toArray(), zoom: 14, near: 1, far: 400 };

type Controls = { target: Vector3; update: () => void; addEventListener: (type: string, listener: () => void) => void; removeEventListener: (type: string, listener: () => void) => void };
type Motion = { offset: Vector3 | null; zoom: number | null; target: Vector3 | null };
const STILL: Motion = { offset: null, zoom: null, target: null };
/** Một chuyến bay tới đối tượng được chọn: điểm nhìn và mức zoom đi từ `from` tới `to` trong FLIGHT_MS. */
type Tween = { from: Vector3; to: Vector3; fromZoom: number; toZoom: number; start: number };
const FLIGHT_MS = 1000;
const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);

/** Vị trí cây: dải đất phía tây và phía bắc sau các dãy nhà, lề ngoài hai con đường, và ba góc sân. */
function treeSpots(campus: Campus): Spot[] {
  const { bounds, plaza, main, roads } = campus;
  const [minX, maxX, minZ, maxZ] = [bounds.x - bounds.width / 2, bounds.x + bounds.width / 2, bounds.z - bounds.depth / 2, bounds.z + bounds.depth / 2];
  const roadTop = roads.south.z - roads.south.depth / 2;
  const roadLeft = roads.east.x - roads.east.width / 2;
  const spots: Spot[] = [];
  // Dải phía tây: hai hàng so le ở đoạn phía nam tòa nhà chính.
  const mainSouth = main.z + main.depth / 2;
  for (let z = mainSouth + 2.2; z < roadTop - 1.5; z += 4.4) {
    spots.push({ x: minX + 1.5, z }, { x: minX + 4.3, z: z + 2.2 });
  }
  // Dải phía bắc: sau dãy phòng phía bắc.
  const mainEast = main.x + main.width / 2;
  for (let x = mainEast + 2.4; x < roadLeft - 1.5; x += 4.6) spots.push({ x, z: minZ + 1.4 });
  // Lề ngoài đường nam và đường đông.
  for (let x = minX + 2.5; x < maxX - 1.5; x += 6.5) spots.push({ x, z: maxZ - 1.15 });
  for (let z = minZ + 3; z < roadTop - 2; z += 6.5) spots.push({ x: maxX - 1.15, z });
  // Góc sân.
  const [plazaMaxX, plazaMaxZ] = [plaza.x + plaza.width / 2, plaza.z + plaza.depth / 2];
  spots.push({ x: plazaMaxX - 1.4, z: plazaMaxZ - 1.4 }, { x: plazaMaxX - 1.4, z: plaza.z - plaza.depth / 2 + 1.4 }, { x: plaza.x - plaza.width / 2 + 1.4, z: plazaMaxZ - 1.4 });
  return spots.filter((spot) => spot.z < roadTop - 0.9 || spot.z > roads.south.z + roads.south.depth / 2);
}

/** Nền khuôn viên: đất, vỉa hè, thảm xanh sau các dãy nhà, sân có viền vàng đồng nhạt và hai con đường. */
function Ground({ campus, theme, shadows }: { campus: Campus; theme: SceneTheme; shadows: boolean }) {
  const { bounds, plaza, roads, main } = campus;
  const [minX, minZ] = [bounds.x - bounds.width / 2, bounds.z - bounds.depth / 2];
  const roadTop = roads.south.z - roads.south.depth / 2;
  const roadLeft = roads.east.x - roads.east.width / 2;
  // Vỉa hè phủ toàn bộ phần phía trong hai con đường.
  const paved = { x: (minX + roadLeft) / 2, z: (minZ + roadTop) / 2, width: roadLeft - minX - 0.8, depth: roadTop - minZ - 0.8 };
  const mainSouth = main.z + main.depth / 2;
  const mainEast = main.x + main.width / 2;
  const gardenWest = { fromX: minX + 0.6, toX: main.x - main.width / 2 + (main.width - ROOM_DEPTH) - 0.6, fromZ: mainSouth + 0.8, toZ: roadTop - 0.8 };
  const gardenNorth = { fromX: mainEast + 0.8, toX: roadLeft - 0.8, fromZ: minZ + 0.6, toZ: main.z - main.depth / 2 + (main.depth - ROOM_DEPTH) - 0.6 };
  const edge = 0.14;
  return (
    <group>
      <RoundedBox args={[bounds.width, 0.7, bounds.depth]} radius={0.3} position={[bounds.x, -0.35, bounds.z]} receiveShadow={shadows}>
        <meshStandardMaterial color={theme.ground} />
      </RoundedBox>
      <mesh position={[paved.x, PAVEMENT / 2, paved.z]} receiveShadow={shadows}>
        <boxGeometry args={[paved.width, PAVEMENT, paved.depth]} />
        <meshStandardMaterial color={theme.trim} />
      </mesh>
      {[gardenWest, gardenNorth].map(
        (garden, index) =>
          garden.toX - garden.fromX > 1 &&
          garden.toZ - garden.fromZ > 1 && (
            <mesh key={index} position={[(garden.fromX + garden.toX) / 2, PAVEMENT + 0.012, (garden.fromZ + garden.toZ) / 2]} receiveShadow={shadows}>
              <boxGeometry args={[garden.toX - garden.fromX, 0.024, garden.toZ - garden.fromZ]} />
              <meshStandardMaterial color={theme.primarySoft} />
            </mesh>
          ),
      )}
      {/* Sân trung tâm: nền sáng hơn, viền vàng đồng nhạt. */}
      <mesh position={[plaza.x, PAVEMENT + 0.012, plaza.z]} receiveShadow={shadows}>
        <boxGeometry args={[plaza.width, 0.024, plaza.depth]} />
        <meshStandardMaterial color={theme.plaza} />
      </mesh>
      {[
        { x: plaza.x, z: plaza.z - plaza.depth / 2, width: plaza.width, depth: edge },
        { x: plaza.x, z: plaza.z + plaza.depth / 2, width: plaza.width, depth: edge },
        { x: plaza.x - plaza.width / 2, z: plaza.z, width: edge, depth: plaza.depth },
        { x: plaza.x + plaza.width / 2, z: plaza.z, width: edge, depth: plaza.depth },
      ].map((line, index) => (
        <mesh key={index} position={[line.x, PAVEMENT + 0.03, line.z]}>
          <boxGeometry args={[line.width, 0.02, line.depth]} />
          <meshStandardMaterial color={theme.roadLine} />
        </mesh>
      ))}
      {[roads.south, roads.east].map((road, index) => (
        <mesh key={index} position={[road.x, 0.03, road.z]} receiveShadow={shadows}>
          <boxGeometry args={[road.width, 0.06, road.depth]} />
          <meshStandardMaterial color={theme.road} />
        </mesh>
      ))}
      <RoadDashes roads={[roads.south, roads.east]} theme={theme} />
    </group>
  );
}

/**
 * Điều khiển máy quay trực giao: canh cảnh vào vùng không bị thẻ nổi che, thực hiện các lệnh của cột nút (phóng to, thu nhỏ,
 * xoay, đặt lại, về tòa nhà chính), bay tới đối tượng vừa được chọn (khoảng 1 giây, vào chậm ra chậm), và giữ điểm nhìn
 * trong phạm vi khuôn viên.
 */
function CameraRig({
  campus,
  insets,
  apiRef,
  flight,
  animate,
}: {
  campus: Campus;
  insets: SceneInsets;
  apiRef: RefObject<SceneApi | null>;
  /** Điểm (x, z) cần bay tới; đối tượng mới mỗi lần ra lệnh. */
  flight: { x: number; z: number } | null;
  animate: boolean;
}) {
  const invalidate = useThree((state) => state.invalidate);
  const get = useThree((state) => state.get);
  const size = useThree((state) => state.size);
  const controls = useThree((state) => state.controls);
  const motion = useRef<Motion>(STILL);
  const fit = useRef({ key: "", zoom: 14, ready: false });
  const pendingFlight = useRef<Vector3 | null>(null);
  const tween = useRef<Tween | null>(null);
  const fitKey = `${size.width}x${size.height}|${insets.top},${insets.right},${insets.bottom},${insets.left}|${campus.bounds.width}x${campus.bounds.depth}`;

  useEffect(() => invalidate(), [fitKey, invalidate]);
  useEffect(() => {
    pendingFlight.current = flight ? new Vector3(flight.x, 0, flight.z) : null;
    invalidate();
  }, [flight, invalidate]);
  // Người dùng tự kéo hoặc lăn chuột thì dừng mọi chuyển động đang chạy.
  useEffect(() => {
    const orbit = controls as unknown as Controls | null;
    if (!orbit) return;
    const stop = () => {
      motion.current = STILL;
      tween.current = null;
    };
    orbit.addEventListener("start", stop);
    return () => orbit.removeEventListener("start", stop);
  }, [controls]);
  useEffect(() => {
    const go = (next: Partial<Motion>) => {
      tween.current = null;
      motion.current = { ...motion.current, ...next };
      invalidate();
    };
    const zoomTo = (factor: number) => go({ zoom: clamp((motion.current.zoom ?? get().camera.zoom) * factor, MIN_ZOOM, MAX_ZOOM) });
    const mainFront = new Vector3(campus.main.x, 0, campus.main.z + MAIN_DEPTH / 2 + 2);
    apiRef.current = {
      zoomIn: () => zoomTo(1.3),
      zoomOut: () => zoomTo(1 / 1.3),
      rotate: () => {
        const orbit = get().controls as unknown as Controls | null;
        const from = motion.current.offset ?? (orbit ? get().camera.position.clone().sub(orbit.target) : defaultOffset());
        go({ offset: from.clone().applyAxisAngle(UP, Math.PI / 4) });
      },
      reset: () => go({ offset: defaultOffset(), zoom: fit.current.zoom, target: new Vector3(0, 0, 0) }),
      home: () => go({ offset: defaultOffset(), zoom: clamp(fit.current.zoom * 1.9, MIN_ZOOM, MAX_ZOOM), target: mainFront }),
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, campus, get, invalidate]);

  useFrame((state) => {
    const camera = state.camera as OrthographicCamera;
    // Canh cảnh vào vùng trống của khung: tính mức zoom vừa khuôn viên và dời khung nhìn theo phần bị thẻ che.
    if (fit.current.key !== fitKey) {
      const clearWidth = Math.max(size.width - insets.left - insets.right, 160);
      const clearHeight = Math.max(size.height - insets.top - insets.bottom, 160);
      const span = campus.bounds.width + campus.bounds.depth;
      const across = span * Math.SQRT1_2;
      const upward = span * Math.SQRT1_2 * Math.sin(ELEVATION) + 9 * Math.cos(ELEVATION);
      const zoom = clamp(Math.min(clearWidth / across, clearHeight / upward) * 0.95, MIN_ZOOM, MAX_ZOOM);
      const shiftX = insets.left + clearWidth / 2 - size.width / 2;
      // Nhà cao lên phía trên mặt đất nên cả cảnh được hạ xuống một chút cho cân.
      const shiftY = insets.top + clearHeight / 2 - size.height / 2 + clearHeight * 0.03;
      camera.setViewOffset(size.width, size.height, -shiftX, -shiftY, size.width, size.height);
      if (!fit.current.ready) camera.zoom = zoom;
      camera.updateProjectionMatrix();
      fit.current = { key: fitKey, zoom, ready: true };
    }
    const orbit = state.controls as unknown as Controls | null;
    if (!orbit) return;

    // Đối tượng vừa được chọn: bay tới và phóng gần hơn mức vừa cả khuôn viên (không thu nhỏ nếu người dùng đang phóng to hơn).
    if (pendingFlight.current) {
      const toZoom = clamp(Math.max(camera.zoom, fit.current.zoom * 1.55), MIN_ZOOM, MAX_ZOOM);
      tween.current = { from: orbit.target.clone(), to: pendingFlight.current, fromZoom: camera.zoom, toZoom, start: performance.now() };
      motion.current = { ...motion.current, target: null, zoom: null };
      pendingFlight.current = null;
    }
    const flying = tween.current;
    if (flying) {
      const k = animate ? clamp((performance.now() - flying.start) / FLIGHT_MS, 0, 1) : 1;
      const eased = easeInOut(k);
      const step = flying.from.clone().lerp(flying.to, eased).sub(orbit.target);
      camera.position.add(step);
      orbit.target.add(step);
      camera.zoom = flying.fromZoom + (flying.toZoom - flying.fromZoom) * eased;
      camera.updateProjectionMatrix();
      if (k >= 1) tween.current = null;
    }

    const move = motion.current;
    const ease = animate ? 0.16 : 1;
    if (move.target) {
      const step = move.target.clone().sub(orbit.target);
      const arrived = step.length() < 0.03 || !animate;
      if (!arrived) step.multiplyScalar(ease);
      camera.position.add(step);
      orbit.target.add(step);
      if (arrived) motion.current = { ...motion.current, target: null };
    }
    if (move.offset) {
      const current = camera.position.clone().sub(orbit.target);
      const arrived = current.angleTo(move.offset) < 0.004 || !animate;
      if (arrived) current.copy(move.offset);
      else current.lerp(move.offset, ease).setLength(CAMERA_DISTANCE);
      camera.position.copy(orbit.target).add(current);
      if (arrived) motion.current = { ...motion.current, offset: null };
    }
    if (move.zoom !== null) {
      const arrived = Math.abs(move.zoom - camera.zoom) < 0.03 || !animate;
      camera.zoom = arrived ? move.zoom : camera.zoom + (move.zoom - camera.zoom) * ease;
      camera.updateProjectionMatrix();
      if (arrived) motion.current = { ...motion.current, zoom: null };
    }
    // Điểm nhìn không ra khỏi khuôn viên (kéo chuột phải quá tay).
    const limitX = campus.bounds.width / 2;
    const limitZ = campus.bounds.depth / 2;
    const back = new Vector3(clamp(orbit.target.x, -limitX, limitX) - orbit.target.x, -orbit.target.y, clamp(orbit.target.z, -limitZ, limitZ) - orbit.target.z);
    if (back.lengthSq() > 1e-6) {
      camera.position.add(back);
      orbit.target.add(back);
    }
    orbit.update();
    const { offset, zoom, target } = motion.current;
    if (offset || zoom !== null || target || tween.current) state.invalidate();
  });
  return null;
}

/**
 * Nhãn của một phòng: nút HTML thường nằm trong lớp phủ trên cảnh, do `LabelProjector` đặt vào đúng chỗ của phòng trên màn hình.
 * Ẩn cho tới khi được đặt vị trí lần đầu.
 */
function RoomLabel({
  item,
  selected,
  onSelect,
  register,
}: {
  item: SceneRoom;
  selected: boolean;
  onSelect: (id: string) => void;
  register: (id: string, element: HTMLButtonElement | null) => void;
}) {
  const { room, state, session } = item;
  const shown = session && state !== "done" ? session : null;
  // Đủ chi tiết (giờ, giáo viên, sĩ số) cho phòng đang học và phòng đang chọn; phòng sắp học chỉ ghi giờ bắt đầu và tên lớp.
  const detailed = state === "live" || selected;
  return (
    <button
      ref={(element) => register(room.id, element)}
      type="button"
      onClick={() => onSelect(room.id)}
      aria-pressed={selected}
      aria-label={`${room.name}: ${ROOM_STATE_LABELS[state]}${shown ? `, ${shown.className}` : ""}`}
      className={cn(
        "pointer-events-auto invisible absolute top-0 left-0 grid w-max max-w-52 origin-bottom gap-0.5 rounded-xl border bg-card px-2.5 py-1.5 text-left text-xs leading-tight text-foreground shadow-panel outline-none select-none",
        "focus-visible:ring-3 focus-visible:ring-ring/60",
        selected ? "border-primary ring-2 ring-primary/30" : "border-transparent",
      )}
    >
      <span className="flex items-center gap-1.5 font-semibold">
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATE_DOT[state])} />
        <span className="truncate">{room.name}</span>
      </span>
      {shown && detailed ? (
        <>
          <span className="truncate">{shown.className}</span>
          <span className="truncate text-ink-soft">
            {shown.startTime}–{shown.endTime}
            {shown.teacherName ? ` · ${shown.teacherName}` : ""}
          </span>
          {shown.studentCount !== null && (
            <span className="text-ink-soft">
              Sĩ số {shown.studentCount}/{room.capacity}
              {shown.attendanceCount > 0 && " · đã điểm danh"}
            </span>
          )}
        </>
      ) : shown ? (
        <span className="truncate text-ink-soft">
          {shown.startTime} · {shown.className}
        </span>
      ) : (
        <span className="text-ink-soft">{ROOM_STATE_LABELS[state]}</span>
      )}
    </button>
  );
}

/**
 * Mỗi khung hình: chiếu điểm phía trên mái từng phòng lên màn hình rồi dời nhãn HTML của phòng tới đó (đáy nhãn chạm điểm ấy),
 * co giãn theo mức zoom; phòng gần máy quay hơn nằm trên. Nhãn của phòng ra ngoài khung nhìn thì ẩn.
 */
function LabelProjector({ anchors, labels }: { anchors: { id: string; x: number; y: number; z: number }[]; labels: RefObject<Map<string, HTMLElement>> }) {
  const invalidate = useThree((state) => state.invalidate);
  // Danh sách điểm neo đổi (nhãn mới được gắn): vẽ lại một khung hình để đặt vị trí.
  const anchorKey = anchors.map((anchor) => `${anchor.id}:${anchor.x},${anchor.z}`).join("|");
  useEffect(() => invalidate(), [anchorKey, invalidate]);
  useFrame(({ camera, size }) => {
    const point = new Vector3();
    const scale = clamp(camera.zoom / 15, 0.82, 1.1);
    for (const anchor of anchors) {
      const element = labels.current.get(anchor.id);
      if (!element) continue;
      point.set(anchor.x, anchor.y, anchor.z).project(camera);
      const inView = Math.abs(point.z) < 1 && Math.abs(point.x) < 1.1 && Math.abs(point.y) < 1.1;
      element.style.visibility = inView ? "visible" : "hidden";
      if (!inView) continue;
      const x = (point.x * 0.5 + 0.5) * size.width;
      const y = (-point.y * 0.5 + 0.5) * size.height;
      element.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
      element.style.zIndex = String(Math.max(1, Math.round((1 - point.z) * 500)));
    }
  });
  return null;
}

/**
 * Cảnh 3D isometric của trung tâm: tòa nhà chính, các phòng học theo `layoutCampus`, sân, đường, cây, robot.
 * Bấm phòng (hoặc nhãn của phòng), hình giáo viên hay hình học viên trước cửa phòng đang học để chọn; mọi thao tác nằm ở các
 * thẻ bên cạnh. Robot là vật trang trí. Màu lấy từ CSS variable của ứng dụng. Chỉ vẽ lại khi có thay đổi (`frameloop="demand"`).
 */
export function CenterScene({
  campus,
  rooms,
  selectedId,
  onSelect,
  flight,
  marker,
  onPickFigure,
  insets,
  apiRef,
  onReady,
}: {
  campus: Campus;
  rooms: SceneRoom[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  flight: SceneFlight | null;
  marker: SceneMarker | null;
  onPickFigure: (roomId: string, kind: "teacher" | "student", index: number) => void;
  insets: SceneInsets;
  apiRef: RefObject<SceneApi | null>;
  /** Gọi khi khung hình đầu tiên đã sẵn sàng (để tắt màn hình chờ). */
  onReady: () => void;
}) {
  const [theme] = useState(readSceneTheme);
  const [reducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  // Máy yếu (ít nhân xử lý hoặc ít bộ nhớ theo trình duyệt báo): tắt bóng đổ và vẽ ở độ phân giải gốc.
  const [lowEnd] = useState(() => {
    const device = navigator as Navigator & { deviceMemory?: number };
    return (device.hardwareConcurrency ?? 8) <= 4 || (device.deviceMemory ?? 8) <= 4;
  });
  const shadows = !lowEnd;
  const placementOf = useMemo(() => new Map(campus.rooms.map((placement) => [placement.id, placement])), [campus]);
  const trees = useMemo(() => treeSpots(campus), [campus]);
  // Điểm bay tới: tâm phòng được chọn; không có phòng (buổi chưa xếp phòng) thì là sảnh tòa nhà chính.
  const flightTo = useMemo(() => {
    if (!flight) return null;
    const placement = flight.roomId ? placementOf.get(flight.roomId) : undefined;
    return placement ? { x: placement.x, z: placement.z } : { x: campus.main.x, z: campus.main.z + MAIN_DEPTH / 2 + 2 };
  }, [flight, placementOf, campus]);

  const arena = { x: campus.plaza.x + 0.5, z: campus.plaza.z + 0.8 };
  // Hình người: vài người đứng quanh sa bàn, và trước cửa mỗi phòng đang học là giáo viên cùng nhóm học viên theo sĩ số (tối đa 8).
  const shirts = [theme.gold, theme.goldSoft, theme.teal];
  const figures: FigureSpot[] = [
    { x: arena.x - 1.2, z: arena.z - 2.7, color: theme.gold, height: 1.6 },
    { x: arena.x + 1.4, z: arena.z - 2.8, color: theme.teal, height: 1.6 },
  ];
  let marked: FigureSpot | null = null;
  for (const item of rooms) {
    const placement = placementOf.get(item.room.id);
    if (!placement || item.state !== "live" || !item.session) continue;
    const roomId = item.room.id;
    const local: (FigureSpot & { kind: "teacher" | "student"; index: number })[] = [];
    if (item.session.teacherId && item.session.teacherName) {
      local.push({ x: -1.9, z: ROOM_DEPTH / 2 + 1, color: theme.ink, height: 2, kind: "teacher", index: 0 });
    }
    const count = Math.min(item.session.studentCount ?? 0, 8);
    for (let index = 0; index < count; index++) {
      local.push({ x: ((index % 4) - 1.5) * 0.85 + 1.2, z: ROOM_DEPTH / 2 + 1.05 + Math.floor(index / 4) * 0.85, color: shirts[index % shirts.length]!, height: 1.55, kind: "student", index });
    }
    // Tọa độ riêng của tòa nhà (mặt tiền quay về +Z) đổi sang tọa độ khuôn viên theo hướng cửa.
    for (const { kind, index, ...spot } of local) {
      const placed: FigureSpot = {
        ...spot,
        ...(placement.facing === "south" ? { x: placement.x + spot.x, z: placement.z + spot.z } : { x: placement.x + spot.z, z: placement.z - spot.x }),
        onPick: () => onPickFigure(roomId, kind, index),
      };
      figures.push(placed);
      if (marker && marker.roomId === roomId && marker.kind === kind && marker.index === index) marked = placed;
    }
  }
  const markedSpot = marked as FigureSpot | null;
  // Điểm neo của các nhãn HTML: phía trên mái từng phòng, và phía trên đầu hình người đang chọn.
  const anchors = [
    ...campus.rooms.map(({ id, x, z }) => ({ id, x, y: ROOM_TOP + 1.25, z })),
    ...(markedSpot ? [{ id: MARKER_ID, x: markedSpot.x, y: markedSpot.height + 1.75, z: markedSpot.z }] : []),
  ];

  const labels = useRef(new Map<string, HTMLElement>());
  const register = (id: string, element: HTMLElement | null) => {
    if (element) labels.current.set(id, element);
    else labels.current.delete(id);
  };
  const reach = Math.max(campus.bounds.width, campus.bounds.depth) / 2 + 8;

  return (
    <div className="absolute inset-0">
      <Canvas
        orthographic
        // Không tone mapping: màu vật liệu hiện đúng như token màu của ứng dụng.
        flat
        shadows={shadows ? "percentage" : false}
        frameloop="demand"
        dpr={lowEnd ? 1 : [1, 2]}
        camera={CAMERA}
        onCreated={onReady}
        aria-label="Mô hình 3D isometric của trung tâm HAXI STEM"
      >
        {/* Ánh sáng mềm, ấm: nắng từ hướng tây nam nên mặt tiền phía nam sáng, bóng đổ nhẹ về đông bắc. */}
        <ambientLight intensity={1.75} />
        <hemisphereLight args={["#ffffff", theme.ground, 0.45]} />
        <directionalLight
          position={[-22, 34, 18]}
          intensity={1.25}
          color="#fff6e8"
          castShadow={shadows}
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-reach}
          shadow-camera-right={reach}
          shadow-camera-top={reach}
          shadow-camera-bottom={-reach}
          shadow-camera-near={1}
          shadow-camera-far={140}
          shadow-bias={-0.0004}
          shadow-normalBias={0.03}
          shadow-radius={4}
        />

        <Ground campus={campus} theme={theme} shadows={shadows} />
        <MainBuilding place={campus.main} logoUrl={logo.src} logoAspect={logo.width / logo.height} theme={theme} shadows={shadows} />
        {rooms.map((item) => {
          const placement = placementOf.get(item.room.id);
          return (
            placement && (
              <ClassroomBuilding
                key={item.room.id}
                placement={placement}
                state={item.state}
                selected={item.room.id === selectedId}
                attended={item.state !== "idle" && (item.session?.attendanceCount ?? 0) > 0}
                theme={theme}
                shadows={shadows}
                onSelect={() => onSelect(item.room.id)}
              />
            )
          );
        })}

        <Arena x={arena.x} z={arena.z} theme={theme} shadows={shadows} />
        <Crates x={arena.x + 3.6} z={arena.z + 1.4} theme={theme} shadows={shadows} />
        <Robot x={arena.x - 3.7} z={arena.z + 1.2} turn={0.9} theme={theme} shadows={shadows} />
        <Robot x={arena.x + 0.4} z={arena.z + 3.2} turn={0.3} theme={theme} shadows={shadows} />
        <Robot x={campus.main.x + 3.1} z={campus.main.z + MAIN_DEPTH / 2 + 2.6} turn={0.6} theme={theme} shadows={shadows} />
        <Figures spots={figures} theme={theme} shadows={shadows} />
        {markedSpot && <FigureMarker spot={markedSpot} theme={theme} />}
        <Trees spots={trees} theme={theme} shadows={shadows} />

        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.12}
          screenSpacePanning={false}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          minPolarAngle={0.45}
          maxPolarAngle={1.12}
        />
        <CameraRig campus={campus} insets={insets} apiRef={apiRef} flight={flightTo} animate={!reducedMotion} />
        <LabelProjector anchors={anchors} labels={labels} />
      </Canvas>
      {/* Lớp nhãn HTML phủ trên cảnh: không chặn chuột của cảnh, chỉ các nút nhãn nhận bấm. */}
      <div className="pointer-events-none absolute inset-0 isolate overflow-hidden">
        {rooms.map((item) => (
          <RoomLabel key={item.room.id} item={item} selected={item.room.id === selectedId} onSelect={onSelect} register={register} />
        ))}
        {marker && markedSpot && (
          <p
            ref={(element) => register(MARKER_ID, element)}
            data-scene-marker
            className="invisible absolute top-0 left-0 w-max max-w-52 origin-bottom truncate rounded-full border border-primary bg-card px-2.5 py-1 text-xs font-semibold text-foreground shadow-panel ring-2 ring-primary/30"
          >
            {marker.label}
          </p>
        )}
      </div>
    </div>
  );
}
