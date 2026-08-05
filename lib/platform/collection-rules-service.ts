import { randomUUID } from "node:crypto";
import { asc, desc, eq } from "drizzle-orm";
import { collectionRuleSteps, collectionRules } from "../../db/schema.ts";
import { RULE_CHANNELS } from "./collection-rules-shared.ts";
import type { RuleChannel, CollectionRuleRow, RuleInput, RuleStepRow } from "./collection-rules-shared.ts";

/**
 * Régua de cobrança: as etapas que definem quando e por onde falar com quem
 * está em atraso. É **configuração**, não envio — salvar uma régua não dispara
 * mensagem nenhuma. O envio depende de campanha, que não está ligada.
 *
 * Antes isso vivia num useState que fingia salvar: recarregar a página apagava
 * tudo e a tela ainda dizia "Versão salva".
 */
// Os tipos e a lista de canais vivem em `collection-rules-shared.ts` porque a
// tela também precisa deles, e importar deste arquivo levaria `node:crypto`
// para o navegador. Reexportamos para não quebrar quem já importava daqui.
export { RULE_CHANNELS } from "./collection-rules-shared.ts";
export type { RuleChannel, RuleStepRow, CollectionRuleRow, RuleStepInput, RuleInput } from "./collection-rules-shared.ts";

export interface CollectionRulesRepository {
  getLatest(): Promise<CollectionRuleRow | undefined>;
  saveVersion(input: RuleInput, authorId: string): Promise<CollectionRuleRow>;
}

export class RuleValidationError extends Error {
  constructor(message: string) { super(message); this.name = "RuleValidationError"; }
}

/** Uma régua com etapa fora de faixa ou canal desconhecido é pior que régua nenhuma: falha na entrada. */
export function parseRuleInput(body: Record<string, unknown>): RuleInput {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 3) throw new RuleValidationError("Dê um nome à régua (mínimo 3 caracteres)");
  if (!Array.isArray(body.steps) || body.steps.length === 0) throw new RuleValidationError("A régua precisa de pelo menos uma etapa");
  if (body.steps.length > 20) throw new RuleValidationError("A régua aceita no máximo 20 etapas");

  const steps = (body.steps as Record<string, unknown>[]).map((raw, index) => {
    const offsetDays = Number(raw.offsetDays);
    const attempts = Number(raw.attempts ?? 1);
    const channel = typeof raw.channel === "string" ? raw.channel.trim() : "";
    const templateId = typeof raw.templateId === "string" ? raw.templateId.trim() : "";
    if (!Number.isInteger(offsetDays) || offsetDays < -30 || offsetDays > 180) throw new RuleValidationError(`Etapa ${index + 1}: prazo deve estar entre 30 dias antes e 180 depois do vencimento`);
    if (!RULE_CHANNELS.includes(channel as RuleChannel)) throw new RuleValidationError(`Etapa ${index + 1}: canal inválido`);
    if (!templateId) throw new RuleValidationError(`Etapa ${index + 1}: informe o template`);
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new RuleValidationError(`Etapa ${index + 1}: tentativas devem ficar entre 1 e 5`);
    return { offsetDays, channel, templateId, attempts, active: raw.active !== false };
  });

  return { name, steps };
}

export class DbCollectionRulesRepository implements CollectionRulesRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async getLatest(): Promise<CollectionRuleRow | undefined> {
    const rules = await this.db.select().from(collectionRules).orderBy(desc(collectionRules.version)).limit(1);
    const rule = rules[0];
    if (!rule) return undefined;
    const steps = await this.db.select().from(collectionRuleSteps)
      .where(eq(collectionRuleSteps.ruleId, rule.id))
      .orderBy(asc(collectionRuleSteps.offsetDays));
    return {
      id: rule.id, name: rule.name, status: rule.status, version: rule.version,
      authorId: rule.authorId, updatedAt: rule.updatedAt,
      steps: steps.map((step: RuleStepRow) => ({
        id: step.id, offsetDays: step.offsetDays, channel: step.channel,
        templateId: step.templateId, attempts: step.attempts, active: step.active,
      })),
    };
  }

  /** Cada salvamento é uma versão nova: a régua anterior continua no banco para auditoria. */
  async saveVersion(input: RuleInput, authorId: string): Promise<CollectionRuleRow> {
    const previous = await this.getLatest();
    const now = new Date().toISOString();
    const version = (previous?.version ?? 0) + 1;
    const ruleId = randomUUID();

    await this.db.insert(collectionRules).values({
      id: ruleId, name: input.name, status: "draft", version, authorId, createdAt: now, updatedAt: now,
    });
    const steps = input.steps.map((step) => ({ id: randomUUID(), ruleId, ...step, createdAt: now, updatedAt: now }));
    if (steps.length) await this.db.insert(collectionRuleSteps).values(steps);

    return {
      id: ruleId, name: input.name, status: "draft", version, authorId, updatedAt: now,
      steps: steps.map(({ id, offsetDays, channel, templateId, attempts, active }) => ({ id, offsetDays, channel, templateId, attempts, active })),
    };
  }
}

export class MemoryCollectionRulesRepository implements CollectionRulesRepository {
  readonly versions: CollectionRuleRow[] = [];
  async getLatest() { return [...this.versions].sort((a, b) => b.version - a.version)[0]; }
  async saveVersion(input: RuleInput, authorId: string) {
    const previous = await this.getLatest();
    const row: CollectionRuleRow = {
      id: randomUUID(), name: input.name, status: "draft", version: (previous?.version ?? 0) + 1,
      authorId, updatedAt: new Date().toISOString(),
      steps: input.steps.map((step) => ({ id: randomUUID(), ...step })),
    };
    this.versions.push(row);
    return row;
  }
}
