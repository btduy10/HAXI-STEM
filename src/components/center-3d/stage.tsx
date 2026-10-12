"use client";

import dynamic from "next/dynamic";
import { Component, type ReactNode, useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { type CenterData, type CenterSession, ROOM_STATE_LABELS, dayProgress, layoutCampus, roomStatus } from "@/domain/center-3d";
import { timeNow } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SceneApi, SceneInsets } from "./center-scene";
import { CameraButtons, Kpis, ListsPanel, ProgressPanel, type RoomRow, RoomPanel, type StageClass, type StageKpi } from "./panels";
import { type OverdueItem, type SearchResult, TopBar } from "./top-bar";

// Thư viện 3D chỉ được tải khi cảnh thật sự được gắn (màn hình từ 768px), không dựng trên máy chủ.
const CenterScene = dynamic(() => import("./center-scene").then((module) => module.CenterScene), { ssr: false });

/** Màn hình chờ của cảnh: logo và một dòng trạng thái, phủ lên khung cảnh cho tới khi khung hình đầu tiên sẵn sàng. */
function SceneCover({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="absolute inset-0 z-10 grid place-items-center bg-scene-bg p-6 text-center">
      <div className="grid justify-items-center gap-3">
        <BrandLogo height={72} />
        <p className="text-sm text-ink-soft">{children}</p>
      </div>
    </div>
  );
}

/** Máy hoặc trình duyệt không tạo được WebGL: báo ngắn gọn; các thẻ số liệu và danh sách vẫn dùng được. */
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <SceneCover>Máy hoặc trình duyệt này không hiển thị được đồ họa 3D. Số liệu và danh sách bên cạnh vẫn dùng được.</SceneCover>;
  }
}

function useMedia(query: string) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );
  // Máy chủ và lúc hydrate coi như màn hình hẹp: cảnh 3D chỉ được gắn sau khi trình duyệt xác nhận đủ rộng.
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
// Đồng hồ: trạng thái phòng và tiến trình đổi theo giờ hiện tại, kiểm tra lại mỗi 20 giây.
function subscribeClock(onChange: () => void) {
  const timer = window.setInterval(onChange, 20_000);
  return () => window.clearInterval(timer);
}

/** Bỏ dấu tiếng Việt và viết thường, để tìm "robotics co ban" vẫn ra "Robotics Cơ bản". */
const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase();

// Phần cảnh bị thẻ che ở bố cục đầy đủ (từ 1280px): thanh trên cùng hàng thẻ KPI, và cột thẻ bên phải.
const WIDE_INSETS: SceneInsets = { top: 164, right: 344, bottom: 0, left: 0 };
// Bố cục 768–1279px: hàng thẻ KPI ở trên và cột nút camera bên phải nổi trên cảnh.
const COMPACT_INSETS: SceneInsets = { top: 104, right: 60, bottom: 0, left: 0 };

export type StageData = {
  center: CenterData;
  kpis: StageKpi[];
  /** Các buổi quá hạn chưa điểm danh (đã giới hạn số dòng gửi xuống) và tổng số. */
  overdue: OverdueItem[];
  overdueTotal: number;
  overdueHref: string | null;
  classes: StageClass[];
  classesLabel: string;
  classesEmpty: string;
  user: { name: string; role: string };
};

/**
 * Trang Tổng quan kiểu dashboard 3D isometric: cảnh 3D của trung tâm làm nền, các thẻ trắng nổi lên trên (thanh trên, KPI,
 * chi tiết phòng, tiến trình, danh sách có tab) và cột nút điều khiển góc nhìn.
 * - Từ 1280px: mọi thẻ nổi trên cảnh, cảnh chiếm trọn màn hình.
 * - 768–1279px: cảnh ở trên (KPI và nút camera nổi), các thẻ còn lại xếp bên dưới.
 * - Dưới 768px: một cột, không dựng cảnh và không tải thư viện 3D.
 * `children`: phần số liệu bên dưới (biểu đồ).
 */
