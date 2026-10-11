"use client";

import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { LinkButton } from "@/components/link-button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { type ActionFn, type Field, FormDialog } from "./form-dialog";

export type CrudRow = {
  id: string;
  /** Giá trị hiển thị theo thứ tự cột. */
  cells: string[];
  /** Giá trị gốc để nạp vào form sửa. */
  values: Record<string, string>;
  href?: string;
  /** Tên dòng dùng cho nút Sửa/Xóa và hộp xác nhận, mặc định là ô đầu tiên. */
  label?: string;
};

/**
 * Danh sách + thêm/sửa/xóa dùng chung. Điện thoại hiển thị dạng thẻ, màn hình rộng dạng bảng.
 * Dữ liệu và action do trang (server component) truyền vào.
 */
export function CrudSection({
  title,
  columns,
  rows,
  fields,
  editFields,
  createAction,
  updateAction,
  deleteAction,
  deleteNote,
  addLabel = "Thêm",
  emptyText = "Chưa có dữ liệu.",
  detailLabel = "Chi tiết",
  numbered = false,
  centered = [],
  startIndex = 0,
  total,
  footer,
  mergeFirstColumn = false,
}: {
  /** Gộp ô đầu của các dòng liền nhau có cùng giá trị (vd. một ca có nhiều khung giờ); STT đếm theo nhóm. */
  mergeFirstColumn?: boolean;
  /** Hiện cột STT ở đầu danh sách. */
  numbered?: boolean;
  /** Tên các cột canh giữa trong bảng (cột STT luôn canh giữa). */
  centered?: string[];
  /** Số thứ tự của dòng đầu trừ 1 (khi danh sách được phân trang). */
  startIndex?: number;
  /** Tổng số dòng của cả danh sách khi `rows` chỉ là một trang. */
  total?: number;
  /** Phần hiển thị dưới danh sách, vd. điều hướng trang. */
  footer?: React.ReactNode;
  title: string;
  columns: string[];
  rows: CrudRow[];
  fields: Field[];
  /** Ô nhập của form sửa nếu khác form thêm (vd. không cho đổi giáo viên của một phân công). */
  editFields?: Field[];
  createAction?: ActionFn;
  updateAction?: ActionFn;
  deleteAction?: ActionFn;
  /** Câu nói thêm trong hộp xác nhận xóa (vd. dữ liệu nào bị xóa theo). */
  deleteNote?: string;
  addLabel?: string;
  emptyText?: string;
  detailLabel?: string;
}) {
  const [editing, setEditing] = useState<CrudRow | "new" | null>(null);
  const [pending, startTransition] = useTransition();

  function remove(row: CrudRow) {
    const note = deleteNote ? `${deleteNote} ` : "";
    if (!deleteAction || !window.confirm(`Xóa "${row.label ?? row.cells[0]}"? ${note}Thao tác này không hoàn tác được.`)) return;
    startTransition(async () => {
      const result = await deleteAction({ id: row.id });
      if (result.ok) toast.success("Đã xóa.");
      else toast.error(result.error);
    });
  }

  const rowActions = (row: CrudRow) => (
    <div className="flex shrink-0 items-center justify-end gap-1">
      {row.href && (
        <LinkButton variant="outline" className="h-9" href={row.href}>
          {detailLabel}
        </LinkButton>
      )}
      {updateAction && (
        <Button variant="ghost" size="icon-lg" aria-label={`Sửa ${row.label ?? row.cells[0]}`} onClick={() => setEditing(row)}>
          <PencilIcon />
        </Button>
      )}
      {deleteAction && (
        <Button variant="ghost" size="icon-lg" aria-label={`Xóa ${row.label ?? row.cells[0]}`} disabled={pending} onClick={() => remove(row)}>
          <Trash2Icon />
        </Button>
      )}
    </div>
  );

  // Gộp ô đầu: số dòng của mỗi nhóm (0 = dòng nằm trong nhóm phía trên) và STT theo nhóm.
  const spans = rows.map((row, i) => {
    if (!mergeFirstColumn) return 1;
    if (i > 0 && rows[i - 1]!.cells[0] === row.cells[0]) return 0;
    let n = 1;
    while (rows[i + n]?.cells[0] === row.cells[0]) n++;
    return n;
  });
  const groupNo = spans.map((_, i) => spans.slice(0, i + 1).filter((n) => n > 0).length);

  return (
    <section className="grid min-w-0 gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          {title} <span className="text-sm font-normal text-muted-foreground">({total ?? rows.length})</span>
        </h2>
        {createAction && (
          <Button className="h-10" onClick={() => setEditing("new")}>
            <PlusIcon /> {addLabel}
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <>
          <ul className="grid gap-2 md:hidden">
            {rows.map((row, index) => (
              <li key={row.id} className={cn("flex gap-2 glass-solid rounded-xl border p-3", row.href ? "flex-col" : "items-start justify-between")}>
                <div className="min-w-0">
                  <p className="font-medium break-words">
                    {numbered && <span className="mr-1 font-normal text-muted-foreground tabular-nums">{startIndex + groupNo[index]!}.</span>}
                    {row.cells[0]}
                  </p>
                  <dl className="mt-1 grid gap-0.5 text-sm text-muted-foreground">
                    {row.cells.slice(1).map((cell, i) =>
                      cell ? (
                        <div key={columns[i + 1]} className="flex gap-1">
                          <dt className="shrink-0">{columns[i + 1]}:</dt>
                          <dd className="min-w-0 break-words text-foreground">{cell}</dd>
                        </div>
                      ) : null,
                    )}
                  </dl>
                </div>
                {rowActions(row)}
              </li>
            ))}
          </ul>
          <div className="glass-solid hidden min-w-0 overflow-hidden rounded-2xl border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  {numbered && <TableHead className="w-14 text-center">STT</TableHead>}
                  {columns.map((c) => (
                    <TableHead key={c} className={cn(centered.includes(c) && "text-center")}>
                      {c}
                    </TableHead>
                  ))}
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, index) => (
                  <TableRow key={row.id}>
                    {numbered && spans[index]! > 0 && (
                      <TableCell rowSpan={spans[index]} className="text-center align-top text-muted-foreground tabular-nums">
                        {startIndex + groupNo[index]!}
                      </TableCell>
                    )}
                    {row.cells.map((cell, i) =>
                      i === 0 && spans[index] === 0 ? null : (
                        <TableCell
                          key={columns[i]}
                          rowSpan={i === 0 && spans[index]! > 1 ? spans[index] : undefined}
                          className={cn("whitespace-normal", i === 0 && spans[index]! > 1 && "align-top", centered.includes(columns[i]!) && "text-center")}
                        >
                          {cell}
                        </TableCell>
                      ),
                    )}
                    <TableCell>{rowActions(row)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
      {footer}

      {editing && (
        <FormDialog
          open
          onOpenChange={(open) => !open && setEditing(null)}
          title={editing === "new" ? `${addLabel} ${title.toLowerCase()}` : `Sửa ${title.toLowerCase()}`}
          fields={editing === "new" ? fields : (editFields ?? fields)}
          initial={editing === "new" ? undefined : editing.values}
          onSubmit={(values) =>
            editing === "new" ? createAction!(values) : updateAction!({ id: editing.id, data: values })
          }
        />
      )}
    </section>
  );
}
