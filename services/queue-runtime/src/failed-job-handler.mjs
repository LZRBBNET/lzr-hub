import { deadLetterQueueName } from './config.mjs';
import { terminalBillingReason } from './billing-reminders.mjs';

export function createFailedJobHandler(name, runtime, log = console) {
  return async (job, error) => {
    if (!job) return;
    const reason = name === 'billing-reminders' ? terminalBillingReason(error) : null;
    if (reason) {
      // Still FAILED, never delivered/completed. Keep original record for review;
      // do not copy it to a DLQ where a manual replay could repeat an uncertain send.
      log.warn(JSON.stringify({ event: 'queue-job-blocked-terminal', queue: name, reason, retryAllowed: false }));
      return;
    }
    const maximum = Number(job.opts.attempts ?? 1);
    log.warn(JSON.stringify({ event: 'queue-job-failed', queue: name, jobId: job.id, attempts: job.attemptsMade, maximum, error: error.message }));
    if (job.attemptsMade < maximum) return;
    try {
      const dlq = runtime.queue(deadLetterQueueName);
      const dlqId = `dlq-${name}-${job.id}`.replaceAll(':', '-');
      if (await dlq.getJob(dlqId)) return;
      await dlq.add('failed-job', { originalQueue: name, originalJobId: String(job.id), correlationId: job.data?.correlationId, idempotencyKey: job.data?.idempotencyKey, failedAt: new Date().toISOString(), error: error.message.slice(0, 180) }, { jobId: dlqId, attempts: 1, removeOnComplete: false, removeOnFail: false });
      log.warn(JSON.stringify({ event: 'queue-job-dead-lettered', queue: name, jobId: job.id, dlqId }));
    } catch (dlqError) {
      log.error(JSON.stringify({ event: 'queue-dlq-write-failed', queue: name, jobId: job.id, error: dlqError instanceof Error ? dlqError.message : 'UNKNOWN' }));
    }
  };
}