export function Stage({ data, children }: { data: StageData; children?: ReactNode }) {
  const { center } = data;
  const hasScene = useMedia("(min-width: 768px)");
  const floating = useMedia("(min-width: 1280px)");
  const now = useSyncExternalStore(
    subscribeClock,
    () => timeNow(),
    () => center.now,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [ready, setReady] = useState(false);
  const api = useRef<SceneApi | null>(null);

  const campus = useMemo(() => layoutCampus(center.rooms), [center.rooms]);
  const sessionsOf = useMemo(() => {
    const map = new Map<string, CenterSession[]>();
    for (const session of center.sessions) {
      if (!session.roomId) continue;
      map.set(session.roomId, [...(map.get(session.roomId) ?? []), session]);
    }
    return map;
  }, [center.sessions]);
  const rooms = useMemo<RoomRow[]>(
    () => center.rooms.map((room) => ({ room, ...roomStatus(sessionsOf.get(room.id) ?? [], now) })),
    [center.rooms, sessionsOf, now],
  );
  const roomNames = useMemo(() => new Map(center.rooms.map((room) => [room.id, room.name])), [center.rooms]);
  const roomNameOf = (roomId: string | null) => (roomId ? (roomNames.get(roomId) ?? null) : null);
  const unplaced = center.sessions.filter((session) => !session.roomId || !roomNames.has(session.roomId));
  const ordered = useMemo(
    () => [...center.sessions].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.className.localeCompare(b.className, "vi")),
    [center.sessions],
  );
  const live = ordered.filter((session) => !session.cancelled && session.startTime <= now && now < session.endTime);
  const progress = dayProgress(center.sessions, now);

  // Tìm kiếm: phòng theo tên; buổi hôm nay theo tên lớp hoặc giáo viên (chọn kết quả là chọn phòng của buổi đó).
  const needle = fold(query.trim());
  const results: SearchResult[] =
    needle === ""
      ? []
      : [
          ...rooms
            .filter(({ room }) => fold(room.name).includes(needle))
            .map(({ room, state }) => ({ key: `room|${room.id}`, roomId: room.id, title: room.name, detail: `Phòng · ${ROOM_STATE_LABELS[state]}` })),
          ...ordered
            .filter((session) => session.roomId && roomNames.has(session.roomId) && fold(`${session.className} ${session.teacherName ?? ""}`).includes(needle))
            .map((session) => ({
              key: `session|${session.id}`,
              roomId: session.roomId!,
              title: session.className,
              detail: [`${session.startTime}–${session.endTime}`, roomNameOf(session.roomId), session.teacherName].filter(Boolean).join(" · "),
            })),
        ].slice(0, 8);
  const pick = (result: SearchResult) => {
    setSelectedId(result.roomId);
    setQuery("");
  };

  return (
    <div className="stage-surface bg-scene-bg">
      <h1 className="sr-only">Tổng quan trung tâm</h1>
      <div className="grid gap-3 p-3 xl:relative xl:block xl:h-dvh xl:min-h-[44rem] xl:overflow-hidden xl:p-0">
        <TopBar
          className="relative z-30 xl:absolute xl:inset-x-3 xl:top-3"
          now={now}
          user={data.user}
          query={query}
          onQuery={setQuery}
          results={results}
          onPick={pick}
          overdue={data.overdue}
          overdueTotal={data.overdueTotal}
          overdueHref={data.overdueHref}
        />
        <Kpis items={data.kpis} className="md:hidden" />

        <div
          data-center-scene
          className="relative hidden h-[60dvh] min-h-[26rem] overflow-hidden rounded-3xl border bg-scene-bg md:block xl:absolute xl:inset-0 xl:h-auto xl:min-h-0 xl:rounded-none xl:border-0"
        >
          {hasScene && (
            <SceneBoundary>
              <CenterScene
                campus={campus}
                rooms={rooms}
                selectedId={selectedId}
                onSelect={setSelectedId}
                insets={floating ? WIDE_INSETS : COMPACT_INSETS}
                apiRef={api}
                onReady={() => setReady(true)}
              />
              {!ready && <SceneCover>Đang dựng trung tâm 3D…</SceneCover>}
            </SceneBoundary>
          )}
          <Kpis items={data.kpis} className="absolute top-3 left-3 z-20 xl:top-[4.75rem]" />
          <CameraButtons api={api} disabled={!ready} className="absolute top-1/2 right-3 z-20 -translate-y-1/2 xl:right-[21.75rem]" />
          <p className="pointer-events-none absolute bottom-3 left-1/2 z-20 hidden -translate-x-1/2 rounded-full bg-card/85 px-3 py-1 text-xs whitespace-nowrap text-ink-soft shadow-panel 2xl:block">
            Kéo để xoay · lăn chuột để phóng to, thu nhỏ · chuột phải để di chuyển · mặt bằng minh họa, không phải mặt bằng thật
          </p>
        </div>

        <div className={cn("grid gap-3 md:grid-cols-2 xl:contents")}>
          <RoomPanel
            className="md:max-h-[32rem] xl:absolute xl:top-[4.75rem] xl:right-3 xl:bottom-[17.75rem] xl:z-20 xl:max-h-none xl:w-80"
            today={center.today}
            now={now}
            rooms={rooms}
            sessionsOf={sessionsOf}
            unplaced={unplaced}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
          <ListsPanel
            className="md:max-h-[32rem] xl:absolute xl:right-3 xl:bottom-3 xl:z-20 xl:h-[16.75rem] xl:max-h-none xl:w-80"
            now={now}
            sessions={ordered}
            roomNameOf={roomNameOf}
            overdue={data.overdue}
            overdueTotal={data.overdueTotal}
            overdueHref={data.overdueHref}
            classes={data.classes}
            classesLabel={data.classesLabel}
            classesEmpty={data.classesEmpty}
          />
          <ProgressPanel
            className="md:col-span-2 xl:absolute xl:bottom-3 xl:left-3 xl:z-20 xl:w-80"
            progress={progress}
            live={live}
            now={now}
            roomNameOf={roomNameOf}
          />
        </div>
      </div>
      {children && <div className="grid gap-4 p-3 xl:p-4">{children}</div>}
    </div>
  );
}
