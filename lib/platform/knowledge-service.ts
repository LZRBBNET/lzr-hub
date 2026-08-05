import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { knowledgeDocuments } from "../../db/schema.ts";

/**
 * Base de conhecimento usada pela IA como fonte citável.
 *
 * Antes isso vivia num array de módulo alimentado por dados de demonstração:
 * ingerir e publicar "funcionavam" até o próximo restart, quando tudo voltava
 * ao estado inicial. A tabela `knowledge_documents` já existia no schema e
 * nunca tinha recebido uma linha.
 */
export interface KnowledgeDoc {
  id: string;
  title: string;
  category: string;
  content: string;
  status: "draft" | "published";
  version: number;
  validUntil: string | null;
  updatedAt: string;
}

export interface KnowledgeSearchHit { document: KnowledgeDoc; score: number; evidence: string }

export interface KnowledgeRepository {
  list(limit: number): Promise<KnowledgeDoc[]>;
  create(input: { title: string; category: string; content: string }): Promise<KnowledgeDoc>;
  publish(id: string): Promise<KnowledgeDoc | undefined>;
}

export class KnowledgeValidationError extends Error {
  constructor(message: string) { super(message); this.name = "KnowledgeValidationError"; }
}

const normalize = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function parseKnowledgeInput(body: Record<string, unknown>) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const category = typeof body.category === "string" && body.category.trim() ? body.category.trim() : "Geral";
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (title.length < 3) throw new KnowledgeValidationError("O título precisa de pelo menos 3 caracteres");
  // Documento sem corpo não tem o que a IA citar — publicá-lo produziria uma
  // resposta com fonte vazia, que é pior do que não ter fonte.
  if (content.length < 20) throw new KnowledgeValidationError("Escreva o conteúdo do documento (mínimo 20 caracteres)");
  return { title, category, content };
}

/**
 * Busca por termos no título, categoria e conteúdo. Só documentos publicados —
 * rascunho não é fonte. É correspondência textual simples, não busca semântica:
 * `FEATURE_PGVECTOR` está desligada e não há embedding gerado.
 */
export function searchDocuments(documents: KnowledgeDoc[], query: string): KnowledgeSearchHit[] {
  const terms = normalize(query).split(/\s+/).filter((term) => term.length > 2);
  if (terms.length === 0) return [];
  return documents
    .filter((document) => document.status === "published")
    .map((document) => {
      const haystack = normalize(`${document.title} ${document.category} ${document.content}`);
      const hits = terms.filter((term) => haystack.includes(term)).length;
      return { document, score: hits / terms.length, evidence: `Fonte interna: ${document.title} • versão ${document.version}` };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score);
}

const toDoc = (row: Record<string, unknown>): KnowledgeDoc => ({
  id: String(row.id), title: String(row.title), category: String(row.category),
  content: String(row.content), status: row.status === "published" ? "published" : "draft",
  version: Number(row.version ?? 1), validUntil: row.validUntil ? String(row.validUntil) : null,
  updatedAt: String(row.updatedAt),
});

export class DbKnowledgeRepository implements KnowledgeRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async list(limit: number): Promise<KnowledgeDoc[]> {
    const rows = await this.db.select().from(knowledgeDocuments).orderBy(desc(knowledgeDocuments.updatedAt)).limit(limit);
    return rows.map(toDoc);
  }
  async create(input: { title: string; category: string; content: string }): Promise<KnowledgeDoc> {
    const now = new Date().toISOString();
    const row = { id: randomUUID(), ...input, status: "draft", version: 1, metadata: null, validUntil: null, createdAt: now, updatedAt: now };
    await this.db.insert(knowledgeDocuments).values(row);
    return toDoc(row);
  }
  async publish(id: string): Promise<KnowledgeDoc | undefined> {
    const existing = await this.db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, id)).limit(1);
    if (!existing[0]) return undefined;
    const updated = await this.db.update(knowledgeDocuments)
      .set({ status: "published", version: Number(existing[0].version ?? 1) + 1, updatedAt: new Date().toISOString() })
      .where(eq(knowledgeDocuments.id, id))
      .returning();
    return updated[0] ? toDoc(updated[0]) : undefined;
  }
}

export class MemoryKnowledgeRepository implements KnowledgeRepository {
  readonly documents: KnowledgeDoc[] = [];
  async list(limit: number) { return [...this.documents].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit); }
  async create(input: { title: string; category: string; content: string }) {
    const document: KnowledgeDoc = { id: randomUUID(), ...input, status: "draft", version: 1, validUntil: null, updatedAt: new Date().toISOString() };
    this.documents.push(document);
    return document;
  }
  async publish(id: string) {
    const document = this.documents.find((item) => item.id === id);
    if (!document) return undefined;
    document.status = "published"; document.version += 1; document.updatedAt = new Date().toISOString();
    return document;
  }
}
