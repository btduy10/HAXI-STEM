"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Component, type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { type CenterData, type CenterRoom, type CenterSession, ROOM_STATE_LABELS, dayProgress, layoutCampus, roomStatus, sessionSteps } from "@/domain/center-3d";
import { timeNow } from "@/lib/format";
import { cn } from "@/lib/utils";
import { centerSearchAction, centerSessionAction, centerStudentAction, centerTeacherAction } from "@/server/actions/center";
import type { SceneApi, SceneFlight, SceneInsets, SceneMarker } from "./center-scene";
import { DetailPanel, type Person, type RoomRow, type StagePerms, type WorkspaceTab } from "./detail-panels";
import { CameraButtons, Kpis, ListsPanel, ProgressPanel, type StageKpi, type TeacherRow } from "./panels";
import { SessionWorkspace } from "./session-workspace";
import { type OverdueItem, type SearchResult, TopBar } from "./top-bar";
import { useDebounced, useRemote } from "./use-remote";

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
/** Nhịp tự làm mới dữ liệu của trang khi tab đang hiển thị. */
const REFRESH_MS = 30_000;

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
  user: { name: string; role: string };
  /** Quyền của người dùng (tính ở máy chủ): ẩn nút và không gọi phần chắc chắn bị từ chối. Máy chủ vẫn kiểm tra ở từng hàm. */
  perms: StagePerms;
  /** Tiền tố trang hồ sơ học viên của khu vực hiện tại, vd. "/admin/students". */
  studentBase: string;
};

/**
 * Trang Tổng quan kiểu dashboard 3D isometric: cảnh 3D của trung tâm làm nền, các thẻ trắng nổi lên trên (thanh trên, KPI,
 * chi tiết, tiến trình, danh sách có tab) và cột nút điều khiển góc nhìn. Chọn một phòng, lớp, giáo viên hay học viên ở cảnh,
 * ở danh sách hoặc qua tìm kiếm thì máy quay bay tới và thẻ chi tiết đổi theo; chi tiết chỉ tải lúc đó. Dữ liệu của trang tự
 * làm mới mỗi 30 giây.
 * - Từ 1280px: mọi thẻ nổi trên cảnh, cảnh chiếm trọn màn hình.
 * - 768–1279px: cảnh ở trên (KPI và nút camera nổi), các thẻ còn lại xếp bên dưới.
 * - Dưới 768px: một cột, không dựng cảnh và không tải thư viện 3D.
 * `children`: phần số liệu bên dưới (biểu đồ).
 */
