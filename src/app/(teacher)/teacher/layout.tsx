import { AppShell } from "@/components/app-shell";
import { navFor } from "@/server/nav";
import { requirePageUser, roleLabelOf } from "@/server/session";

export default async function TeacherLayout({ children }: LayoutProps<"/teacher">) {
  const user = await requirePageUser("teacher");
  return (
    <AppShell {...navFor(user.actor)} userName={user.name} userRole={await roleLabelOf(user)}>
      {children}
    </AppShell>
  );
}
