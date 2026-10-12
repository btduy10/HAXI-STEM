"use client";

import { Instance, Instances, RoundedBox } from "@react-three/drei";
import type { Rect } from "@/domain/center-3d";
import type { SceneTheme } from "./theme";

// Các vật thể của sân: cây, vạch đường, hình người, robot, sa bàn, hộp linh kiện. Vật lặp lại dùng InstancedMesh (drei Instances).

export type Spot = { x: number; z: number };
export type FigureSpot = Spot & { color: string; /** Chiều cao tới đỉnh đầu. */ height: number };

/** Cây low-poly: thân trụ và hai tầng tán hình nón. */
export function Trees({ spots, theme, shadows }: { spots: Spot[]; theme: SceneTheme; shadows: boolean }) {
  if (spots.length === 0) return null;
  return (
    <>
      <Instances limit={spots.length} castShadow={shadows}>
        <cylinderGeometry args={[0.13, 0.17, 0.9, 6]} />
        <meshStandardMaterial color={theme.trunk} />
        {spots.map((spot, index) => (
          <Instance key={index} position={[spot.x, 0.45, spot.z]} />
        ))}
      </Instances>
      <Instances limit={spots.length * 2} castShadow={shadows}>
        <coneGeometry args={[1, 1.9, 7]} />
        <meshStandardMaterial color={theme.tree} flatShading />
        {spots.flatMap((spot, index) => [
          <Instance key={`${index}-low`} position={[spot.x, 1.75, spot.z]} rotation={[0, index * 0.7, 0]} />,
          <Instance key={`${index}-top`} position={[spot.x, 2.75, spot.z]} scale={0.68} rotation={[0, index * 0.7 + 0.4, 0]} />,
        ])}
      </Instances>
    </>
  );
}

/** Vạch kẻ đứt giữa một con đường; đường dài theo trục nào thì vạch chạy theo trục đó. */
export function RoadDashes({ roads, theme }: { roads: Rect[]; theme: SceneTheme }) {
  const dashes = roads.flatMap((road) => {
    const alongX = road.width >= road.depth;
    const length = alongX ? road.width : road.depth;
    const count = Math.max(1, Math.floor((length - 2) / 2.6));
    return Array.from({ length: count }, (_, index) => {
      const offset = -length / 2 + 1.6 + index * 2.6;
      return { x: alongX ? road.x + offset : road.x, z: alongX ? road.z : road.z + offset, alongX };
    });
  });
  return (
    <Instances limit={dashes.length}>
      <boxGeometry args={[1.3, 0.02, 0.16]} />
      <meshStandardMaterial color={theme.roadLine} />
      {dashes.map((dash, index) => (
        <Instance key={index} position={[dash.x, 0.075, dash.z]} rotation={[0, dash.alongX ? 0 : Math.PI / 2, 0]} />
      ))}
    </Instances>
  );
}

/** Hình người low-poly (học viên, giáo viên): thân trụ bo tròn và đầu, mỗi người một màu áo. */
export function Figures({ spots, theme, shadows }: { spots: FigureSpot[]; theme: SceneTheme; shadows: boolean }) {
  if (spots.length === 0) return null;
  return (
    <>
      <Instances limit={spots.length} castShadow={shadows}>
        <capsuleGeometry args={[0.2, 0.5, 4, 10]} />
        <meshStandardMaterial />
        {spots.map((spot, index) => (
          <Instance key={index} position={[spot.x, 0.1 + spot.height * 0.36, spot.z]} scale={spot.height / 1.25} color={spot.color} />
        ))}
      </Instances>
      <Instances limit={spots.length} castShadow={shadows}>
        <sphereGeometry args={[0.19, 14, 10]} />
        <meshStandardMaterial color={theme.skin} />
        {spots.map((spot, index) => (
          <Instance key={index} position={[spot.x, 0.1 + spot.height * 0.84, spot.z]} scale={spot.height / 1.25} />
        ))}
      </Instances>
    </>
  );
}

