import { NextResponse } from "next/server";
import { rolePermissions } from "@/lib/platform/rbac";
import { authEnforced, currentUser } from "@/lib/platform/session-guard";

export async function GET(request: Request) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ authenticated: false, authRequired: authEnforced() }, { status: 200 });
  return NextResponse.json({
    authenticated: true,
    authRequired: authEnforced(),
    user,
    permissions: rolePermissions[user.role],
  });
}
