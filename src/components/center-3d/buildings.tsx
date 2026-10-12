"use client";

import { type ThreeEvent, useThree } from "@react-three/fiber";
import { useEffect, useState } from "react";
import { SRGBColorSpace, type Texture, TextureLoader } from "three";
import { type BuildingPlacement, MAIN_DEPTH, MAIN_WIDTH, ROOM_DEPTH, type Rect, type RoomState } from "@/domain/center-3d";
import { type SceneTheme, stateColor } from "./theme";

// Các tòa nhà của khuôn viên, dựng bằng hình khối trong code. Mỗi tòa dựng trong hệ tọa độ riêng với mặt tiền quay về +Z,
// rồi xoay theo hướng cửa của nó.

/** Mặt nền mà nhà, người và vật thể đứng lên (mặt trên của vỉa hè, sân). */
export const PAVEMENT = 0.1;
const WALL_HEIGHT = 3.2;
/** Độ cao đỉnh mái phòng học; nhãn của phòng nằm phía trên mức này. */
export const ROOM_TOP = PAVEMENT + 0.2 + WALL_HEIGHT + 0.3;

function Box({
  size,
  position,
  color,
  shadows,
  emissive,
}: {
  size: [number, number, number];
  position: [number, number, number];
  color: string;
  shadows?: boolean;
  /** Tự phát sáng nhẹ bằng chính màu của khối (đèn báo trạng thái). */
  emissive?: number;
}) {
  return (
    <mesh position={position} castShadow={shadows} receiveShadow={shadows}>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} emissive={emissive ? color : undefined} emissiveIntensity={emissive ?? 0} />
    </mesh>
  );
}

/**
 * Một phòng học: thân trắng kem, mái và viền cửa màu thương hiệu, cửa, cửa sổ, biển tên. Dải màu dưới mái và đèn báo trên
 * mái theo trạng thái (đang học, sắp học…). Bấm vào để chọn phòng.
 */