/** Robot nhỏ: thân trắng, ngực và ăng-ten vàng đồng, mắt xanh ngọc. `turn`: góc quay quanh trục đứng. */
export function Robot({ x, z, turn = 0, theme, shadows }: Spot & { turn?: number; theme: SceneTheme; shadows: boolean }) {
  return (
    <group position={[x, 0.1, z]} rotation-y={turn} scale={1.55}>
      {[-0.2, 0.2].map((side) => (
        <mesh key={side} position={[side, 0.12, 0]} castShadow={shadows}>
          <boxGeometry args={[0.22, 0.24, 0.42]} />
          <meshStandardMaterial color={theme.ink} />
        </mesh>
      ))}
      <RoundedBox args={[0.78, 0.7, 0.56]} radius={0.1} position-y={0.6} castShadow={shadows}>
        <meshStandardMaterial color={theme.white} />
      </RoundedBox>
      <mesh position={[0, 0.6, 0.29]}>
        <boxGeometry args={[0.42, 0.3, 0.03]} />
        <meshStandardMaterial color={theme.gold} />
      </mesh>
      <RoundedBox args={[0.62, 0.46, 0.5]} radius={0.1} position-y={1.2} castShadow={shadows}>
        <meshStandardMaterial color={theme.white} />
      </RoundedBox>
      {[-0.14, 0.14].map((side) => (
        <mesh key={side} position={[side, 1.22, 0.26]}>
          <sphereGeometry args={[0.065, 10, 8]} />
          <meshStandardMaterial color={theme.teal} emissive={theme.teal} emissiveIntensity={0.5} />
        </mesh>
      ))}
      <mesh position-y={1.56}>
        <cylinderGeometry args={[0.02, 0.02, 0.26, 6]} />
        <meshStandardMaterial color={theme.ink} />
      </mesh>
      <mesh position-y={1.72}>
        <sphereGeometry args={[0.07, 10, 8]} />
        <meshStandardMaterial color={theme.gold} emissive={theme.gold} emissiveIntensity={0.4} />
      </mesh>
      {[-0.47, 0.47].map((side) => (
        <mesh key={side} position={[side, 0.62, 0]} castShadow={shadows}>
          <boxGeometry args={[0.14, 0.5, 0.2]} />
          <meshStandardMaterial color={theme.gold} />
        </mesh>
      ))}
    </group>
  );
}

/** Sa bàn thi đấu ở giữa sân: mặt bàn trắng viền xanh thương hiệu, vạch vàng đồng, hai robot mini. */
export function Arena({ x, z, theme, shadows }: Spot & { theme: SceneTheme; shadows: boolean }) {
  return (
    <group position={[x, 0.1, z]}>
      <mesh position-y={0.3} castShadow={shadows} receiveShadow>
        <boxGeometry args={[4.6, 0.6, 3.4]} />
        <meshStandardMaterial color={theme.roof} />
      </mesh>
      <mesh position-y={0.62} receiveShadow>
        <boxGeometry args={[4.2, 0.06, 3]} />
        <meshStandardMaterial color={theme.white} />
      </mesh>
      {/* Vạch sân: một đường giữa và hai ô xuất phát. */}
      <mesh position-y={0.66}>
        <boxGeometry args={[0.08, 0.01, 3]} />
        <meshStandardMaterial color={theme.gold} />
      </mesh>
      {[-1.5, 1.5].map((side) => (
        <mesh key={side} position={[side, 0.66, 0]}>
          <boxGeometry args={[0.9, 0.01, 0.9]} />
          <meshStandardMaterial color={theme.goldSoft} />
        </mesh>
      ))}
      {[
        { x: -1.5, color: theme.gold },
        { x: 1.5, color: theme.teal },
      ].map((bot) => (
        <group key={bot.x} position={[bot.x, 0.66, 0]}>
          <mesh position-y={0.16} castShadow={shadows}>
            <boxGeometry args={[0.46, 0.24, 0.56]} />
            <meshStandardMaterial color={bot.color} />
          </mesh>
          <mesh position-y={0.36}>
            <boxGeometry args={[0.3, 0.16, 0.3]} />
            <meshStandardMaterial color={theme.white} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Chồng hộp linh kiện (gỗ và vàng đồng) đặt cạnh sa bàn. */
export function Crates({ x, z, theme, shadows }: Spot & { theme: SceneTheme; shadows: boolean }) {
  const boxes = [
    { x: 0, y: 0.35, z: 0, color: theme.wood },
    { x: 0.78, y: 0.35, z: 0.1, color: theme.gold },
    { x: 0.35, y: 1.05, z: 0.05, color: theme.wood },
    { x: -0.2, y: 0.35, z: 0.82, color: theme.goldSoft },
    { x: 1.5, y: 0.25, z: 0.7, color: theme.wood },
  ];
  return (
    <group position={[x, 0.1, z]}>
      <Instances limit={boxes.length} castShadow={shadows} receiveShadow>
        <boxGeometry args={[0.7, 0.7, 0.7]} />
        <meshStandardMaterial />
        {boxes.map((box, index) => (
          <Instance key={index} position={[box.x, box.y, box.z]} scale={index === 4 ? 0.7 : 1} rotation={[0, index * 0.3, 0]} color={box.color} />
        ))}
      </Instances>
    </group>
  );
}
