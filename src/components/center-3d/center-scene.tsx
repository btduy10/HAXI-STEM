"use client";

import { OrbitControls, RoundedBox } from "@react-three/drei";
import { Canvas, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { CanvasTexture, SRGBColorSpace, Vector3 } from "three";
import {
  CORRIDOR_WIDTH,
  type CenterRoom,
  type CenterSession,
  ROOM_DEPTH,
  ROOM_STATE_LABELS,
  type RoomPlacement,
  type RoomState,
  seatPositions,
} from "@/domain/center-3d";
import { cn } from "@/lib/utils";
import { FIGURE_COLORS, NAVY, ROOM_COLORS, TEAL } from "./palette";

export type SceneRoom = { room: CenterRoom; placement: RoomPlacement; state: RoomState; session: CenterSession | null };

const LOBBY_LENGTH = 6;
const WALL_HEIGHT = 1.3;
const WALL_THICKNESS = 0.12;
const DOOR_WIDTH = 1.3;
const FLOOR_TOP = 0.1;
const WOOD = "#d8b98c";
const FOV = 40;
/** Khung cảnh có tỉ lệ ngang:dọc tối thiểu này (xem `center-view`); dùng để tính khoảng cách máy quay ban đầu. */
const MIN_ASPECT = 1.6;
/** Góc nhìn ban đầu: lệch ngang về phía sảnh và nhìn chếch từ trên xuống (radian). */
const AZIMUTH = -0.36;
const ELEVATION = 0.76;
/** Nhãn của phòng nằm phía trên phòng ở độ cao này. */
const LABEL_HEIGHT = 2.9;

/** Một bức tường thấp kèm nẹp màu trạng thái ở mép trên (nhìn từ trên xuống vẫn thấy màu phòng). */
function Wall({ size, position, accent }: { size: [number, number]; position: [number, number]; accent: string }) {
  const [width, depth] = size;
  const [x, z] = position;
  return (
    <group position={[x, FLOOR_TOP, z]}>
      <mesh position-y={WALL_HEIGHT / 2} castShadow receiveShadow>
        <boxGeometry args={[width, WALL_HEIGHT, depth]} />
        <meshStandardMaterial color="#ffffff" />
      </mesh>
      <mesh position-y={WALL_HEIGHT + 0.04}>
        <boxGeometry args={[width, 0.08, depth]} />
        <meshStandardMaterial color={accent} />
      </mesh>
    </group>
  );
}

/** Hình người đơn giản: thân trụ bo tròn và đầu. `height` là chiều cao tới đỉnh đầu. */
function Figure({ position, color, height = 1.05 }: { position: [number, number, number]; color: string; height?: number }) {
  const head = 0.16;
  const body = height - head * 2;
  return (
    <group position={position}>
      <mesh position-y={body / 2} castShadow>
        <capsuleGeometry args={[0.17, Math.max(body - 0.34, 0.05), 4, 10]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <mesh position-y={body + head * 0.85} castShadow>
        <sphereGeometry args={[head, 16, 12]} />
        <meshStandardMaterial color="#f3d2b3" />
      </mesh>
    </group>
  );
}

function Room({ item, selected, onSelect }: { item: SceneRoom; selected: boolean; onSelect: (id: string) => void }) {
  const { room, placement: p, state, session } = item;
  const [hovered, setHovered] = useState(false);
  const colors = ROOM_COLORS[state];
  const seats = useMemo(() => seatPositions(p.width, p.depth, room.capacity), [p.width, p.depth, room.capacity]);
  const live = state === "live";
  // Phòng đang học: mỗi học viên của lớp một hình người, tối đa bằng số chỗ được vẽ.
  const students = live ? Math.min(session?.studentCount ?? 0, seats.length) : 0;
  const doorSegment = (p.width - DOOR_WIDTH) / 2;
  const pick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    onSelect(room.id);
  };
  const hover = (value: boolean) => (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    setHovered(value);
    document.body.style.cursor = value ? "pointer" : "";
  };

  return (
    // Trong hệ tọa độ của phòng: cửa ở phía z âm (quay về hành lang), bảng ở phía z dương.
    <group position={[p.x, 0, p.z]} rotation-y={p.side === 1 ? 0 : Math.PI}>
      {selected && (
        <mesh position-y={0.02}>
          <boxGeometry args={[p.width + 0.5, 0.04, p.depth + 0.5]} />
          <meshStandardMaterial color={NAVY} />
        </mesh>
      )}
      <mesh position-y={FLOOR_TOP / 2} receiveShadow onClick={pick} onPointerOver={hover(true)} onPointerOut={hover(false)}>
        <boxGeometry args={[p.width, FLOOR_TOP, p.depth]} />
        <meshStandardMaterial color={colors.floor} emissive={colors.accent} emissiveIntensity={hovered ? 0.18 : live ? 0.06 : 0} />
      </mesh>

      <Wall size={[p.width, WALL_THICKNESS]} position={[0, p.depth / 2 - WALL_THICKNESS / 2]} accent={colors.accent} />
      <Wall size={[WALL_THICKNESS, p.depth]} position={[p.width / 2 - WALL_THICKNESS / 2, 0]} accent={colors.accent} />
      <Wall size={[WALL_THICKNESS, p.depth]} position={[-p.width / 2 + WALL_THICKNESS / 2, 0]} accent={colors.accent} />
      {[-1, 1].map((sign) => (
        <Wall
          key={sign}
          size={[doorSegment, WALL_THICKNESS]}
          position={[sign * (DOOR_WIDTH / 2 + doorSegment / 2), -p.depth / 2 + WALL_THICKNESS / 2]}
          accent={colors.accent}
        />
      ))}

      {/* Bảng trên tường cuối phòng. */}
      <mesh position={[0, FLOOR_TOP + 0.75, p.depth / 2 - WALL_THICKNESS - 0.03]}>
        <boxGeometry args={[Math.min(p.width - 1.6, 3.4), 0.8, 0.05]} />
        <meshStandardMaterial color={live ? "#ffffff" : "#f1f5f9"} emissive="#ffffff" emissiveIntensity={live ? 0.25 : 0} />
      </mesh>

      {seats.map((seat, index) => (
        <group key={index} position={[seat.x, FLOOR_TOP, seat.z]}>
          <mesh position-y={0.3} castShadow receiveShadow>
            <boxGeometry args={[0.78, 0.6, 0.42]} />
            <meshStandardMaterial color={WOOD} />
          </mesh>
          {index < students && <Figure position={[0, 0, -0.42]} color={FIGURE_COLORS[index % FIGURE_COLORS.length]!} />}
        </group>
      ))}
      {live && session?.teacherName && <Figure position={[Math.min(1.1, p.width / 2 - 0.8), FLOOR_TOP, p.depth / 2 - 0.95]} color={NAVY} height={1.45} />}
    </group>
  );
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
        "pointer-events-auto invisible absolute top-0 left-0 grid w-max max-w-56 origin-center gap-0.5 rounded-xl border bg-white/95 px-2.5 py-1.5 text-left text-xs leading-tight text-slate-900 shadow-md outline-none select-none",
        "focus-visible:ring-3 focus-visible:ring-sky-500/60",
        selected ? "border-slate-900" : "border-slate-200",
      )}
    >
      <span className="flex items-center gap-1.5 font-semibold">
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: ROOM_COLORS[state].accent }} />
        <span className="truncate">{room.name}</span>
      </span>
      {shown && detailed ? (
        <>
          <span className="truncate">{shown.className}</span>
          <span className="truncate text-slate-600">
            {shown.startTime}–{shown.endTime}
            {shown.teacherName ? ` · ${shown.teacherName}` : ""}
          </span>
          {shown.studentCount !== null && (
            <span className="text-slate-600">
              Sĩ số {shown.studentCount}/{room.capacity}
            </span>
          )}
        </>
      ) : shown ? (
        <span className="truncate text-slate-600">
          {shown.startTime} · {shown.className}
        </span>
      ) : (
        <span className="text-slate-600">{ROOM_STATE_LABELS[state]}</span>
      )}
    </button>
  );
}

