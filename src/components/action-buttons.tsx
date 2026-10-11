"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { type ActionFn, type Field, FormDialog, showWarnings } from "./form-dialog";

type ButtonVariant = "default" | "outline" | "ghost" | "destructive" | "secondary";

/** Nút mở hộp thoại nhập liệu rồi gọi action với `{...fixed, ...giá trị form}`. */
export function FormDialogButton({
  label,
  title,
  description,
  fields,
  initial,
  fixed,
  action,
  variant = "default",
  submitLabel,
  successMessage,
  className,
}: {
  label: string;
  title: string;
  description?: string;
  fields: Field[];
  initial?: Record<string, string>;
  fixed?: Record<string, string>;
  action: ActionFn;
  variant?: ButtonVariant;
  submitLabel?: string;
  successMessage?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant={variant} className={className ?? "h-10"} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && (
        <FormDialog
          open
          onOpenChange={setOpen}
          title={title}
          description={description}
          fields={fields}
          initial={initial}
          submitLabel={submitLabel}
          successMessage={successMessage}
          onSubmit={(values) => action({ ...fixed, ...values })}
        />
      )}
    </>
  );
}

/** Nút thực hiện ngay một action sau khi người dùng xác nhận. */
export function ConfirmButton({
  label,
  confirmText,
  action,
  input,
  variant = "outline",
  successMessage = "Đã thực hiện.",
  className,
  ariaLabel,
}: {
  label: string;
  /** Tên đầy đủ cho trình đọc màn hình khi nhiều nút cùng nhãn nằm trong một danh sách (vd. "Xóa" ở từng dòng). */
  ariaLabel?: string;
  confirmText: string;
  action: ActionFn;
  input: unknown;
  variant?: ButtonVariant;
  successMessage?: string;
  className?: string;
}) {
  const [pending, startTransition] = useTransition();
  function run() {
    if (!window.confirm(confirmText)) return;
    startTransition(async () => {
      const result = await action(input);
      if (!result.ok) return void toast.error(result.error);
      toast.success(successMessage);
      showWarnings(result.data);
    });
  }
  return (
    <Button type="button" variant={variant} className={className ?? "h-10"} aria-label={ariaLabel} disabled={pending} onClick={run}>
      {label}
    </Button>
  );
}
