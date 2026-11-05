import { processBillingReminder } from "./billing-reminders.mjs";

/** Binding the actual worker's queue prevents malformed job data bypassing the guard. */
export function createProcessor(queueName, billingDependencies) {
  return async function processor(job) {
    if (queueName === "billing-reminders") return processBillingReminder(job, billingDependencies);
    const simulateFailures = Number(job.data?.payload?.simulateFailures ?? 0);
    if (Number.isInteger(simulateFailures) && simulateFailures > job.attemptsMade) {
      throw new Error("SIMULATED_TRANSIENT_FAILURE");
    }
    return {
      processedAt: new Date().toISOString(),
      correlationId: job.data?.correlationId,
      queue: queueName,
    };
  };
}
