import { NextResponse } from "next/server";
import { runAgentPipeline } from "@/lib/agent/pipeline";
import type { ChatMessage } from "@/lib/agent/types";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { message?: unknown; history?: ChatMessage[] } | null;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message || message.length > 5000) return NextResponse.json({ error: "Mensagem inválida" }, { status: 400 });
  return NextResponse.json(runAgentPipeline(message, Array.isArray(body?.history) ? body.history.slice(-40) : []));
}
