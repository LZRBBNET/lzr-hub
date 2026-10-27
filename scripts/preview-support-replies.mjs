/** Offline, deterministic preview; never calls a model, IXC, a database or Meta. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { supportTranscripts } from '../tests/fixtures/support-transcripts.mjs';

process.env.FEATURE_LLM_INTENT = 'false';
process.env.FEATURE_COPILOT_LLM = 'false';
process.env.FEATURE_LANGFUSE = 'false';
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts += 1; throw new Error('Network is prohibited in this offline preview.'); };
const repo = resolve(process.argv[2] ?? '.');
const moduleAt = (path) => import(pathToFileURL(resolve(repo, path)).href);
const { MemoryChannelRepository, processChannelMessage, CHANNEL_NAME } = await moduleAt('lib/platform/n8n-channel-service.ts');
const { MemoryTicketRepository, startTriage } = await moduleAt('lib/platform/triage-service.ts');
const output = [];
for (const scenario of supportTranscripts) {
  const channel = new MemoryChannelRepository();
  await channel.saveMessages(CHANNEL_NAME, 'fixture', scenario.history);
  const triage = scenario.triage
    ? await startTriage(new MemoryTicketRepository(), { channel: CHANNEL_NAME, conversationId: 'fixture', lookup: async () => undefined })
    : undefined;
  const result = await processChannelMessage(channel, {
    externalConversationId: 'fixture', text: scenario.message,
    idempotencyKey: scenario.id, correlationId: `offline-${scenario.id}`,
  }, undefined, { autoReply: !!scenario.triage, triage: triage?.hooks,
    // Delivery exists only in memory, solely to exercise clarification branches.
    ...(scenario.triage ? { send: async () => ({ sent: true, messageId: `fake-${scenario.id}` }) } : {}),
  });
  output.push({ id: scenario.id, title: scenario.title, history: scenario.history, message: scenario.message,
    output: (result.suggestion ?? result.response).replace(/\n\nProtocolo do atendimento: \d+$/, ''),
    status: result.status, handoff: result.handoff, provenance: 'offline deterministic code; memory-only delivery' });
}
if (networkAttempts !== 0) throw new Error(`Unexpected network attempts: ${networkAttempts}`);
console.log(JSON.stringify({
  mode: 'offline deterministic replay; invented scenarios with seeded history; not live-model outputs',
  revision: process.argv[3] ?? 'local-working-tree',
  modelCalls: 0, networkAttempts, scenarios: output,
}, null, 2));
