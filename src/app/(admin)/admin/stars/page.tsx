import type { Metadata } from "next";
import Link from "next/link";
import { ConfirmButton } from "@/components/action-buttons";
import { CrudSection } from "@/components/crud-section";
import type { Field } from "@/components/form-dialog";
import { formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { paramText } from "@/lib/search-params";
import { createCriteriaAction, deleteCriteriaAction, undoStarAction, updateCriteriaAction } from "@/server/actions/stars";
import { listCriteria, listRecentStarLogs } from "@/server/services/stars";
import type { Actor } from "@/server/guard";
import { requireMenu } from "@/server/session";

export const metadata: Metadata = { title: "Sao" };

const TABS = [
  { key: "criteria", label: "Tiêu chí" },
  { key: "ledger", label: "Sổ cái" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const ACTIVE_OPTIONS = [
  { value: "true", label: "Đang dùng" },
  { value: "false", label: "Ngừng dùng" },
];

export default async function StarsAdminPage({ searchParams }: PageProps<"/admin/stars">) {
  const { actor, role, can } = await requireMenu("stars");
  // Tiêu chí sao chỉ Admin chỉnh. Vai trò khác xem được và dùng sổ cái theo quyền.
  const admin = role === "admin";
  const tabs = TABS;
  const requested = paramText((await searchParams).tab);
  const tab: TabKey = tabs.find((t) => t.key === requested)?.key ?? (admin ? "criteria" : "ledger");

  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold sm:text-2xl">Sao</h1>
      <nav aria-label="Mục" className="flex gap-1 overflow-x-auto glass-solid rounded-full border p-1 text-sm">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/admin/stars?tab=${t.key}`}
            aria-current={tab === t.key ? "page" : undefined}
            className={cn(
              "flex min-h-10 shrink-0 items-center rounded-full px-4 font-medium whitespace-nowrap transition-colors",
              tab === t.key ? "bg-brand-teal font-semibold text-foreground shadow-sm" : "hover:bg-muted",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === "criteria" && <CriteriaTab actor={actor} admin={admin} />}
      {tab === "ledger" && <LedgerTab actor={actor} canUndo={can("edit")} />}
    </div>
  );
}

type TabProps = { actor: Actor };

async function CriteriaTab({ actor, admin }: TabProps & { admin: boolean }) {
  const criteria = await listCriteria(actor, false);
  const fields: Field[] = [
    { name: "name", label: "Tên tiêu chí", required: true },
    { name: "stars", label: "Số sao", type: "number", required: true, hint: "Số dương = thưởng, số âm = trừ sao." },
    { name: "active", label: "Trạng thái", type: "select", required: true, options: ACTIVE_OPTIONS, defaultValue: "true" },
  ];
  return (
    <CrudSection
      title="Tiêu chí sao"
      columns={["Tiêu chí", "Số sao", "Loại", "Trạng thái"]}
      rows={criteria.map((c) => ({
        id: c.id,
        cells: [c.name, c.stars > 0 ? `+${c.stars}` : String(c.stars), c.type === "reward" ? "Thưởng" : "Trừ sao", c.active ? "Đang dùng" : "Ngừng dùng"],
        values: { name: c.name, stars: String(c.stars), active: String(c.active) },
      }))}
      fields={fields}
      createAction={admin ? createCriteriaAction : undefined}
      updateAction={admin ? updateCriteriaAction : undefined}
      deleteAction={admin ? deleteCriteriaAction : undefined}
    />
  );
}

async function LedgerTab({ actor, canUndo }: TabProps & { canUndo: boolean }) {
  const logs = await listRecentStarLogs(actor);
  return (
    <section className="grid gap-2">
      <p className="text-sm text-muted-foreground">
        Sổ cái chỉ thêm, không sửa hay xóa. Hoàn tác tạo một bản ghi đảo dấu. Hiển thị {logs.length} bản ghi gần nhất.
      </p>
      {logs.length === 0 ? (
        <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">Chưa có lần ghi sao nào.</p>
      ) : (
        <ul className="grid gap-1.5">
          {logs.map((log) => (
            <li key={log.id} className={cn("flex items-center gap-2 glass-solid rounded-xl border px-3 py-2 text-sm", log.reversed && "opacity-60")}>
              <span className={cn("w-9 shrink-0 font-semibold tabular-nums", log.stars > 0 ? "text-emerald-600" : "text-red-600")}>
                {log.stars > 0 ? `+${log.stars}` : log.stars}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("font-medium", log.reversed && "line-through")}>
                  {log.studentName} <span className="font-normal text-muted-foreground">{log.studentCode}</span>
                </span>
                <span className="block text-xs text-muted-foreground">
                  {log.isReversal ? "Hoàn tác: " : ""}
                  {log.criteriaName ?? "—"} · {log.classCode ?? ""} {log.sessionDate ? formatDate(log.sessionDate) : ""} · {log.recordedByName ?? "?"} ·{" "}
                  {formatDateTime(log.recordedAt)}
                </span>
              </span>
              {canUndo && !log.isReversal && !log.reversed && (
                <ConfirmButton
                  label="Hoàn tác"
                  className="h-9 shrink-0"
                  confirmText={`Hoàn tác ${log.stars > 0 ? "+" : ""}${log.stars} sao của ${log.studentName}?`}
                  action={undoStarAction}
                  input={{ logId: log.id }}
                  successMessage="Đã hoàn tác."
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
