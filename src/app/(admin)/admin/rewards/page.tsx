import type { Metadata } from "next";
import Link from "next/link";
import { ConfirmButton } from "@/components/action-buttons";
import { AutoSubmitSelect } from "@/components/auto-submit-select";
import { ClassReportTable, ExportLinks } from "@/components/class-report";
import { CrudSection } from "@/components/crud-section";
import type { Field } from "@/components/form-dialog";
import { RewardApproval } from "@/components/reward-approval";
import { Badge } from "@/components/ui/badge";
import { LABELS, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  closeClassAction,
  createGiftAction,
  createTierAction,
  deleteGiftAction,
  deleteTierAction,
  updateGiftAction,
} from "@/server/actions/rewards";
import type { Actor } from "@/server/guard";
import { listClasses } from "@/server/services/classes";
import { getClassReport, getClassSummary, listGifts, listTiers } from "@/server/services/summaries";
import { requireMenu } from "@/server/session";

export const metadata: Metadata = { title: "Quà tặng & Tổng kết" };

const TABS = [
  { key: "summary", label: "Tổng kết lớp" },
  { key: "tiers", label: "Mốc quà" },
  { key: "gifts", label: "Kho quà" },
] as const;
type TabKey = (typeof TABS)[number]["key"];
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function RewardsPage({ searchParams }: PageProps<"/admin/rewards">) {
  const { actor, role, can } = await requireMenu("rewards");
  // Thêm = quà, mốc quà; Sửa = sửa quà, đóng lớp, duyệt và trao quà; xóa chỉ Admin.
  const perm: Perm = { add: can("add"), edit: can("edit"), admin: role === "admin" };
  const params = await searchParams;
  const tab: TabKey = TABS.find((t) => t.key === one(params.tab))?.key ?? "summary";

  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold sm:text-2xl">Quà tặng & Tổng kết</h1>
      <nav aria-label="Mục" className="flex gap-1 overflow-x-auto glass-solid rounded-full border p-1 text-sm">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/admin/rewards?tab=${t.key}`}
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
      {tab === "summary" && <SummaryTab actor={actor} classId={one(params.classId)} perm={perm} />}
      {tab === "tiers" && <TiersTab actor={actor} perm={perm} />}
      {tab === "gifts" && <GiftsTab actor={actor} perm={perm} />}
    </div>
  );
}

type Perm = { add: boolean; edit: boolean; admin: boolean };

async function GiftsTab({ actor, perm }: { actor: Actor; perm: Perm }) {
  const gifts = await listGifts(actor);
  const fields: Field[] = [
    { name: "name", label: "Tên quà", required: true },
    { name: "stock", label: "Tồn kho", type: "number", required: true, defaultValue: "0" },
    { name: "description", label: "Mô tả", type: "textarea" },
  ];
  return (
    <CrudSection
      title="Quà tặng"
      columns={["Tên quà", "Tồn kho", "Mô tả"]}
      rows={gifts.map((g) => ({
        id: g.id,
        cells: [g.name, String(g.stock), g.description ?? ""],
        values: { name: g.name, stock: String(g.stock), description: g.description ?? "" },
      }))}
      fields={fields}
      createAction={perm.add ? createGiftAction : undefined}
      updateAction={perm.edit ? updateGiftAction : undefined}
      deleteAction={perm.admin ? deleteGiftAction : undefined}
    />
  );
}

async function TiersTab({ actor, perm }: { actor: Actor; perm: Perm }) {
  const [tiers, gifts, classes] = await Promise.all([listTiers(actor), listGifts(actor), listClasses(actor)]);
  const fields: Field[] = [
    {
      name: "classId",
      label: "Lớp",
      type: "select",
      required: true,
      options: classes.map((c) => ({ value: c.id, label: `${c.code} – ${c.name}` })),
    },
    { name: "minStars", label: "Từ số sao của khóa", type: "number", required: true },
    { name: "giftId", label: "Quà", type: "select", required: true, options: gifts.map((g) => ({ value: g.id, label: g.name })) },
  ];
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        Học viên nhận quà của mốc cao nhất mà tổng sao trong khóa đạt tới (mỗi em một quà).
      </p>
      <CrudSection
        title="Mốc quà"
        columns={["Lớp", "Từ số sao", "Quà"]}
        rows={tiers.map((t) => ({
          id: t.id,
          cells: [`${t.classCode} – ${t.className}`, String(t.minStars), t.giftName],
          values: {},
        }))}
        fields={fields}
        createAction={perm.add ? createTierAction : undefined}
        deleteAction={perm.admin ? deleteTierAction : undefined}
        emptyText="Chưa có mốc quà."
      />
    </div>
  );
}

async function SummaryTab({ actor, classId, perm }: { actor: Actor; classId: string; perm: Perm }) {
  const classes = await listClasses(actor);
  // Chỉ nhận classId có trong danh sách lớp.
  const current = classes.find((c) => c.id === classId) ?? null;

  return (
    <div className="grid gap-4">
      <form>
        <input type="hidden" name="tab" value="summary" />
        <label className="grid gap-1.5 text-sm font-medium sm:w-1/2">
          Lớp học
          <AutoSubmitSelect name="classId" defaultValue={current?.id ?? ""}>
            <option value="">— Chọn lớp —</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} – {c.name} ({LABELS.classStatus[c.status]})
              </option>
            ))}
          </AutoSubmitSelect>
        </label>
      </form>
      {current?.status === "open" && <OpenClassPreview actor={actor} classId={current.id} code={current.code} canClose={perm.edit} />}
      {current?.status === "closed" && <ClosedClassSummary actor={actor} classId={current.id} canEdit={perm.edit} />}
    </div>
  );
}

async function OpenClassPreview({ actor, classId, code, canClose }: { actor: Actor; classId: string; code: string; canClose: boolean }) {
  const report = await getClassReport(actor, classId);
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">Số liệu tạm tính (lớp đang mở)</h2>
        {canClose && <ConfirmButton
          label="Đóng lớp & chốt tổng kết"
          variant="default"
          confirmText={`Đóng lớp ${code} và chốt tổng kết?\n\nSau khi đóng: không điểm danh, ghi sao hay ghi danh thêm cho lớp này; các buổi tương lai còn lại sẽ bị hủy. Thao tác này không hoàn tác được.`}
          action={closeClassAction}
          input={{ classId }}
          successMessage="Đã đóng lớp và chốt tổng kết."
        />}
      </div>
      <ClassReportTable rows={report.rows} sessions={report.sessions} />
    </section>
  );
}

async function ClosedClassSummary({ actor, classId, canEdit }: { actor: Actor; classId: string; canEdit: boolean }) {
  const summary = await getClassSummary(actor, classId);
  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium">
            Tổng kết đã chốt <Badge variant="outline">Lớp đã đóng</Badge>
          </h2>
          {summary.finalizedAt && <p className="text-sm text-muted-foreground">Chốt lúc {formatDateTime(summary.finalizedAt)}</p>}
        </div>
        <ExportLinks baseHref={`/api/export/summary/${classId}`} label="In danh sách / xuất" />
      </div>

      <RewardApproval
        canEdit={canEdit}
        classId={classId}
        rows={summary.rows.map((r) => ({
          summaryId: r.summaryId,
          code: r.code,
          fullName: r.fullName,
          totalStars: r.totalStars,
          attendanceRate: r.attendanceRate,
          rank: r.rank,
          proposedGift: r.proposedGift?.name ?? null,
          handover: r.handover
            ? {
                id: r.handover.id,
                giftName: r.handover.giftName,
                status: r.handover.status,
                givenLabel: r.handover.givenAt ? `Trao lúc ${formatDateTime(r.handover.givenAt)} bởi ${r.handover.givenByName ?? "?"}` : null,
              }
            : null,
        }))}
      />

      <div className="grid gap-2">
        <h3 className="font-medium">Số lượng quà cần chuẩn bị</h3>
        {summary.giftNeeds.length === 0 ? (
          <p className="text-sm text-muted-foreground">Chưa có học viên nào đạt mốc quà. Kiểm tra mục Mốc quà.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {summary.giftNeeds.map((g) => (
              <li key={g.giftId} className="glass-solid rounded-2xl border p-3 text-sm">
                <p className="font-medium">{g.name}</p>
                <p className="text-muted-foreground">
                  Đủ điều kiện {g.eligible} · đã duyệt {g.approved} · đã trao {g.given} · tồn kho {g.stock}
                </p>
                {g.missing > 0 && <p className="font-medium text-destructive">Còn thiếu {g.missing} quà so với tồn kho</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
