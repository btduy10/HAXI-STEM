import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LinkButton } from "@/components/link-button";
import { PrintButton } from "@/components/print-button";
import { PrintHeader, PrintRow, PrintSheet } from "@/components/tuition-print";
import { PAYMENT_METHOD_LABEL, moneyInWords } from "@/domain/tuition";
import { formatDate, formatMoney } from "@/lib/format";
import { AppError } from "@/server/errors";
import { getReceipt } from "@/server/services/tuition";
import { requireMenu } from "@/server/session";

export const metadata: Metadata = { title: "Phiếu thu học phí" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ReceiptPage({ params }: PageProps<"/admin/tuition/receipts/[id]">) {
  const { actor } = await requireMenu("tuition");
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const data = await getReceipt(actor, id).catch((error: unknown) => {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  });
  const { receipt, balance, center } = data;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <LinkButton variant="outline" className="h-10" href={`/admin/tuition?classId=${receipt.classId}`}>
          ← Học phí
        </LinkButton>
        <PrintButton label="In phiếu thu" />
      </div>
      <PrintSheet>
        <PrintHeader center={center} />
        <div className="text-center">
          <h1 className="text-xl font-bold uppercase">Phiếu thu học phí</h1>
          <p>
            Số: <strong>{receipt.code}</strong> · Ngày {formatDate(receipt.paidAt)}
          </p>
          {receipt.status === "cancelled" && <p className="font-bold text-destructive uppercase">Phiếu đã hủy</p>}
        </div>
        <dl>
          <PrintRow label="Người nộp">{receipt.payerName ?? ""}</PrintRow>
          <PrintRow label="Học viên" strong>
            {receipt.studentName} ({receipt.studentCode})
          </PrintRow>
          <PrintRow label="Lớp">
            {receipt.classCode} – {receipt.className}
          </PrintRow>
          <PrintRow label="Nội dung">Thu học phí{receipt.note ? ` – ${receipt.note}` : ""}</PrintRow>
          <PrintRow label="Số tiền" strong>
            {formatMoney(receipt.amount)}
          </PrintRow>
          <PrintRow label="Bằng chữ">{moneyInWords(receipt.amount)}</PrintRow>
          <PrintRow label="Hình thức">{PAYMENT_METHOD_LABEL[receipt.method]}</PrintRow>
          {balance && balance.status !== "unset" && (
            <PrintRow label="Tình hình học phí">
              {balance.remaining === 0
                ? "Đã đóng đủ tiền"
                : `Đã đóng ${formatMoney(balance.paid)}, còn ${formatMoney(balance.remaining)}`}
            </PrintRow>
          )}
        </dl>
        <div className="grid grid-cols-2 gap-4 pt-4 text-center">
          <div>
            <p className="font-semibold">Người nộp tiền</p>
            <p className="text-xs text-muted-foreground print:text-black">(Ký, ghi rõ họ tên)</p>
            <div className="h-20" />
            <p>{receipt.payerName ?? ""}</p>
          </div>
          <div>
            <p className="font-semibold">Người thu tiền</p>
            <p className="text-xs text-muted-foreground print:text-black">(Ký, ghi rõ họ tên)</p>
            <div className="h-20" />
            <p>{receipt.collectorName ?? ""}</p>
          </div>
        </div>
      </PrintSheet>
    </div>
  );
}
