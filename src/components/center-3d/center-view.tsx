"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Component, type ReactNode, useMemo, useState, useSyncExternalStore } from "react";
import { LinkButton } from "@/components/link-button";
import { Badge } from "@/components/ui/badge";
import { type CenterData, type CenterSession, ROOM_STATE_LABELS, type RoomState, layoutRooms, roomStatus } from "@/domain/center-3d";
import { formatDate, timeNow } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SceneRoom } from "./center-scene";
import { ROOM_COLORS } from "./palette";

// Thư viện 3D chỉ được tải khi cảnh thật sự được gắn (đã chọn Xem 3D và màn hình đủ rộng), không dựng trên máy chủ.
const CenterScene = dynamic(() => import("./center-scene").then((module) => module.CenterScene), {
  ssr: false,
  loading: () => <SceneMessage>Đang tải cảnh 3D…</SceneMessage>,
});

function SceneMessage({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

/** Máy hoặc trình duyệt không tạo được WebGL: báo ngắn gọn, bảng danh sách phòng bên cạnh vẫn dùng được. */
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <SceneMessage>Máy hoặc trình duyệt này không hiển thị được đồ họa 3D. Bạn vẫn xem được các phòng ở danh sách bên cạnh.</SceneMessage>;
  }
}

const WIDE = "(min-width: 1024px)";
function subscribeWide(onChange: () => void) {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
// Đồng hồ: trạng thái phòng đổi theo giờ hiện tại, kiểm tra lại mỗi 20 giây.
function subscribeClock(onChange: () => void) {
  const timer = window.setInterval(onChange, 20_000);
  return () => window.clearInterval(timer);
}

const STATE_ORDER: RoomState[] = ["live", "upcoming", "done", "idle"];

function SessionItem({ session, capacity, live }: { session: CenterSession; capacity: number | null; live: boolean }) {
  return (
    <li className="grid gap-1 rounded-xl border bg-background/60 p-2.5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold tabular-nums">
          {session.startTime}–{session.endTime}
        </span>
        {session.cancelled ? <Badge variant="outline">Đã hủy</Badge> : live && <Badge variant="secondary">Đang học</Badge>}
      </div>
      <span className="break-words">{session.className}</span>
      <span className="text-muted-foreground">
        {session.teacherName ? `GV: ${session.teacherName}` : "Chưa có giáo viên"}
        {session.studentCount !== null && ` · Sĩ số ${session.studentCount}${capacity === null ? "" : `/${capacity}`}`}
        {session.timetableOnly && " · Chỉ giữ phòng"}
      </span>
      {session.href && (
        <Link href={session.href} className="w-fit rounded font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2">
          Mở buổi học
        </Link>
      )}
    </li>
  );
}

/**
 * Giao diện 3D của trang Tổng quan: cảnh 3D các phòng học kèm bảng danh sách phòng và buổi hôm nay.
 * Chỉ dùng từ 1024px; màn hình hẹp hơn chỉ hiện lời nhắn và không tải thư viện 3D.
 */
export function CenterView({ data, backHref }: { data: CenterData; backHref: string }) {
  const wide = useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE).matches,
    () => false,
  );
  const now = useSyncExternalStore(
    subscribeClock,
    () => timeNow(),
    () => data.now,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const layout = useMemo(() => layoutRooms(data.rooms), [data.rooms]);
  const sessionsOf = useMemo(() => {
    const map = new Map<string, CenterSession[]>();
    for (const session of data.sessions) {
      if (!session.roomId) continue;
      map.set(session.roomId, [...(map.get(session.roomId) ?? []), session]);
    }
    return map;
  }, [data.sessions]);
  const rooms = useMemo<SceneRoom[]>(
    () =>
      data.rooms.map((room, index) => ({
        room,
        placement: layout.rooms[index]!,
        ...roomStatus(sessionsOf.get(room.id) ?? [], now),
      })),
    [data.rooms, layout, sessionsOf, now],
  );
  const known = new Set(data.rooms.map((room) => room.id));
  const unplaced = data.sessions.filter((session) => !session.roomId || !known.has(session.roomId));
  const selected = rooms.find((item) => item.room.id === selectedId) ?? null;
  const selectedSessions = selected
    ? [...(sessionsOf.get(selected.room.id) ?? [])].sort((a, b) => a.startTime.localeCompare(b.startTime))
    : [];
  const counts = STATE_ORDER.map((state) => ({ state, count: rooms.filter((item) => item.state === state).length }));

  return (
    <>
      <div className="grid gap-3 rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground lg:hidden">
        <p>Giao diện 3D dùng trên màn hình từ laptop trở lên.</p>
        <LinkButton href={backHref} variant="outline" className="mx-auto h-10">
          Giao diện thường
        </LinkButton>
      </div>

      <div className="hidden gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid content-start gap-2">
          <div
            data-center-scene
            // Khung luôn rộng ít nhất 16:10 (cảnh 3D tính khoảng cách máy quay theo tỉ lệ này).
            className="relative isolate aspect-[16/10] max-h-[calc(100dvh-17rem)] min-h-[22rem] w-full overflow-hidden rounded-3xl border bg-linear-to-b from-sky-100 to-emerald-50"
          >
            {wide &&
              (data.rooms.length === 0 ? (
                <SceneMessage>Chưa có phòng học nào. Thêm phòng ở Phòng &amp; Ca học để dựng cảnh 3D.</SceneMessage>
              ) : (
                <SceneBoundary>
                  <CenterScene rooms={rooms} length={layout.length} selectedId={selectedId} onSelect={setSelectedId} />
                </SceneBoundary>
              ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Kéo chuột để xoay · lăn chuột để phóng to, thu nhỏ · kéo chuột phải để di chuyển · bấm vào phòng để xem buổi học. Mặt bằng tự xếp
            theo danh sách phòng, không phải mặt bằng thật.
          </p>
        </div>

        <aside className="grid content-start gap-4" aria-label="Phòng học hôm nay">
          <div className="grid gap-1">
            <h2 className="font-medium">
              Phòng học hôm nay <span className="text-sm font-normal text-muted-foreground">({formatDate(data.today)})</span>
            </h2>
            <p className="text-sm text-muted-foreground tabular-nums">
              Bây giờ {now} ·{" "}
              {counts
                .filter((item) => item.count > 0)
                .map((item) => `${item.count} ${ROOM_STATE_LABELS[item.state].toLowerCase()}`)
                .join(", ")}
            </p>
          </div>

          <ul className="grid gap-1.5">
            {rooms.map(({ room, state, session }) => (
              <li key={room.id}>
                <button
                  type="button"
                  data-room={room.name}
                  data-state={state}
                  aria-pressed={room.id === selectedId}
                  onClick={() => setSelectedId(room.id === selectedId ? null : room.id)}
                  className={cn(
                    "flex min-h-11 w-full items-center gap-2.5 rounded-xl border px-3 py-2 text-left text-sm transition-colors outline-none hover:bg-secondary focus-visible:ring-3 focus-visible:ring-ring/50",
                    room.id === selectedId ? "border-foreground bg-secondary" : "glass-solid",
                  )}
                >
                  <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: ROOM_COLORS[state].accent }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{room.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {ROOM_STATE_LABELS[state]}
                      {session && state !== "done" && ` · ${session.startTime}–${session.endTime} · ${session.className}`}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{room.capacity} chỗ</span>
                </button>
              </li>
            ))}
          </ul>

          {selected && (
            <section className="grid gap-2" aria-live="polite">
              <h3 className="text-sm font-medium">
                {selected.room.name} <span className="font-normal text-muted-foreground">· buổi hôm nay</span>
              </h3>
              {selectedSessions.length === 0 ? (
                <p className="rounded-xl border border-dashed p-3 text-center text-sm text-muted-foreground">Hôm nay phòng không có buổi học.</p>
              ) : (
                <ul className="grid gap-1.5">
                  {selectedSessions.map((session) => (
                    <SessionItem
                      key={session.id}
                      session={session}
                      capacity={selected.room.capacity}
                      live={selected.state === "live" && selected.session?.id === session.id}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}

          {unplaced.length > 0 && (
            <section className="grid gap-2">
              <h3 className="text-sm font-medium">Buổi chưa xếp phòng</h3>
              <ul className="grid gap-1.5">
                {unplaced.map((session) => (
                  <SessionItem key={session.id} session={session} capacity={null} live={false} />
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