export function ClassroomBuilding({
  placement,
  state,
  selected,
  theme,
  shadows,
  onSelect,
}: {
  placement: BuildingPlacement;
  state: RoomState;
  selected: boolean;
  theme: SceneTheme;
  shadows: boolean;
  onSelect: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const front = placement.front;
  const depth = ROOM_DEPTH;
  const accent = stateColor(theme, state);
  const active = state === "live" || state === "upcoming";
  const base = PAVEMENT + 0.2;
  const faceZ = depth / 2;
  const pick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    onSelect();
  };
  const hover = (value: boolean) => (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    setHovered(value);
    document.body.style.cursor = value ? "pointer" : "";
  };
  // Cửa sổ mặt tiền hai bên cửa (phòng đủ rộng), và hai cửa sổ ở mỗi mặt bên.
  const frontWindows = front >= 7 ? [-(front / 2 - 1.45), front / 2 - 1.45] : [];

  return (
    <group position={[placement.x, 0, placement.z]} rotation-y={placement.facing === "south" ? 0 : Math.PI / 2}>
      {(selected || hovered) && <Box size={[front + 1.3, 0.05, depth + 1.3]} position={[0, PAVEMENT + 0.03, 0]} color={selected ? theme.roof : theme.done} />}
      <Box size={[front + 0.3, 0.2, depth + 0.3]} position={[0, PAVEMENT + 0.1, 0]} color={theme.trim} shadows={shadows} />
      <mesh position={[0, base + WALL_HEIGHT / 2, 0]} castShadow={shadows} receiveShadow={shadows} onClick={pick} onPointerOver={hover(true)} onPointerOut={hover(false)}>
        <boxGeometry args={[front, WALL_HEIGHT, depth]} />
        <meshStandardMaterial color={theme.wall} />
      </mesh>
      {/* Mái phẳng: viền màu thương hiệu, lòng mái màu kem, cục điều hòa. */}
      <Box size={[front + 0.6, 0.3, depth + 0.6]} position={[0, base + WALL_HEIGHT + 0.15, 0]} color={theme.roof} shadows={shadows} />
      <Box size={[front - 0.2, 0.06, depth - 0.2]} position={[0, base + WALL_HEIGHT + 0.32, 0]} color={theme.trim} />
      <Box size={[1.1, 0.5, 0.8]} position={[front / 2 - 1.2, base + WALL_HEIGHT + 0.58, -depth / 2 + 1.1]} color={theme.white} shadows={shadows} />
      {/* Dải trạng thái dưới mái ở mặt tiền. */}
      <Box size={[front + 0.02, 0.26, 0.1]} position={[0, base + WALL_HEIGHT - 0.2, faceZ + 0.05]} color={active ? accent : theme.trim} emissive={active ? 0.35 : 0} />

      {/* Cửa: khung màu thương hiệu, cánh cửa đậm hơn, bậc thềm, biển tên vàng đồng phía trên. */}
      <Box size={[1.8, 2.35, 0.14]} position={[0, base + 1.17, faceZ + 0.07]} color={theme.roof} />
      <Box size={[1.36, 2.05, 0.18]} position={[0, base + 1.02, faceZ + 0.07]} color={theme.door} />
      <Box size={[2.2, 0.12, 0.7]} position={[0, PAVEMENT + 0.06, faceZ + 0.4]} color={theme.trim} />
      <Box size={[2, 0.42, 0.08]} position={[0, base + 2.66, faceZ + 0.06]} color={theme.gold} />
      {frontWindows.map((x) => (
        <Box key={x} size={[1.25, 1.15, 0.08]} position={[x, base + 1.75, faceZ + 0.04]} color={theme.glass} />
      ))}
      {[-1, 1].flatMap((side) =>
        [-1.5, 1.5].map((z) => (
          <Box key={`${side}|${z}`} size={[0.08, 1.15, 1.25]} position={[side * (front / 2 + 0.04), base + 1.75, z]} color={theme.glass} />
        )),
      )}

      {/* Đèn báo trên mái: phòng đang học hoặc sắp học. */}
      {active && (
        <mesh position={[0, ROOM_TOP + 0.75, 0]} rotation-y={Math.PI / 4}>
          <octahedronGeometry args={[0.38, 0]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.5} flatShading />
        </mesh>
      )}
    </group>
  );
}

/** Nạp ảnh logo làm vân bề mặt (ảnh cùng nguồn của ứng dụng); xong thì vẽ lại một khung hình. */
function useLogoTexture(url: string) {
  const invalidate = useThree((state) => state.invalidate);
  const [texture, setTexture] = useState<Texture | null>(null);
  useEffect(() => {
    let alive = true;
    const loading = new TextureLoader().load(url, (loaded) => {
      loaded.colorSpace = SRGBColorSpace;
      loaded.anisotropy = 8;
      if (!alive) return;
      setTexture(loaded);
      invalidate();
    });
    return () => {
      alive = false;
      loading.dispose();
    };
  }, [url, invalidate]);
  return texture;
}

/**
 * Tòa nhà chính của trung tâm ở góc tây bắc: hai tầng, sảnh kính có mái đón, và biển hiệu mang logo HAXI STEM thật
 * dựng trên mái, quay về hướng đông nam (hướng nhìn mặc định).
 */