/**
 * Mỗi khung hình: chiếu vị trí từng phòng lên màn hình rồi dời nhãn HTML của phòng tới đó, co giãn theo khoảng cách;
 * phòng gần máy quay hơn nằm trên. Nhãn của phòng ra ngoài khung nhìn thì ẩn.
 */
function LabelProjector({
  rooms,
  labels,
  reference,
}: {
  rooms: SceneRoom[];
  labels: RefObject<Map<string, HTMLElement>>;
  /** Khoảng cách mà ở đó nhãn có cỡ chữ thường. */
  reference: number;
}) {
  const invalidate = useThree((state) => state.invalidate);
  // Danh sách phòng đổi (nhãn mới được gắn): vẽ lại một khung hình để đặt vị trí.
  useEffect(() => invalidate(), [rooms, invalidate]);
  useFrame(({ camera, size }) => {
    const point = new Vector3();
    for (const { room, placement } of rooms) {
      const element = labels.current.get(room.id);
      if (!element) continue;
      point.set(placement.x, LABEL_HEIGHT, placement.z);
      const distance = camera.position.distanceTo(point);
      point.project(camera);
      const inView = point.z < 1 && Math.abs(point.x) < 1.15 && Math.abs(point.y) < 1.15;
      element.style.visibility = inView ? "visible" : "hidden";
      if (!inView) continue;
      const x = (point.x * 0.5 + 0.5) * size.width;
      const y = (-point.y * 0.5 + 0.5) * size.height;
      const scale = Math.min(1, Math.max(0.6, (reference * 0.9) / distance));
      element.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
      element.style.zIndex = String(Math.max(1, Math.round(2000 - distance * 20)));
    }
  });
  return null;
}

