"use client";

import { Instance, Instances } from "@react-three/drei";
import { type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { type RefObject, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { BackSide, Color, DoubleSide, type Group, type InstancedMesh, type Mesh, Object3D, Shape } from "three";
import { type CenterSession, type PathPoint, type Rect, loopPath, pathLength, pointOnPath, sessionPhase } from "@/domain/center-3d";
import { TIME_ZONE } from "@/lib/format";
import { PAVEMENT } from "./buildings";
import { Robot } from "./scene-props";
import type { SceneTheme } from "./theme";

// Phần "sống" của cảnh 3D: người đi vào lớp và ra về theo thời khóa biểu, robot tuần tra theo đường chấm xanh, chùm sao khi ghi sao.
// Mọi chuyển động tính trong useFrame bằng nội suy theo đồng hồ của trình duyệt và ghi thẳng vào đối tượng three.js
// (không setInterval, không đổi state mỗi khung hình).

// Đối tượng tạm dùng chung để tính ma trận của từng instance (chỉ dùng tức thời trong một khung hình).
const SCRATCH = new Object3D();
const SCRATCH_COLOR = new Color();

const clockParts = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
/** Số giây từ đầu ngày theo giờ Việt Nam (có phần lẻ để chuyển động mượt). */
export function nowSeconds(now: number = Date.now()): number {
  const [hours, minutes, seconds] = clockParts.format(now).split(":").map(Number) as [number, number, number];
  return hours * 3600 + minutes * 60 + seconds + (now % 1000) / 1000;
}

/**
 * Giữ cho cảnh được vẽ liên tục khi có chuyển động nền: mỗi khung hình thứ hai của trình duyệt xin vẽ một khung (khoảng 30
 * khung hình/giây). Trình duyệt tự dừng requestAnimationFrame khi tab bị ẩn; cảnh cuộn ra khỏi khung nhìn thì cũng ngừng xin vẽ.
 */
export function Pulse({ active }: { active: boolean }) {
  const invalidate = useThree((state) => state.invalidate);
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    let count = 0;
    let inView = true;
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? true;
    });
    observer.observe(gl.domElement);
    const loop = () => {
      count += 1;
      if (inView && count % 2 === 0) invalidate();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [active, gl, invalidate]);
  return null;
}

/** Ghi số khung hình đã vẽ và số geometry, texture đang giữ lên phần tử canvas (để đo hiệu năng), nhiều nhất 2 lần mỗi giây. */
export function SceneStats() {
  const frames = useRef(0);
  const written = useRef(0);
  useFrame(({ gl }) => {
    frames.current += 1;
    const now = performance.now();
    if (now - written.current < 500) return;
    written.current = now;
    const data = gl.domElement.dataset;
    data.frames = String(frames.current);
    data.geometries = String(gl.info.memory.geometries);
    data.textures = String(gl.info.memory.textures);
  });
  return null;
}

// ---------- Người đi theo thời khóa biểu ----------

/** Một hình người của cảnh. Có `session` thì xuất hiện theo giờ của buổi (đi tới, đứng trước cửa, đi về); không có thì đứng yên. */
export type Walker = {
  key: string;
  color: string;
  /** Chiều cao tới đỉnh đầu. */
  height: number;
  /** Chỗ đứng (trước cửa phòng trong giờ học). */
  spot: PathPoint;
  /** Lộ trình từ cổng tới chỗ đứng, và thứ tự xuất phát (người sau đi sau một chút). */
  path?: PathPoint[];
  order?: number;
  session?: Pick<CenterSession, "startTime" | "endTime" | "cancelled">;
  onPick?: () => void;
};

export type Pose = { x: number; z: number; visible: boolean; /** Quãng đường đã đi, để tính nhịp nhún. */ walked: number };

