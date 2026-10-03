import { eq } from "drizzle-orm";
import { agentReplyTemplates } from "../../db/schema.ts";
import type { Intent } from "../agent/types.ts";
import {
  DEFAULT_REPLY_TEMPLATES,
  REPLY_INTENTS,
  validateReplyText,
  type ReplyOverrides,
} from "./reply-templates-shared.ts";

export interface StoredTemplate { intent: Intent; content: string; version: number; updatedBy: string; updatedAt: string }

export interface ReplyTemplatesRepository {
  list(): Promise<StoredTemplate[]>;
  upsert(intent: Intent, content: string, updatedBy: string): Promise<StoredTemplate>;
  /** Volta ao padrão do código. `false` quando não havia edição. */
  remove(intent: Intent): Promise<boolean>;
}

export class ReplyTemplateValidationError extends Error {}

const KNOWN = new Set<string>(REPLY_INTENTS.map((entry) => entry.intent));

function parseIntent(value: unknown): Intent {
  if (typeof value !== "string" || !KNOWN.has(value)) throw new ReplyTemplateValidationError("Intenção desconhecida.");
  return value as Intent;
}

/**
 * Lê as respostas editadas. **Nunca lança**: sem banco ou com erro de leitura o
 * canal usa os padrões do código, que são seguros — derrubar o atendimento por
 * não achar uma edição seria o oposto do que se quer.
 */
export async function loadOverrides(repository: ReplyTemplatesRepository): Promise<ReplyOverrides> {
  try {
    const overrides: ReplyOverrides = {};
    for (const row of await repository.list()) overrides[row.intent] = row.content;
    return overrides;
  } catch {
    return {};
  }
}

export interface SaveOutcome { saved: StoredTemplate; previous: string }

export async function saveTemplate(
  repository: ReplyTemplatesRepository,
  input: { intent: unknown; content: unknown },
  actor: string,
): Promise<SaveOutcome> {
  const intent = parseIntent(input.intent);
  const content = typeof input.content === "string" ? input.content.trim() : "";
  const problem = validateReplyText(content);
  if (problem) throw new ReplyTemplateValidationError(problem);
  const current = (await repository.list()).find((row) => row.intent === intent);
  const saved = await repository.upsert(intent, content, actor);
  return { saved, previous: current?.content ?? DEFAULT_REPLY_TEMPLATES[intent] };
}

export async function resetTemplate(repository: ReplyTemplatesRepository, intentValue: unknown): Promise<{ intent: Intent; previous: string | null }> {
  const intent = parseIntent(intentValue);
  const current = (await repository.list()).find((row) => row.intent === intent);
  await repository.remove(intent);
  return { intent, previous: current?.content ?? null };
}

export interface TemplateView {
  intent: Intent;
  label: string;
  defaultContent: string;
  content: string;
  edited: boolean;
  version: number | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** Uma linha por intenção, com o texto em vigor e o padrão ao lado. */
export async function templatesView(repository: ReplyTemplatesRepository): Promise<TemplateView[]> {
  const stored = new Map((await repository.list()).map((row) => [row.intent, row]));
  return REPLY_INTENTS.map(({ intent, label }) => {
    const row = stored.get(intent);
    return {
      intent, label,
      defaultContent: DEFAULT_REPLY_TEMPLATES[intent],
      content: row?.content ?? DEFAULT_REPLY_TEMPLATES[intent],
      edited: Boolean(row),
      version: row?.version ?? null,
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

export class DbReplyTemplatesRepository implements ReplyTemplatesRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async list(): Promise<StoredTemplate[]> {
    const rows = await this.db.select().from(agentReplyTemplates);
    return rows as StoredTemplate[];
  }

  async upsert(intent: Intent, content: string, updatedBy: string): Promise<StoredTemplate> {
    const existing = (await this.db.select().from(agentReplyTemplates).where(eq(agentReplyTemplates.intent, intent)).limit(1))[0] as StoredTemplate | undefined;
    const row: StoredTemplate = { intent, content, version: (existing?.version ?? 0) + 1, updatedBy, updatedAt: new Date().toISOString() };
    await this.db.insert(agentReplyTemplates).values(row).onConflictDoUpdate({
      target: agentReplyTemplates.intent,
      set: { content: row.content, version: row.version, updatedBy: row.updatedBy, updatedAt: row.updatedAt },
    });
    return row;
  }

  async remove(intent: Intent): Promise<boolean> {
    const removed = await this.db.delete(agentReplyTemplates).where(eq(agentReplyTemplates.intent, intent)).returning({ intent: agentReplyTemplates.intent });
    return removed.length > 0;
  }
}

export class MemoryReplyTemplatesRepository implements ReplyTemplatesRepository {
  readonly rows = new Map<Intent, StoredTemplate>();
  async list() { return [...this.rows.values()]; }
  async upsert(intent: Intent, content: string, updatedBy: string) {
    const row: StoredTemplate = { intent, content, version: (this.rows.get(intent)?.version ?? 0) + 1, updatedBy, updatedAt: new Date().toISOString() };
    this.rows.set(intent, row);
    return row;
  }
  async remove(intent: Intent) { return this.rows.delete(intent); }
}