/** Biển tên ở sảnh: chữ vẽ lên canvas 2D rồi dán làm vân bề mặt (không tải phông chữ hay tệp nào từ ngoài). */
function useSignTexture() {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 320;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = NAVY;
      context.font = "800 150px system-ui, 'Segoe UI', Roboto, sans-serif";
      context.fillText("HAXI STEM", canvas.width / 2, 125);
      context.fillStyle = TEAL;
      context.font = "600 62px system-ui, 'Segoe UI', Roboto, sans-serif";
      context.fillText("Trung tâm Robotics", canvas.width / 2, 250);
    }
    const result = new CanvasTexture(canvas);
    result.colorSpace = SRGBColorSpace;
    result.anisotropy = 4;
    return result;
  }, []);
  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}

/** Robot nhỏ đứng ở sảnh. */
function Robot({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <RoundedBox args={[0.6, 0.7, 0.45]} radius={0.08} position-y={0.55} castShadow>
        <meshStandardMaterial color="#4dd0c0" />
      </RoundedBox>
      <RoundedBox args={[0.5, 0.4, 0.4]} radius={0.08} position-y={1.15} castShadow>
        <meshStandardMaterial color="#ffffff" />
      </RoundedBox>
      {[-0.11, 0.11].map((x) => (
        <mesh key={x} position={[x, 1.17, 0.21]}>
          <sphereGeometry args={[0.05, 12, 10]} />
          <meshStandardMaterial color={NAVY} />
        </mesh>
      ))}
      <mesh position-y={1.45}>
        <cylinderGeometry args={[0.015, 0.015, 0.2, 6]} />
        <meshStandardMaterial color={NAVY} />
      </mesh>
      <mesh position-y={1.57}>
        <sphereGeometry args={[0.05, 12, 10]} />
        <meshStandardMaterial color="#f2b84b" emissive="#f2b84b" emissiveIntensity={0.5} />
      </mesh>
      {[-0.17, 0.17].map((x) => (
        <mesh key={x} position={[x, 0.1, 0]} castShadow>
          <boxGeometry args={[0.18, 0.2, 0.3]} />
          <meshStandardMaterial color={NAVY} />
        </mesh>
      ))}
    </group>
  );
}

function Plant({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position-y={0.25} castShadow>
        <cylinderGeometry args={[0.22, 0.17, 0.5, 12]} />
        <meshStandardMaterial color="#c98f5d" />
      </mesh>
      <mesh position-y={0.95} castShadow>
        <sphereGeometry args={[0.48, 14, 12]} />
        <meshStandardMaterial color="#5fae86" />
      </mesh>
    </group>
  );
}

