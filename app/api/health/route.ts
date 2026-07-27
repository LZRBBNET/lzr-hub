import { NextResponse } from "next/server";
import { stagingDemoHealth } from "@/lib/runtime/staging-demo";

export async function GET() {
  return NextResponse.json(stagingDemoHealth());
}