/** Vị trí của một hình người lúc `seconds`. Tắt chuyển động: người đang tới hiện thẳng ở chỗ đứng, người đang về thì không hiện. */
export function walkerPose(walker: Walker, seconds: number, animate: boolean): Pose {
  const still = { x: walker.spot.x, z: walker.spot.z, visible: true, walked: 0 };
  if (!walker.session) return still;
  const stage = sessionPhase(walker.session, seconds);
  if (!stage) return { ...still, visible: false };
  if (stage.phase === "live" || !walker.path) return still;
  if (!animate) return { ...still, visible: stage.phase === "arriving" };
  // Người thứ n xuất phát trễ hơn một chút; ai cũng tới nơi trước khi hết quãng thời gian.
  const t = Math.min(1, Math.max(0, stage.t * 1.5 - (walker.order ?? 0) * 0.055));
  const along = stage.phase === "arriving" ? t : 1 - t;
  const point = pointOnPath(walker.path, along);
  const moving = t > 0 && t < 1;
  return { x: point.x, z: point.z, visible: stage.phase === "arriving" ? t > 0 : t < 1, walked: moving ? along * pathLength(walker.path) : 0 };
}

/** Vị trí hình người đang được đánh dấu, do `Figures` cập nhật mỗi khung hình; nhãn tên nổi đọc từ đây. */
export type MarkerSpot = { x: number; z: number; height: number; visible: boolean };

const BODY_Y = 0.36;
const HEAD_Y = 0.84;

/**
 * Mọi hình người của cảnh (thân và đầu là hai InstancedMesh). Vị trí tính lại mỗi khung hình theo giờ. Hình có `onPick` thì
 * bấm được: rê chuột vào có viền sáng và con trỏ bàn tay. Hình trùng `markedKey` được đánh dấu là đang chọn.
 */