/** Sảnh ở đầu hành lang: biển tên, quầy lễ tân, robot và chậu cây. `x` là tâm sảnh. */
function Lobby({ x }: { x: number }) {
  const sign = useSignTexture();
  return (
    <group position={[x, FLOOR_TOP, 0]}>
      <group position={[0, 0, -ROOM_DEPTH / 2 - 0.4]}>
        {[-1.7, 1.7].map((post) => (
          <mesh key={post} position={[post, 0.9, 0]} castShadow>
            <boxGeometry args={[0.12, 1.8, 0.12]} />
            <meshStandardMaterial color={NAVY} />
          </mesh>
        ))}
        <mesh position-y={2.35} castShadow>
          <boxGeometry args={[4.4, 1.5, 0.14]} />
          <meshStandardMaterial color={NAVY} />
        </mesh>
        <mesh position={[0, 2.35, 0.08]}>
          <planeGeometry args={[4.16, 1.3]} />
          <meshBasicMaterial map={sign} toneMapped={false} />
        </mesh>
      </group>
      <RoundedBox args={[2.6, 1, 0.8]} radius={0.1} position={[0, 0.5, -0.6]} castShadow receiveShadow>
        <meshStandardMaterial color={TEAL} />
      </RoundedBox>
      <Figure position={[0, 0, -1.25]} color="#f2b84b" height={1.5} />
      <Robot position={[1.9, 0, 0.9]} />
      <Plant position={[-2.2, 0, -1.7]} />
      <Plant position={[-2.2, 0, 2.2]} />
    </group>
  );
}

type Controls = { target: Vector3; update: () => void };

/**
 * Phòng được chọn nằm sát mép hoặc ngoài khung nhìn thì lia máy quay tới: dời điểm nhìn và máy quay cùng một đoạn nên
 * góc nhìn giữ nguyên. Phòng đang nằm gọn trong khung thì không dời (các phòng khác không bị đẩy ra ngoài).
 */
function Focus({ goal, animate }: { goal: [number, number, number] | null; animate: boolean }) {
  const invalidate = useThree((state) => state.invalidate);
  const pending = useRef<{ target: Vector3; checked: boolean } | null>(null);
  useEffect(() => {
    pending.current = goal ? { target: new Vector3(...goal), checked: false } : null;
    invalidate();
  }, [goal, invalidate]);
  useFrame((state) => {
    const move = pending.current;
    const controls = state.controls as unknown as Controls | null;
    if (!move || !controls) return;
    if (!move.checked) {
      move.checked = true;
      const seen = move.target.clone().project(state.camera);
      if (seen.z < 1 && Math.abs(seen.x) < 0.72 && Math.abs(seen.y) < 0.72) {
        pending.current = null;
        return;
      }
    }
    const step = move.target.clone().sub(controls.target);
    const arrived = !animate || step.length() < 0.03;
    if (!arrived) step.multiplyScalar(0.14);
    state.camera.position.add(step);
    controls.target.add(step);
    controls.update();
    if (arrived) pending.current = null;
    else state.invalidate();
  });
  return null;
}

/**
 * Cảnh 3D của trung tâm: sảnh, hành lang và các phòng học theo `layoutRooms`. Chỉ để xem: bấm phòng (hoặc nhãn của phòng)
 * để chọn; việc mở buổi học nằm ở bảng bên cạnh. Chỉ vẽ lại khi có thay đổi (`frameloop="demand"`).
 */
