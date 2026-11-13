import { processBillingReminder, terminalBillingReason } from "./billing-reminders.mjs";

/** Binding the actual worker's queue prevents malformed job data bypassing the guard. */
export function createProcessor(queueName, billingDependencies, { UnrecoverableError } = {}) {
  return async function processor(job) {
    if (queueName === "billing-reminders") {
      try { return await processBillingReminder(job, billingDependencies); }
      catch (error) {
        const reason = terminalBillingReason(error);
        if (reason && typeof UnrecoverableError === "function") {
          const terminal = new UnrecoverableError(reason);
          terminal.cause = error;
          throw terminal;
        }
        throw error;
      }
    }
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
