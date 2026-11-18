import type { Metadata } from "next";
import { selectClass } from "@/components/form-dialog";
import { LinkButton } from "@/components/link-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/format";
import { paramChoice, paramDate, paramText } from "@/lib/search-params";
import { listAuditLogs, listAuditTables } from "@/server/services/reports";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Nhật ký" };


export default async function AuditPage({ searchParams }: PageProps<"/admin/audit">) {
  const { actor } = await requirePageUser("admin");
  const params = await searchParams;
  const tables = await listAuditTables(actor);
  const filters = {
    action: paramText(params.action, 50),
    tableName: paramChoice(params.table, tables, ""),
    from: paramDate(params.from, ""),
    to: paramDate(params.to, ""),
  };
  const page = Math.min(10_000, Math.max(1, Number.parseInt(paramText(params.page), 10) || 1));
  const result = await listAuditLogs(actor, { ...filters, page });

  const href = (p: number) => {
    const query = new URLSearchParams({ page: String(p) });
    if (filters.action) query.set("action", filters.action);
    if (filters.tableName) query.set("table", filters.tableName);
    if (filters.from) query.set("from", filters.from);
    if (filters.to) query.set("to", filters.to);
    return `/admin/audit?${query}`;
  };

  return (
    <div className="grid gap-4">
      <div>
        <h1 className="text-xl font-semibold sm:text-2xl">Nhật ký</h1>
        <p className="text-sm text-muted-foreground">
          Ghi lại đăng nhập, thay đổi tài khoản, điểm danh, sao, lịch học, xuất báo cáo và mọi thao tác tạo/sửa/xóa. {result.total} bản ghi.
        </p>
      </div>
      <form className="grid gap-2 sm:grid-cols-5">
        <Input name="action" defaultValue={filters.action} placeholder="Hành động (vd. login)" aria-label="Lọc theo hành động" className="h-11" />
        <select name="table" defaultValue={filters.tableName} aria-label="Lọc theo bảng" className={selectClass}>
          <option value="">Tất cả bảng</option>
          {tables.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <Input name="from" type="date" defaultValue={filters.from} aria-label="Từ ngày" className="h-11" />
        <Input name="to" type="date" defaultValue={filters.to} aria-label="Đến ngày" className="h-11" />
        <Button type="submit" variant="outline" className="h-11">
          Lọc
        </Button>
      </form>

      {result.rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">Không có bản ghi phù hợp.</p>
      ) : (
        <ul className="grid gap-1.5">
          {result.rows.map((log) => (
            <li key={log.id} className="glass-solid rounded-xl border px-3 py-2 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{log.action}</span>
                <span className="text-muted-foreground">{log.tableName}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {log.username ?? "(không rõ)"} · {formatDateTime(log.createdAt)}
                </span>
              </div>
              {(log.oldValue !== null || log.newValue !== null || log.recordId) && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-muted-foreground">Chi tiết</summary>
                  <dl className="mt-1 grid gap-1 text-xs">
                    {log.recordId && (
                      <div>
                        <dt className="text-muted-foreground">Bản ghi</dt>
                        <dd className="break-all font-mono">{log.recordId}</dd>
                      </div>
                    )}
                    {log.oldValue !== null && (
                      <div>
                        <dt className="text-muted-foreground">Giá trị cũ</dt>
                        <dd>
                          <pre className="overflow-x-auto rounded bg-muted p-2 whitespace-pre-wrap break-all">{JSON.stringify(log.oldValue, null, 1)}</pre>
                        </dd>
                      </div>
                    )}
                    {log.newValue !== null && (
                      <div>
                        <dt className="text-muted-foreground">Giá trị mới</dt>
                        <dd>
                          <pre className="overflow-x-auto rounded bg-muted p-2 whitespace-pre-wrap break-all">{JSON.stringify(log.newValue, null, 1)}</pre>
                        </dd>
                      </div>
                    )}
                  </dl>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-2 text-sm">
        {result.page > 1 ? (
          <LinkButton variant="outline" className="h-10" href={href(result.page - 1)}>
            ← Mới hơn
          </LinkButton>
        ) : (
          <span />
        )}
        <span className="text-muted-foreground">
          Trang {result.page}/{result.pages}
        </span>
        {result.page < result.pages ? (
          <LinkButton variant="outline" className="h-10" href={href(result.page + 1)}>
            Cũ hơn →
          </LinkButton>
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}