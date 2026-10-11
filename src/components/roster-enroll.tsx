"use client";

import { createContext, useContext, useState } from "react";
import { type Field, type FieldOption, FormDialog } from "@/components/form-dialog";
import { cn } from "@/lib/utils";
import { deleteEnrollmentAction, enrollNewStudentAction, enrollStudentAction, leaveEnrollmentAction } from "@/server/actions/admin";

type Target = { classId: string; classCode: string; startDate: string };
type Member = { enrollmentId: string; studentName: string; classCode: string };
type EnrollMode = "existing" | "new";
type ManageMode = "leave" | "delete";

const RosterContext = createContext<{ enroll: (target: Target) => void; manage: ((member: Member) => void) | null } | null>(null);

/** Các thẻ chọn kiểu thao tác, đặt phía trên form của hộp thoại. */
function Tabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
}: {
  label: string;
  tabs: { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <div role="tablist" aria-label={label} className="grid grid-cols-2 gap-1 rounded-xl border p-1">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={value === tab.key}
          onClick={() => onChange(tab.key)}
          className={cn(
            "min-h-10 rounded-lg px-1 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            value === tab.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-secondary-foreground",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Bọc quanh bảng tổng quan Ghi danh, giữ hai hộp thoại dùng chung cho mọi khung lớp:
 * - Hàng trống: ghi danh vào lớp, hoặc chọn học viên đã có trong QL Học viên, hoặc nhập học viên mới (mã tự cấp).
 * - Tên học viên: cho rời lớp, hoặc (Admin) xóa hẳn lượt ghi danh nhập sai.
 */
export function RosterEnroll({
  students,
  activeByClass,
  today,
  newStudentFields,
  canLeave,
  canDelete,
  children,
}: {
  /** Học viên có thể ghi danh (chưa nghỉ hẳn). */
  students: FieldOption[];
  /** Học viên đang học của từng lớp: không cho chọn lại. */
  activeByClass: Record<string, string[]>;
  today: string;
  /** Các ô của form học viên mới (theo quyền xem thông tin cá nhân của người dùng). */
  newStudentFields: Field[];
  /** Được cho học viên rời lớp (quyền Sửa của menu Ghi danh). */
  canLeave: boolean;
  /** Được xóa hẳn lượt ghi danh (Admin). */
  canDelete: boolean;
  children: React.ReactNode;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const [enrollMode, setEnrollMode] = useState<EnrollMode>("existing");
  const [member, setMember] = useState<Member | null>(null);
  const [manageMode, setManageMode] = useState<ManageMode>("leave");

  const taken = new Set(target ? activeByClass[target.classId] : []);
  const joinedAt: Field = { name: "joinedAt", label: "Ngày vào lớp", type: "date", required: true };
  function openManage(next: Member) {
    setManageMode(canLeave ? "leave" : "delete");
    setMember(next);
  }
  const manage = canLeave || canDelete ? openManage : null;

  return (
    <RosterContext.Provider value={{ enroll: setTarget, manage }}>
      {children}
      {target && (
        <FormDialog
          // Đổi thẻ thì dựng lại form với bộ ô nhập tương ứng.
          key={enrollMode}
          open
          onOpenChange={(open) => {
            if (open) return;
            setTarget(null);
            setEnrollMode("existing");
          }}
          title={`Ghi danh vào ${target.classCode}`}
          description={
            enrollMode === "existing"
              ? "Chọn học viên đã có trong QL Học viên; em đang học lớp này không nằm trong danh sách."
              : "Nhập thông tin học viên mới; mã học viên tự cấp và em được ghi danh ngay vào lớp này."
          }
          header={
            <Tabs
              label="Kiểu ghi danh"
              value={enrollMode}
              onChange={setEnrollMode}
              tabs={[
                { key: "existing", label: "Thêm học viên" },
                { key: "new", label: "Thêm học viên mới" },
              ]}
            />
          }
          fields={
            enrollMode === "existing"
              ? [{ name: "studentId", label: "Học viên", type: "select", required: true, options: students.filter((s) => !taken.has(s.value)) }, joinedAt]
              : [...newStudentFields, joinedAt]
          }
          initial={{ joinedAt: today < target.startDate ? target.startDate : today }}
          successMessage={(data) => {
            const code = enrollMode === "new" ? (data as { code?: string } | null)?.code : undefined;
            return code ? `Đã ghi danh. Mã HV: ${code}` : "Đã ghi danh.";
          }}
          onSubmit={(values) =>
            enrollMode === "existing" ? enrollStudentAction(target.classId, values) : enrollNewStudentAction({ ...values, classId: target.classId })
          }
        />
      )}
      {member && (
        <FormDialog
          key={manageMode}
          open
          onOpenChange={(open) => !open && setMember(null)}
          title={`${member.studentName} – ${member.classCode}`}
          description={
            manageMode === "leave"
              ? "Cho em rời lớp từ ngày chọn. Lịch sử điểm danh và sao trước ngày rời lớp được giữ nguyên."
              : `Xóa hẳn lượt ghi danh nhập sai của ${member.studentName} ở lớp ${member.classCode}. Điểm danh và lịch sử sao của em ở lớp này trong thời gian ghi danh cũng bị xóa. Không hoàn tác được.`
          }
          header={
            canLeave &&
            canDelete && (
              <Tabs
                label="Thao tác"
                value={manageMode}
                onChange={setManageMode}
                tabs={[
                  { key: "leave", label: "Cho rời lớp" },
                  { key: "delete", label: "Xóa khỏi lớp" },
                ]}
              />
            )
          }
          fields={manageMode === "leave" ? [{ name: "leftAt", label: "Ngày rời lớp", type: "date", required: true }] : []}
          initial={{ leftAt: today }}
          submitLabel={manageMode === "leave" ? "Cho rời lớp" : "Xóa khỏi lớp"}
          submitVariant={manageMode === "leave" ? "default" : "destructive"}
          successMessage={manageMode === "leave" ? "Đã cho rời lớp." : "Đã xóa khỏi lớp."}
          onSubmit={(values) =>
            manageMode === "leave" ? leaveEnrollmentAction({ id: member.enrollmentId, ...values }) : deleteEnrollmentAction({ id: member.enrollmentId })
          }
        />
      )}
    </RosterContext.Provider>
  );
}

/**
 * Hàng trống của một lớp: bấm để thêm học viên. `seat` = chỗ trống thứ mấy của lớp ("Thêm 1 học viên", "Thêm 2 học viên"…).
 * Không hiển thị nếu không nằm trong RosterEnroll.
 */
export function AddStudentButton({ label, seat, ...target }: Target & { label: string; seat: number }) {
  const roster = useContext(RosterContext);
  if (!roster) return null;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => roster.enroll(target)}
      className="flex h-8 w-full items-center rounded-md border border-dashed px-2 text-xs text-muted-foreground transition-colors md:h-6 hover:border-primary hover:bg-secondary hover:text-secondary-foreground focus-visible:border-primary focus-visible:outline-2"
    >
      Thêm {seat} học viên
    </button>
  );
}

/** Tên một học viên trong khung lớp: bấm để cho rời lớp hoặc xóa khỏi lớp; không có quyền thì chỉ là chữ. */
export function RosterStudent(member: Member) {
  const roster = useContext(RosterContext);
  if (!roster?.manage) return <>{member.studentName}</>;
  const manage = roster.manage;
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={() => manage(member)}
      className="block h-8 w-full truncate rounded text-left underline-offset-2 outline-none md:h-6 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {member.studentName}
    </button>
  );
}