export function Figures({
  walkers,
  theme,
  shadows,
  animate,
  markedKey,
  markerRef,
}: {
  walkers: Walker[];
  theme: SceneTheme;
  shadows: boolean;
  animate: boolean;
  markedKey: string | null;
  markerRef: RefObject<MarkerSpot | null>;
}) {
  const invalidate = useThree((state) => state.invalidate);
  const bodies = useRef<InstancedMesh>(null);
  const heads = useRef<InstancedMesh>(null);
  const hoverHull = useRef<Mesh>(null);
  const marker = useRef<Group>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  // Sức chứa tăng theo nấc 32 để không phải dựng lại InstancedMesh mỗi khi sĩ số đổi.
  const capacity = Math.max(32, Math.ceil(walkers.length / 32) * 32);
  const colorKey = walkers.map((walker) => walker.color).join("|");
  const markedIndex = markedKey ? walkers.findIndex((walker) => walker.key === markedKey) : -1;

  useEffect(() => {
    const mesh = bodies.current;
    if (!mesh) return;
    colorKey.split("|").forEach((value, index) => value && mesh.setColorAt(index, SCRATCH_COLOR.set(value)));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    invalidate();
  }, [colorKey, capacity, invalidate]);
  // Không có chuyển động nền (giảm chuyển động, máy yếu): mỗi lần trang dựng lại (đồng hồ, dữ liệu mới) vẽ lại một khung để cập nhật.
  useEffect(() => invalidate());
  useEffect(
    () => () => {
      document.body.style.cursor = "";
    },
    [],
  );

  useFrame(() => {
    const [body, head] = [bodies.current, heads.current];
    if (!body || !head) return;
    const seconds = nowSeconds();
    let markedPose: (Pose & { height: number }) | null = null;
    let hoveredPose: (Pose & { height: number }) | null = null;
    for (let index = 0; index < capacity; index++) {
      const walker = walkers[index];
      const pose = walker ? walkerPose(walker, seconds, animate) : null;
      const scale = walker && pose?.visible ? walker.height / 1.25 : 0;
      const height = walker?.height ?? 1;
      // Nhún nhẹ theo quãng đường đã đi.
      const bob = pose && pose.walked > 0 ? Math.abs(Math.sin(pose.walked * 4.2)) * 0.07 : 0;
      SCRATCH.position.set(pose?.x ?? 0, PAVEMENT + height * BODY_Y + bob, pose?.z ?? 0);
      SCRATCH.scale.setScalar(scale);
      SCRATCH.updateMatrix();
      body.setMatrixAt(index, SCRATCH.matrix);
      SCRATCH.position.y = PAVEMENT + height * HEAD_Y + bob;
      SCRATCH.updateMatrix();
      head.setMatrixAt(index, SCRATCH.matrix);
      if (walker && pose?.visible) {
        if (index === markedIndex) markedPose = { ...pose, height };
        if (index === hovered) hoveredPose = { ...pose, height };
      }
    }
    body.count = head.count = capacity;
    body.instanceMatrix.needsUpdate = true;
    head.instanceMatrix.needsUpdate = true;
    // Hình thể có thể đã đi xa khỏi vùng bao lúc dựng: tính lại để bấm và cắt khung nhìn vẫn đúng.
    body.computeBoundingSphere();
    head.computeBoundingSphere();

    const shown = markedPose as (Pose & { height: number }) | null;
    markerRef.current = shown ? { x: shown.x, z: shown.z, height: shown.height, visible: true } : null;
    if (marker.current) {
      marker.current.visible = shown !== null;
      if (shown) {
        marker.current.position.set(shown.x, PAVEMENT, shown.z);
        marker.current.scale.setScalar(shown.height / 1.55);
      }
    }
    const over = hoveredPose as (Pose & { height: number }) | null;
    if (hoverHull.current) {
      hoverHull.current.visible = over !== null && hovered !== markedIndex;
      if (over) {
        hoverHull.current.position.set(over.x, PAVEMENT + over.height * BODY_Y, over.z);
        hoverHull.current.scale.setScalar((over.height / 1.25) * 1.3);
      }
    }
  });

  const pickable = (event: ThreeEvent<MouseEvent | PointerEvent>) => (event.instanceId !== undefined && walkers[event.instanceId]?.onPick ? event.instanceId : null);
  const hover = (event: ThreeEvent<PointerEvent>) => {
    const index = pickable(event);
    if (index !== null) event.stopPropagation();
    document.body.style.cursor = index === null ? "" : "pointer";
    if (index !== hovered) {
      setHovered(index);
      invalidate();
    }
  };
  const leave = () => {
    document.body.style.cursor = "";
    setHovered(null);
    invalidate();
  };
  const click = (event: ThreeEvent<MouseEvent>) => {
    const index = pickable(event);
    if (index === null) return;
    event.stopPropagation();
    walkers[index]!.onPick!();
  };

  return (
    <>
      <instancedMesh key={`body-${capacity}`} ref={bodies} args={[undefined, undefined, capacity]} castShadow={shadows} onClick={click} onPointerMove={hover} onPointerOut={leave}>
        <capsuleGeometry args={[0.2, 0.5, 4, 10]} />
        <meshStandardMaterial />
      </instancedMesh>
      <instancedMesh key={`head-${capacity}`} ref={heads} args={[undefined, undefined, capacity]} castShadow={shadows}>
        <sphereGeometry args={[0.19, 14, 10]} />
        <meshStandardMaterial color={theme.skin} />
      </instancedMesh>
      {/* Viền sáng khi rê chuột vào một hình người bấm được (nhạt hơn viền của hình đang chọn). */}
      <mesh ref={hoverHull} visible={false}>
        <capsuleGeometry args={[0.2, 0.5, 4, 10]} />
        <meshBasicMaterial color={theme.done} side={BackSide} toneMapped={false} />
      </mesh>
      {/* Hình người đang chọn: vòng sáng dưới chân, viền sáng quanh thân và mũi tên chỉ xuống phía trên đầu. */}
      <group ref={marker} visible={false}>
        <mesh position-y={0.03}>
          <cylinderGeometry args={[0.62, 0.62, 0.04, 28]} />
          <meshStandardMaterial color={theme.teal} emissive={theme.teal} emissiveIntensity={0.6} />
        </mesh>
        <mesh position-y={1.55 * BODY_Y} scale={(1.55 / 1.25) * 1.32}>
          <capsuleGeometry args={[0.2, 0.5, 4, 10]} />
          <meshBasicMaterial color={theme.teal} side={BackSide} toneMapped={false} />
        </mesh>
        <mesh position-y={1.55 + 0.75} rotation-x={Math.PI}>
          <coneGeometry args={[0.24, 0.48, 4]} />
          <meshStandardMaterial color={theme.teal} emissive={theme.teal} emissiveIntensity={0.6} flatShading />
        </mesh>
      </group>
    </>
  );
}