export function Stage({ data, children }: { data: StageData; children?: ReactNode }) {
  const { center, perms } = data;
  const router = useRouter();
  const hasScene = useMedia("(min-width: 768px)");
  const floating = useMedia("(min-width: 1280px)");
  const now = useSyncExternalStore(
    subscribeClock,
    () => timeNow(),
    () => center.now,
  );
  const [roomId, setRoomId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [person, setPerson] = useState<Person | null>(null);
  const [flight, setFlight] = useState<SceneFlight | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceTab | null>(null);
  const [tick, setTick] = useState(0);
  const [query, setQuery] = useState("");
  const [ready, setReady] = useState(false);
  const api = useRef<SceneApi | null>(null);

  // Tự làm mới: chạy lại trang trên máy chủ (đủ kiểm tra phiên và quyền) và tải lại chi tiết đang mở.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      router.refresh();
      setTick((value) => value + 1);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [router]);

  // Dấu của dữ liệu trang: đổi là có dữ liệu mới (chip "Live" nháy, chi tiết đang mở tải lại).
  const stamp = useMemo(() => JSON.stringify([center.rooms, center.sessions, data.kpis, data.overdueTotal]), [center.rooms, center.sessions, data.kpis, data.overdueTotal]);
  const version = `${tick}|${stamp}`;
  // Mặt bằng chỉ xếp lại khi danh sách phòng thật sự đổi (mỗi lần làm mới trang đều trả về mảng mới).
  const roomsKey = JSON.stringify(center.rooms);
  const campus = useMemo(() => layoutCampus(JSON.parse(roomsKey) as CenterRoom[]), [roomsKey]);

  const sessionsOf = useMemo(() => {
    const map = new Map<string, CenterSession[]>();
    for (const item of center.sessions) {
      if (!item.roomId) continue;
      map.set(item.roomId, [...(map.get(item.roomId) ?? []), item]);
    }
    return map;
  }, [center.sessions]);
  const rooms = useMemo<RoomRow[]>(
    () => center.rooms.map((room) => ({ room, ...roomStatus(sessionsOf.get(room.id) ?? [], now) })),
    [center.rooms, sessionsOf, now],
  );
  const roomNames = useMemo(() => new Map(center.rooms.map((room) => [room.id, room.name])), [center.rooms]);
  const roomNameOf = (id: string | null) => (id ? (roomNames.get(id) ?? null) : null);
  const placedRoom = (item: CenterSession) => (item.roomId && roomNames.has(item.roomId) ? item.roomId : null);
  const unplaced = center.sessions.filter((item) => !placedRoom(item));
  const ordered = useMemo(
    () => [...center.sessions].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.className.localeCompare(b.className, "vi")),
    [center.sessions],
  );
  const live = ordered.filter((item) => !item.cancelled && item.startTime <= now && now < item.endTime);
  const progress = dayProgress(center.sessions, now);
  const todayIds = useMemo(() => new Set(center.sessions.map((item) => item.id)), [center.sessions]);
  // Giáo viên đứng lớp hôm nay (người thực dạy của các buổi không bị hủy).
  const teachers = useMemo<TeacherRow[]>(() => {
    const map = new Map<string, TeacherRow>();
    for (const item of ordered) {
      if (item.cancelled || !item.teacherId || !item.teacherName) continue;
      const row = map.get(item.teacherId) ?? { id: item.teacherId, name: item.teacherName, total: 0, done: 0, live: false };
      row.total += 1;
      if (item.endTime <= now) row.done += 1;
      else if (item.startTime <= now) row.live = true;
      map.set(item.teacherId, row);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "vi"));
  }, [ordered, now]);

  // Đối tượng đang chọn; buổi hay phòng không còn trong dữ liệu (sau khi làm mới) thì coi như chưa chọn.
  const session = sessionId ? (center.sessions.find((item) => item.id === sessionId) ?? null) : null;
  const room = roomId ? (rooms.find((row) => row.room.id === roomId) ?? null) : null;
  const sessionKey = session && !session.timetableOnly && perms.attendance ? session.id : null;
  const sessionDetail = useRemote(sessionKey, () => centerSessionAction({ sessionId: sessionKey }), version);
  const studentKey = person?.kind === "student" ? person.id : null;
  const studentDetail = useRemote(studentKey, () => centerStudentAction({ studentId: studentKey }), version);
  const teacherKey = person?.kind === "teacher" ? person.id : null;
  const teacherDetail = useRemote(teacherKey, () => centerTeacherAction({ teacherId: teacherKey }), version);

  const flyTo = (target: string | null) => setFlight((current) => ({ roomId: target, nonce: (current?.nonce ?? 0) + 1 }));
  const selectRoom = (id: string | null) => {
    setPerson(null);
    setRoomId(id);
    // Chọn phòng là chọn luôn buổi đang ghi trên nhãn của phòng (đang học, sắp học, hoặc buổi cuối đã xong).
    setSessionId(id ? (rooms.find((row) => row.room.id === id)?.session?.id ?? null) : null);
    if (id) flyTo(id);
  };
  const selectSession = (id: string) => {
    const target = center.sessions.find((item) => item.id === id);
    if (!target) return;
    setPerson(null);
    setSessionId(id);
    setRoomId(placedRoom(target));
    flyTo(placedRoom(target));
  };
  const selectTeacher = (id: string, name: string) => {
    setPerson({ kind: "teacher", id, name });
    // Giữ buổi đang chọn nếu chính giáo viên này dạy; không thì bay tới buổi giáo viên đang dạy (hoặc buổi kế tiếp, hoặc buổi cuối hôm nay).
    const target = session?.teacherId === id ? session : roomStatus(center.sessions.filter((item) => item.teacherId === id), now).session;
    if (!target) return;
    setSessionId(target.id);
    setRoomId(placedRoom(target));
    flyTo(placedRoom(target));
  };
  const selectStudent = (id: string, name: string, viaSessionId?: string) => {
    setPerson({ kind: "student", id, name });
    const target = viaSessionId ? center.sessions.find((item) => item.id === viaSessionId) : session;
    if (!target) return;
    setSessionId(target.id);
    setRoomId(placedRoom(target));
    flyTo(placedRoom(target));
  };
  // Bấm một hình người trước cửa phòng trong cảnh 3D.
  const pickFigure = (id: string, kind: "teacher" | "student", index: number) => {
    const target = rooms.find((row) => row.room.id === id)?.session;
    if (!target) return;
    if (kind === "teacher") {
      if (target.teacherId && target.teacherName) selectTeacher(target.teacherId, target.teacherName);
      return;
    }
    // Hình học viên thứ i ứng với học viên thứ i của danh sách, khi danh sách của buổi đó đã tải; chưa thì mở lớp trước.
    const student = perms.students && sessionDetail.data?.id === target.id ? sessionDetail.data.students[index] : undefined;
    if (student) selectStudent(student.studentId, student.fullName, target.id);
    else selectSession(target.id);
  };

  // Hình người đang chọn trong cảnh: giáo viên của buổi đang chọn, hoặc học viên theo thứ tự trong danh sách của buổi.
  let marker: SceneMarker | null = null;
  if (person && session && room && room.session?.id === session.id) {
    if (person.kind === "teacher" && session.teacherId === person.id) marker = { roomId: room.room.id, kind: "teacher", index: 0, label: person.name };
    const index = person.kind === "student" ? (sessionDetail.data?.students.findIndex((item) => item.studentId === person.id) ?? -1) : -1;
    if (index >= 0) marker = { roomId: room.room.id, kind: "student", index, label: person.name };
  }

  // Tìm kiếm: phòng, lớp, giáo viên lọc ngay trên dữ liệu hôm nay; học viên do máy chủ tìm (theo quyền) sau khi ngừng gõ.
  const needle = fold(query.trim());
  const settled = useDebounced(query.trim(), 300);
  const searchKey = perms.students && settled.length >= 2 ? settled : null;
  const studentHits = useRemote(searchKey, () => centerSearchAction({ query: searchKey }));
  const waiting = perms.students && query.trim().length >= 2 && (settled !== query.trim() || studentHits.loading);
  const picks = new Map<string, () => void>();
  const results: SearchResult[] = [];
  if (needle !== "") {
    const add = (key: string, title: string, detail: string, run: () => void) => {
      picks.set(key, run);
      results.push({ key, title, detail });
    };
    for (const { room: item, state } of rooms) {
      if (fold(item.name).includes(needle)) add(`room|${item.id}`, item.name, `Phòng · ${ROOM_STATE_LABELS[state]}`, () => selectRoom(item.id));
    }
    for (const item of ordered) {
      if (!fold(item.className).includes(needle)) continue;
      const detail = ["Lớp", `${item.startTime}–${item.endTime}`, roomNameOf(item.roomId), item.teacherName].filter(Boolean).join(" · ");
      add(`session|${item.id}`, item.className, detail, () => selectSession(item.id));
    }
    for (const item of teachers) {
      if (fold(item.name).includes(needle)) add(`teacher|${item.id}`, item.name, `Giáo viên · ${item.total} buổi hôm nay`, () => selectTeacher(item.id, item.name));
    }
    results.splice(8);
    if (!waiting) {
      for (const hit of studentHits.data ?? []) {
        // Bay tới buổi hôm nay của lớp em đang học (nếu có); không có thì chỉ mở thẻ học viên.
        const classIds = new Set(hit.classes.map((item) => item.id));
        const today = roomStatus(center.sessions.filter((item) => classIds.has(item.classId)), now).session;
        const detail = ["Học viên", hit.code, hit.classes.map((item) => item.name).join(", ")].filter(Boolean).join(" · ");
        add(`student|${hit.id}`, hit.fullName, detail, () => selectStudent(hit.id, hit.fullName, today?.id));
      }
    }
  }
  const pick = (result: SearchResult) => {
    picks.get(result.key)?.();
    setQuery("");
  };

  const steps = session
    ? sessionSteps({ ...session, attended: session.attendanceCount > 0, starred: session.starLogCount > 0 }, now, sessionDetail.data?.id === session.id ? sessionDetail.data.timeline : null)
    : null;

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
          searching={waiting}
          searchError={waiting ? null : studentHits.error}
          emptyText={perms.students ? "Không có phòng, lớp, giáo viên hay học viên nào khớp." : "Không có phòng, lớp hay giáo viên nào khớp trong hôm nay."}
          searchLabel={perms.students ? "Tìm phòng, lớp, giáo viên hoặc học viên" : "Tìm phòng, lớp hoặc giáo viên hôm nay"}
          searchPlaceholder={perms.students ? "Tìm phòng, lớp, giáo viên, học viên…" : "Tìm phòng, lớp, giáo viên…"}
          onPick={pick}
          pulse={stamp}
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
                selectedId={room?.room.id ?? null}
                onSelect={selectRoom}
                flight={flight}
                marker={marker}
                onPickFigure={pickFigure}
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
          <DetailPanel
            className="md:max-h-[32rem] xl:absolute xl:top-[4.75rem] xl:right-3 xl:bottom-[17.75rem] xl:z-20 xl:max-h-none xl:w-80"
            today={center.today}
            now={now}
            rooms={rooms}
            sessionsOf={sessionsOf}
            unplaced={unplaced}
            room={room}
            session={session}
            person={person}
            sessionDetail={sessionDetail}
            studentDetail={studentDetail}
            teacherDetail={teacherDetail}
            perms={perms}
            studentHref={(id) => `${data.studentBase}/${id}`}
            todayIds={todayIds}
            onRoom={selectRoom}
            onSession={selectSession}
            onTeacher={selectTeacher}
            onStudent={(id, name) => selectStudent(id, name)}
            onClosePerson={() => setPerson(null)}
            onWorkspace={setWorkspace}
          />
          <ListsPanel
            className="md:max-h-[32rem] xl:absolute xl:right-3 xl:bottom-3 xl:z-20 xl:h-[16.75rem] xl:max-h-none xl:w-80"
            now={now}
            sessions={ordered}
            teachers={teachers}
            roomNameOf={roomNameOf}
            selectedSessionId={session?.id ?? null}
            selectedPersonId={person?.id ?? null}
            selectedClassName={session?.className ?? null}
            roster={session && !session.timetableOnly ? sessionDetail : null}
            perms={perms}
            onSession={selectSession}
            onTeacher={selectTeacher}
            onStudent={(id, name) => selectStudent(id, name)}
          />
          <ProgressPanel
            className="md:col-span-2 xl:absolute xl:bottom-3 xl:left-3 xl:z-20 xl:w-80"
            progress={progress}
            live={live}
            now={now}
            roomNameOf={roomNameOf}
            selected={session && steps ? { session, steps } : null}
          />
        </div>
      </div>
      {children && <div className="grid gap-4 p-3 xl:p-4">{children}</div>}
      {workspace && session && (
        <SessionWorkspace
          sessionId={session.id}
          tab={workspace}
          version={version}
          onTab={setWorkspace}
          onClose={() => setWorkspace(null)}
          onChanged={() => {
            router.refresh();
            setTick((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}