export function CenterScene({
  rooms,
  length,
  selectedId,
  onSelect,
}: {
  rooms: SceneRoom[];
  /** Chiều dài dãy phòng dài nhất (từ `layoutRooms`). */
  length: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [reducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  // Sảnh nằm trước dãy phòng theo trục X; nền bao cả sảnh và hai dãy phòng.
  const lobbyX = -length / 2 - LOBBY_LENGTH / 2;
  const spanX = length + LOBBY_LENGTH + 3;
  const spanZ = CORRIDOR_WIDTH + ROOM_DEPTH * 2 + 3;
  const centerX = -LOBBY_LENGTH / 2;
  // Khoảng cách máy quay để cả nền nằm gọn trong khung, tính cho khung hẹp nhất (tỉ lệ MIN_ASPECT).
  const [sin, cos] = [Math.sin(Math.abs(AZIMUTH)), Math.cos(AZIMUTH)];
  const halfFov = (FOV * Math.PI) / 360;
  const across = spanX * cos + spanZ * sin;
  const upward = (spanZ * cos + spanX * sin) * Math.sin(ELEVATION) + 3 * Math.cos(ELEVATION);
  const distance = Math.max(across / 2 / (Math.tan(halfFov) * MIN_ASPECT), upward / 2 / Math.tan(halfFov)) * 1.04 + spanZ * 0.1;
  // Phần cảnh gần máy quay trông lớn hơn nên điểm nhìn dời một chút về phía máy quay cho cảnh cân trong khung.
  const lead = spanZ * 0.12;
  const lookAtX = centerX + Math.sin(AZIMUTH) * lead;
  const lookAtZ = cos * lead;
  const cameraPosition: [number, number, number] = [
    lookAtX + distance * Math.sin(AZIMUTH) * Math.cos(ELEVATION),
    distance * Math.sin(ELEVATION),
    lookAtZ + distance * cos * Math.cos(ELEVATION),
  ];
  // Đèn chiếu về gốc tọa độ; vùng đổ bóng phủ cả nền dù cảnh lệch về phía sảnh.
  const shadowReach = Math.max(spanX, spanZ) / 2 + LOBBY_LENGTH;
  const target = useMemo<[number, number, number]>(() => [lookAtX, 0, lookAtZ], [lookAtX, lookAtZ]);
  const selected = rooms.find((item) => item.room.id === selectedId);
  const goal = useMemo<[number, number, number] | null>(
    () => (selected ? [selected.placement.x, 0, selected.placement.z] : null),
    [selected],
  );
  const labels = useRef(new Map<string, HTMLElement>());
  const register = (id: string, element: HTMLButtonElement | null) => {
    if (element) labels.current.set(id, element);
    else labels.current.delete(id);
  };

  return (
    <div className="absolute inset-0">
      <Canvas
        shadows="percentage"
        frameloop="demand"
        dpr={[1, 2]}
        camera={{ position: cameraPosition, fov: FOV, near: 0.5, far: 400 }}
        aria-label="Mô hình 3D trung tâm HAXI STEM"
      >
      <ambientLight intensity={1.35} />
      <hemisphereLight args={["#ffffff", "#cfe5e1", 0.9]} />
      <directionalLight
        position={[14, 26, 16]}
        intensity={2.1}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-shadowReach}
        shadow-camera-right={shadowReach}
        shadow-camera-top={shadowReach}
        shadow-camera-bottom={-shadowReach}
        shadow-camera-near={1}
        shadow-camera-far={120}
        shadow-bias={-0.0005}
      />

      {/* Nền của trung tâm và hành lang. */}
      <RoundedBox args={[spanX, 0.5, spanZ]} radius={0.2} position={[centerX, -0.25, 0]} receiveShadow>
        <meshStandardMaterial color="#c3dcd3" />
      </RoundedBox>
      <mesh position={[centerX, 0.01, 0]} receiveShadow>
        <boxGeometry args={[length + LOBBY_LENGTH, 0.02, CORRIDOR_WIDTH]} />
        <meshStandardMaterial color="#f7f1e6" />
      </mesh>
      <mesh position={[lobbyX, FLOOR_TOP / 2, 0]} receiveShadow>
        <boxGeometry args={[LOBBY_LENGTH - 0.8, FLOOR_TOP, ROOM_DEPTH + CORRIDOR_WIDTH]} />
        <meshStandardMaterial color="#fdf8f2" />
      </mesh>
      <Lobby x={lobbyX} />

      {rooms.map((item) => (
        <Room key={item.room.id} item={item} selected={item.room.id === selectedId} onSelect={onSelect} />
      ))}

      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.12}
        target={target}
        minDistance={7}
        maxDistance={distance * 2.2}
        minPolarAngle={0.12}
        maxPolarAngle={1.2}
      />
      <Focus goal={goal} animate={!reducedMotion} />
      <LabelProjector rooms={rooms} labels={labels} reference={distance} />
      </Canvas>
      {/* Lớp nhãn HTML phủ trên cảnh: không chặn chuột của cảnh, chỉ các nút nhãn nhận bấm. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {rooms.map((item) => (
          <RoomLabel key={item.room.id} item={item} selected={item.room.id === selectedId} onSelect={onSelect} register={register} />
        ))}
      </div>
    </div>
  );
}