// ---------- Robot tuần tra ----------

const ROBOT_SPEED = 1.05;

/** Một robot trang trí chạy vòng theo lộ trình hình chữ nhật, quay mặt theo hướng đi. Tắt chuyển động thì đứng ở điểm xuất phát. */
function PatrolRobot({ loop, offset, theme, shadows, animate }: { loop: Rect; offset: number; theme: SceneTheme; shadows: boolean; animate: boolean }) {
  const group = useRef<Group>(null);
  const path = useMemo(() => loopPath(loop), [loop]);
  const length = pathLength(path);
  useFrame(() => {
    if (!group.current) return;
    const t = animate && length > 0 ? ((performance.now() / 1000) * ROBOT_SPEED) / length + offset : offset;
    const point = pointOnPath(path, t % 1);
    group.current.position.set(point.x, 0, point.z);
    group.current.rotation.y = point.heading;
  });
  return (
    <group ref={group}>
      <Robot x={0} z={0} theme={theme} shadows={shadows} />
    </group>
  );
}

/** Ba robot tuần tra và đường chấm xanh đánh dấu lộ trình của chúng. */
export function Patrols({ loops, theme, shadows, animate }: { loops: Rect[]; theme: SceneTheme; shadows: boolean; animate: boolean }) {
  const dots = useMemo(
    () =>
      loops.flatMap((loop) => {
        const path = loopPath(loop);
        const count = Math.max(4, Math.round(pathLength(path) / 0.75));
        return Array.from({ length: count }, (_, index) => pointOnPath(path, index / count));
      }),
    [loops],
  );
  return (
    <>
      {dots.length > 0 && (
        <Instances limit={dots.length}>
          <cylinderGeometry args={[0.1, 0.1, 0.02, 10]} />
          <meshStandardMaterial color={theme.live} emissive={theme.live} emissiveIntensity={0.35} />
          {dots.map((dot, index) => (
            <Instance key={index} position={[dot.x, PAVEMENT + 0.04, dot.z]} />
          ))}
        </Instances>
      )}
      {loops.map((loop, index) => (
        <PatrolRobot key={index} loop={loop} offset={index * 0.37} theme={theme} shadows={shadows} animate={animate} />
      ))}
    </>
  );
}

// ---------- Chùm sao khi ghi sao ----------

/** Nơi một chùm sao bay lên: chỗ nhóm học viên đứng trước cửa phòng. */
export type BurstPlace = PathPoint;
type Burst = BurstPlace & { start: number };

const BURST_MS = 1600;
const STARS_PER_BURST = 10;
const MAX_BURSTS = 4;

function starShape() {
  const shape = new Shape();
  for (let index = 0; index < 10; index++) {
    const radius = index % 2 === 0 ? 0.5 : 0.21;
    const angle = (index / 10) * Math.PI * 2 + Math.PI / 2;
    if (index === 0) shape.moveTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
    else shape.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
  }
  shape.closePath();
  return shape;
}

/**
 * Khi số lần ghi sao của một buổi tăng lên (so với lần dữ liệu trước), một chùm ngôi sao vàng đồng bay lên từ nhóm học viên
 * trước cửa phòng của buổi đó rồi tan dần, và nền chỗ các em đứng sáng lên một nhịp. Tắt chuyển động: chỉ có nhịp sáng, không có sao bay.
 * `counts`: chuỗi JSON của [mã buổi, số lần ghi sao][] (chuỗi để chỉ chạy lại khi số liệu thật sự đổi).
 */
