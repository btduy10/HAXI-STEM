import type { Metadata } from "next";
import { LinkButton } from "@/components/link-button";
import { PrintButton } from "@/components/print-button";
import { PrintHeader, PrintRow, PrintSheet } from "@/components/tuition-print";
import { moneyInWords } from "@/domain/tuition";
import { formatDate, formatMoney, todayIso } from "@/lib/format";
import { getFeeNotices } from "@/server/services/tuition";
import { requireMenu } from "@/server/session";

export const metadata: Metadata = { title: "Giấy báo học phí" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Giấy báo học phí gửi phụ huynh: một học viên (`enrollmentId`) hoặc cả lớp (`classId`), mỗi em một trang khi in. */
export default async function FeeNoticePage({ searchParams }: PageProps<"/admin/tuition/notice">) {
  const { actor } = await requireMenu("tuition");
  const params = await searchParams;
  const uuid = (key: string) => {
    const value = params[key];
    const text = Array.isArray(value) ? value[0] : value;
    return text && UUID.test(text) ? text : null;
  };
  const classId = uuid("classId");
  const { notices, center } = await getFeeNotices(actor, { enrollmentId: uuid("enrollmentId"), classId, unpaidOnly: params.unpaidOnly === "1" });
  const today = todayIso();
  const back = classId ?? notices[0]?.classId;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <LinkButton variant="outline" className="h-10" href={back ? `/admin/tuition?classId=${back}` : "/admin/tuition"}>
          ← Học phí
        </LinkButton>
        {notices.length > 0 && <PrintButton label={notices.length > 1 ? `In ${notices.length} giấy báo` : "In giấy báo"} />}
      </div>
      {notices.length === 0 && (
        <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground print:hidden">
          Không có giấy báo học phí nào. Lớp cần được đặt học phí và có học viên đang học.
        </p>
      )}
      {notices.map((n) => (
        <PrintSheet key={n.enrollmentId}>
          <PrintHeader center={center} />
          <div className="text-center">
            <h1 className="text-xl font-bold uppercase">Giấy báo học phí</h1>
            <p>Ngày {formatDate(today)}</p>
          </div>
          <p>Kính gửi: Quý phụ huynh học viên</p>
          <dl>
            <PrintRow label="Học viên" strong>
              {n.studentName} ({n.studentCode})
            </PrintRow>
            <PrintRow label="Lớp">
              {n.classCode} – {n.className}
            </PrintRow>
            <PrintRow label="Thời gian học">
              {formatDate(n.classStart)} – {formatDate(n.classEnd)}
            </PrintRow>
            <PrintRow label="Học phí">{formatMoney(n.fee ?? 0)}</PrintRow>
            {n.discount > 0 && (
              <PrintRow label="Giảm">
                {formatMoney(n.discount)}
                {n.discountReason && ` (${n.discountReason})`}
              </PrintRow>
            )}
            <PrintRow label="Phải đóng">{formatMoney(n.due)}</PrintRow>
            <PrintRow label="Đã đóng">{formatMoney(n.paid)}</PrintRow>
            <PrintRow label="Còn phải đóng" strong>
              {formatMoney(n.remaining)}
            </PrintRow>
            <PrintRow label="Bằng chữ">{moneyInWords(n.remaining)}</PrintRow>
          </dl>
          {n.remaining === 0 ? (
            <p className="font-semibold">Học viên đã đóng đủ học phí. Trân trọng cảm ơn quý phụ huynh.</p>
          ) : (
            center.bank && (
              <div>
                <p className="font-semibold">Thông tin chuyển khoản</p>
                <p className="whitespace-pre-line">{center.bank}</p>
                <p>
                  Nội dung chuyển khoản: {n.studentCode} {n.studentName} {n.classCode}
                </p>
              </div>
            )
          )}
          <p className="pt-2 text-right font-semibold">{center.name}</p>
        </PrintSheet>
      ))}
    </div>
  );
}