export function MainBuilding({
  place,
  logoUrl,
  logoAspect,
  theme,
  shadows,
}: {
  place: Rect;
  logoUrl: string;
  /** Tỉ lệ rộng/cao của ảnh logo. */
  logoAspect: number;
  theme: SceneTheme;
  shadows: boolean;
}) {
  const logo = useLogoTexture(logoUrl);
  const base = PAVEMENT + 0.25;
  const lower = 4.2;
  const upper = 3.2;
  const faceZ = MAIN_DEPTH / 2;
  const signHeight = 3.9;
  const signWidth = signHeight * logoAspect + 0.5;
  const windows = [-4.1, -2.75, 2.75, 4.1];
  return (
    <group position={[place.x, 0, place.z]}>
      <Box size={[MAIN_WIDTH + 0.4, 0.25, MAIN_DEPTH + 0.4]} position={[0, PAVEMENT + 0.125, 0]} color={theme.trim} shadows={shadows} />
      <Box size={[MAIN_WIDTH, lower, MAIN_DEPTH]} position={[0, base + lower / 2, 0]} color={theme.wall} shadows={shadows} />
      <Box size={[MAIN_WIDTH + 0.6, 0.3, MAIN_DEPTH + 0.6]} position={[0, base + lower + 0.15, 0]} color={theme.roof} shadows={shadows} />
      <Box size={[MAIN_WIDTH - 0.2, 0.06, MAIN_DEPTH - 0.2]} position={[0, base + lower + 0.32, 0]} color={theme.trim} />
      {/* Tầng hai lùi về phía tây bắc. */}
      <Box size={[6.4, upper, 5]} position={[-1.9, base + lower + 0.3 + upper / 2, -1]} color={theme.wall} shadows={shadows} />
      <Box size={[7, 0.3, 5.6]} position={[-1.9, base + lower + 0.3 + upper + 0.15, -1]} color={theme.roof} shadows={shadows} />
      <Box size={[4.6, 1, 0.08]} position={[-1.9, base + lower + 0.3 + upper / 2 + 0.1, 1.54]} color={theme.glass} />
      <Box size={[0.08, 1, 3.4]} position={[1.34, base + lower + 0.3 + upper / 2 + 0.1, -1]} color={theme.glass} />

      {/* Sảnh kính, mái đón và bậc thềm. */}
      <Box size={[3.4, 2.9, 0.14]} position={[0, base + 1.45, faceZ + 0.07]} color={theme.roof} />
      <Box size={[3, 2.6, 0.18]} position={[0, base + 1.3, faceZ + 0.07]} color={theme.glass} />
      <Box size={[0.1, 2.6, 0.2]} position={[0, base + 1.3, faceZ + 0.08]} color={theme.roof} />
      <Box size={[4.2, 0.22, 1.7]} position={[0, base + 3.05, faceZ + 0.85]} color={theme.roof} shadows={shadows} />
      {[-1.9, 1.9].map((x) => (
        <Box key={x} size={[0.16, 3.05, 0.16]} position={[x, base + 1.52, faceZ + 1.55]} color={theme.gold} shadows={shadows} />
      ))}
      <Box size={[4.4, 0.14, 2]} position={[0, PAVEMENT + 0.07, faceZ + 1]} color={theme.trim} />
      {windows.map((x) => (
        <Box key={x} size={[1, 1.6, 0.08]} position={[x, base + 2.1, faceZ + 0.04]} color={theme.glass} />
      ))}
      {[-2.2, 0, 2.2].map((z) => (
        <Box key={z} size={[0.08, 1.6, 1.3]} position={[MAIN_WIDTH / 2 + 0.04, base + 2.1, z]} color={theme.glass} />
      ))}

      {/* Biển hiệu trên mái tầng hai, quay về đông nam. */}
      <group position={[-0.3, base + lower + 0.3 + upper + 0.3, 0.4]} rotation-y={Math.PI / 4}>
        {[-signWidth / 2 + 0.3, signWidth / 2 - 0.3].map((x) => (
          <Box key={x} size={[0.16, 0.7, 0.16]} position={[x, 0.35, 0]} color={theme.ink} shadows={shadows} />
        ))}
        <Box size={[signWidth + 0.24, signHeight + 0.5, 0.16]} position={[0, 0.7 + (signHeight + 0.5) / 2, 0]} color={theme.gold} shadows={shadows} />
        <Box size={[signWidth, signHeight + 0.26, 0.2]} position={[0, 0.7 + (signHeight + 0.5) / 2, 0]} color={theme.white} />
        {logo && (
          <mesh position={[0, 0.7 + (signHeight + 0.5) / 2, 0.11]}>
            <planeGeometry args={[signHeight * logoAspect, signHeight]} />
            <meshBasicMaterial map={logo} transparent toneMapped={false} />
          </mesh>
        )}
      </group>
    </group>
  );
}