export function StarBursts({ counts, placeOf, theme, animate }: { counts: string; placeOf: (sessionId: string) => BurstPlace | null; theme: SceneTheme; animate: boolean }) {
  const invalidate = useThree((state) => state.invalidate);
  const stars = useRef<InstancedMesh>(null);
  const glows = useRef<InstancedMesh>(null);
  const seen = useRef<Map<string, number> | null>(null);
  const bursts = useRef<Burst[]>([]);
  const shape = useMemo(() => starShape(), []);
  const locate = useEffectEvent(placeOf);
  /** Số chùm sao vừa thêm, chờ ghi lên phần tử canvas ở khung hình kế tiếp. */
  const fresh = useRef(0);

  useEffect(() => {
    const next = new Map(JSON.parse(counts) as [string, number][]);
    const before = seen.current;
    seen.current = next;
    // Lần đầu chỉ ghi nhớ số liệu; buổi mới xuất hiện cũng không tính là vừa ghi sao.
    if (!before) return;
    let added = 0;
    for (const [sessionId, count] of next) {
      const previous = before.get(sessionId);
      const spot = previous !== undefined && count > previous ? locate(sessionId) : null;
      if (!spot) continue;
      bursts.current = [...bursts.current.slice(-(MAX_BURSTS - 1)), { ...spot, start: performance.now() }];
      added += 1;
    }
    if (added === 0) return;
    fresh.current += added;
    invalidate();
  }, [counts, invalidate]);

  useFrame((state) => {
    const [starMesh, glowMesh] = [stars.current, glows.current];
    if (!starMesh || !glowMesh) return;
    if (fresh.current > 0) {
      const data = state.gl.domElement.dataset;
      data.starBursts = String(Number(data.starBursts ?? "0") + fresh.current);
      fresh.current = 0;
    }
    const now = performance.now();
    bursts.current = bursts.current.filter((burst) => now - burst.start < BURST_MS);
    for (let slot = 0; slot < MAX_BURSTS; slot++) {
      const burst = bursts.current[slot];
      const age = burst ? (now - burst.start) / BURST_MS : 1;
      const swell = Math.sin(Math.PI * age);
      for (let index = 0; index < STARS_PER_BURST; index++) {
        const angle = index * 2.4;
        const reach = (0.4 + age * 1.5) * (0.55 + (index % 3) * 0.25);
        SCRATCH.position.set((burst?.x ?? 0) + Math.cos(angle) * reach, PAVEMENT + 1.7 + age * (4 + (index % 4) * 0.7), (burst?.z ?? 0) + Math.sin(angle) * reach);
        // Ngôi sao luôn quay mặt về máy quay.
        SCRATCH.quaternion.copy(state.camera.quaternion);
        SCRATCH.scale.setScalar(burst && animate ? swell * (1.1 + (index % 2) * 0.5) : 0);
        SCRATCH.updateMatrix();
        starMesh.setMatrixAt(slot * STARS_PER_BURST + index, SCRATCH.matrix);
      }
      SCRATCH.position.set(burst?.x ?? 0, PAVEMENT + 0.035, burst?.z ?? 0);
      SCRATCH.quaternion.identity();
      SCRATCH.scale.set(burst ? 0.4 + swell * 1.1 : 0, 1, burst ? 0.4 + swell * 1.1 : 0);
      SCRATCH.updateMatrix();
      glowMesh.setMatrixAt(slot, SCRATCH.matrix);
    }
    starMesh.instanceMatrix.needsUpdate = true;
    glowMesh.instanceMatrix.needsUpdate = true;
    starMesh.computeBoundingSphere();
    glowMesh.computeBoundingSphere();
    if (bursts.current.length > 0) state.invalidate();
  });

  return (
    <>
      <instancedMesh ref={stars} args={[undefined, undefined, MAX_BURSTS * STARS_PER_BURST]} frustumCulled={false}>
        <shapeGeometry args={[shape]} />
        <meshBasicMaterial color={theme.gold} side={DoubleSide} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={glows} args={[undefined, undefined, MAX_BURSTS]} frustumCulled={false}>
        <cylinderGeometry args={[2.1, 2.1, 0.03, 32]} />
        <meshBasicMaterial color={theme.goldSoft} toneMapped={false} />
      </instancedMesh>
    </>
  );
}
