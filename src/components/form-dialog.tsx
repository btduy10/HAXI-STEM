"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/password-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/** `group`: giá trị của ô cha mà lựa chọn này thuộc về (dùng với `Field.filterBy`). */
export type FieldOption = { value: string; label: string; group?: string };
export type Field = {
  name: string;
  label: string;
  /** "money": số tiền (đồng), hiển thị có dấu phẩy phân cách hàng nghìn khi nhập; gửi đi chỉ gồm chữ số. */
  type?: "text" | "number" | "date" | "time" | "textarea" | "select" | "password" | "money";
  options?: FieldOption[];
  required?: boolean;
  hint?: string;
  /** Giá trị ban đầu khi form không có dữ liệu sẵn (form thêm mới). */
  defaultValue?: string;
  /** Gợi ý cho ô gõ tự do (vd. các loại đã nhập trước đó); người dùng vẫn gõ được giá trị khác. */
  suggestions?: string[];
  /** Ô chọn phụ thuộc: chỉ hiện các lựa chọn có `group` bằng giá trị đang chọn của ô tên này (vd. Lớp theo Khóa học). */
  filterBy?: string;
};

export type ActionFn = (input: unknown) => Promise<{ ok: true; data: unknown } | { ok: false; error: string; fieldErrors?: Record<string, string> }>;

/** Cảnh báo không chặn (vd. vượt sức chứa phòng) mà service trả về kèm kết quả. */
export function showWarnings(data: unknown) {
  const notices = (data as { notices?: unknown } | null)?.notices;
  if (Array.isArray(notices)) for (const n of notices) toast.info(String(n), { duration: 8_000 });
  const warnings = (data as { warnings?: unknown } | null)?.warnings;
  if (Array.isArray(warnings)) for (const w of warnings) toast.warning(String(w), { duration: 10_000 });
}

