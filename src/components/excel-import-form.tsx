"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { LinkButton } from "@/components/link-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Row = { rowNumber: number; errors: string[]; data: unknown | null } & Record<string, unknown>;
type Preview = { rows: Row[]; validCount: number; errorCount: number; inserted?: number; updated?: number };
type ApiResult = { ok: true; data: Preview } | { ok: false; error: string };

// Mỗi loại dữ liệu nhập: nơi gửi tệp, cách tóm tắt một dòng ở phần xem trước, câu báo khi nhập xong.
const KINDS = {
  syllabus: {
    title: "Nhập Syllabus từ Excel",
    endpoint: "/api/import/syllabus",
    backHref: "/admin/syllabus",
    describe: (row: Row) =>
      `${row.courseName || "(thiếu khóa học)"} · ${row.className || "(thiếu lớp)"} · Buổi ${row.period || "?"} – ${row.title || "(thiếu tên bài)"}${row.product ? ` · Sản phẩm: ${row.product}` : ""}`,
    done: (data: Preview) => `Đã thêm ${data.inserted ?? 0} bài, cập nhật ${data.updated ?? 0} bài.`,
  },
} as const;

/** Nhập dữ liệu từ tệp Excel: chọn tệp → Xem trước (báo lỗi từng dòng) → Nhập các dòng hợp lệ. */
export function ExcelImportForm({ kind, note }: { kind: keyof typeof KINDS; note?: string }) {
  const config = KINDS[kind];
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function send(mode: "preview" | "commit") {
    const file = fileRef.current?.files?.[0];
    if (!file) return setError("Chưa chọn tệp.");
    const body = new FormData();
    body.set("file", file);
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`${config.endpoint}?mode=${mode}`, { method: "POST", body });
      const result = (await response.json()) as ApiResult;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPreview(result.data);
      if (mode === "commit") {
        setDone(true);
        toast.success(config.done(result.data));
      }
    } catch {
      setError("Không gửi được tệp. Vui lòng thử lại.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid max-w-3xl gap-4">
      <div>
        <h1 className="text-xl font-semibold sm:text-2xl">{config.title}</h1>
        <p className="text-sm text-muted-foreground">
          Tệp .xlsx tối đa 2 MB, 500 dòng. Dòng đầu là tiêu đề cột.{" "}
          <a href={config.endpoint} className="underline underline-offset-2">
            Tải tệp mẫu
          </a>
        </p>
        {note && <p className="text-sm text-muted-foreground">{note}</p>}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="file">Tệp Excel</Label>
        <Input
          id="file"
          ref={fileRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="h-11"
          onChange={() => {
            setPreview(null);
            setDone(false);
            setError(null);
          }}
        />
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button className="h-10" variant="outline" disabled={pending} onClick={() => send("preview")}>
          {pending && !preview ? "Đang kiểm tra…" : "Xem trước"}
        </Button>
        {preview && !done && preview.validCount > 0 && (
          <Button className="h-10" disabled={pending} onClick={() => send("commit")}>
            {pending ? "Đang nhập…" : `Nhập ${preview.validCount} dòng hợp lệ`}
          </Button>
        )}
        <LinkButton className="h-10" variant="ghost" href={config.backHref}>
          Về danh sách
        </LinkButton>
      </div>

      {preview && (
        <div className="grid gap-2">
          <p className="text-sm">
            {done ? "Kết quả: " : "Xem trước: "}
            <strong>{preview.validCount}</strong> dòng hợp lệ, <strong>{preview.errorCount}</strong> dòng lỗi
            {preview.errorCount > 0 && !done && " (dòng lỗi sẽ bị bỏ qua)"}.
          </p>
          <ul className="grid gap-2">
            {preview.rows.map((row) => (
              <li key={row.rowNumber} className="glass-solid rounded-2xl border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">Dòng {row.rowNumber}</span>
                  <span className="font-medium break-words">{config.describe(row)}</span>
                  <Badge variant={row.errors.length ? "destructive" : "secondary"}>{row.errors.length ? "Lỗi" : "Hợp lệ"}</Badge>
                </div>
                {row.errors.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-destructive">
                    {row.errors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