/** 2000000 → "2,000,000" (bỏ mọi ký tự không phải chữ số và số 0 thừa ở đầu). */
export function formatMoneyInput(value: string): string {
  const digits = value.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Định dạng lại ô tiền sau mỗi lần gõ, giữ con trỏ đúng sau chữ số vừa nhập.
function reformatMoney(input: HTMLInputElement) {
  const digitsBeforeCaret = input.value.slice(0, input.selectionStart ?? input.value.length).replace(/\D/g, "").length;
  const next = formatMoneyInput(input.value);
  input.value = next;
  let caret = 0;
  for (let seen = 0; caret < next.length && seen < digitsBeforeCaret; caret++) if (/\d/.test(next[caret]!)) seen++;
  input.setSelectionRange(caret, caret);
}

export const selectClass =
  "h-11 w-full rounded-xl border border-input bg-white/80 px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  header,
  fields,
  initial,
  submitLabel = "Lưu",
  submitVariant = "default",
  successMessage = "Đã lưu.",
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Phần hiển thị giữa tiêu đề và form, vd. các thẻ chọn kiểu nhập. */
  header?: React.ReactNode;
  fields: Field[];
  initial?: Record<string, string>;
  submitLabel?: string;
  submitVariant?: "default" | "destructive";
  /** Thông báo khi lưu xong; dạng hàm thì nhận kết quả action trả về (vd. để báo mã vừa cấp). */
  successMessage?: string | ((data: unknown) => string);
  onSubmit: (values: Record<string, string>) => ReturnType<ActionFn>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Giá trị đang chọn của các ô mà ô khác phụ thuộc vào (`filterBy`).
  const parents = new Set(fields.flatMap((f) => (f.filterBy ? [f.filterBy] : [])));
  const [parentValues, setParentValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.filter((f) => parents.has(f.name)).map((f) => [f.name, initial?.[f.name] ?? f.defaultValue ?? ""])),
  );

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values: Record<string, string> = {};
    for (const field of fields) {
      const value = String(form.get(field.name) ?? "");
      values[field.name] = field.type === "money" ? value.replace(/\D/g, "") : value;
    }
    setPending(true);
    setError(null);
    setFieldErrors({});
    const result = await onSubmit(values);
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      // Lỗi của form sửa có dạng "data.<trường>".
      const errors = Object.fromEntries(
        Object.entries(result.fieldErrors ?? {}).map(([k, v]) => [k.replace(/^data\./, ""), v]),
      );
      setFieldErrors(errors);
      // Đưa con trỏ tới ô lỗi đầu tiên để người dùng thấy ngay trên màn hình nhỏ.
      const firstInvalid = fields.find((f) => errors[f.name]);
      if (firstInvalid) document.getElementById(`f-${firstInvalid.name}`)?.focus();
      return;
    }
    toast.success(typeof successMessage === "function" ? successMessage(result.data) : successMessage);
    showWarnings(result.data);
    onOpenChange(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      setError(null);
      setFieldErrors({});
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {header}
        <form onSubmit={handleSubmit} className="grid gap-3" noValidate>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {fields.map((field) => {
            const id = `f-${field.name}`;
            const invalid = Boolean(fieldErrors[field.name]);
            const common = {
              id,
              name: field.name,
              defaultValue: initial?.[field.name] ?? field.defaultValue ?? "",
              "aria-invalid": invalid || undefined,
              "aria-describedby": invalid ? `${id}-err` : undefined,
            };
            return (
              <div key={field.name} className="grid gap-1.5">
                <Label htmlFor={id}>
                  {field.label}
                  {field.required && <span className="text-destructive"> *</span>}
                </Label>
                {field.type === "select" ? (
                  <select
                    {...common}
                    // Ô phụ thuộc dựng lại khi ô cha đổi để không giữ lựa chọn của nhóm cũ.
                    key={field.filterBy ? `${field.name}:${parentValues[field.filterBy] ?? ""}` : field.name}
                    className={selectClass}
                    onChange={parents.has(field.name) ? (event) => setParentValues((prev) => ({ ...prev, [field.name]: event.target.value })) : undefined}
                  >
                    {!field.required && <option value="">— Không chọn —</option>}
                    {field.required && !initial?.[field.name] && !field.defaultValue && <option value="">— Chọn —</option>}
                    {field.options
                      ?.filter((o) => !field.filterBy || o.group === parentValues[field.filterBy])
                      .map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                  </select>
                ) : field.type === "textarea" ? (
                  <Textarea {...common} rows={3} />
                ) : field.type === "password" ? (
                  <PasswordInput {...common} autoComplete="new-password" className="h-11" />
                ) : field.type === "money" ? (
                  <Input
                    {...common}
                    defaultValue={formatMoneyInput(common.defaultValue)}
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    className="h-11 tabular-nums"
                    onInput={(event) => reformatMoney(event.currentTarget)}
                  />
                ) : (
                  <>
                    <Input
                      {...common}
                      type={field.type ?? "text"}
                      inputMode={field.type === "number" ? "numeric" : undefined}
                      autoComplete="off"
                      list={field.suggestions?.length ? `${id}-list` : undefined}
                      className="h-11"
                    />
                    {field.suggestions && field.suggestions.length > 0 && (
                      <datalist id={`${id}-list`}>
                        {field.suggestions.map((s) => (
                          <option key={s} value={s} />
                        ))}
                      </datalist>
                    )}
                  </>
                )}
                {field.hint && !invalid && <p className="text-xs text-muted-foreground">{field.hint}</p>}
                {invalid && (
                  <p id={`${id}-err`} className="text-xs text-destructive">
                    {fieldErrors[field.name]}
                  </p>
                )}
              </div>
            );
          })}
          <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="h-11 sm:h-9" onClick={() => handleOpenChange(false)}>
              Hủy
            </Button>
            <Button type="submit" variant={submitVariant} className="h-11 sm:h-9" disabled={pending}>
              {pending ? "Đang lưu…" : submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
