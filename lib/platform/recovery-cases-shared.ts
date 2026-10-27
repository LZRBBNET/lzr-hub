/** Browser-safe contract for supervised cases. No contact, receipt or payment is executed here. */
export const CASE_REASONS = ["debt", "cancellation", "both"] as const;
export type RecoveryCaseReason = typeof CASE_REASONS[number];
export const CASE_STATUSES = ["open", "in_progress", "waiting", "closed"] as const;
export type RecoveryCaseStatus = typeof CASE_STATUSES[number];
export type RecoveryCaseEventType = "opened" | "claimed" | "scheduled" | "note" | "invoice_linked" | "promise_linked" | "attendance_linked" | "closed" | "reopened";
export interface SupervisedRecoveryCase {
  id: string; customerId: string; reason: RecoveryCaseReason; status: RecoveryCaseStatus;
  ownerId: string | null; ownerName: string | null; nextActionOn: string | null;
  invoiceIds: string[]; promiseIds: string[]; attendanceTicketId: string | null;
  attendance: { ticketId: string; protocol: string | null; channel: string; conversationId: string } | null;
  openedAt: string; closedAt: string | null; closingReason: string | null;
  version: number; createdBy: string; updatedAt: string;
}
export interface RecoveryCaseEvent {
  id: string; caseId: string; type: RecoveryCaseEventType; actorId: string; createdAt: string;
  /** Always operator-reported unless the server explicitly records scoped source verification. */
  evidence: Record<string, string | number | boolean | null>;
}
export interface RecoveryCasesListPayload {
  available: boolean; detail?: string; items: SupervisedRecoveryCase[]; total: number | null;
  page: number; pageSize: number; canWrite: boolean; currentActorId: string;
}
export interface RecoveryCaseDetailPayload {
  available: boolean; detail?: string; item: SupervisedRecoveryCase | null; events: RecoveryCaseEvent[];
  historyTruncated: boolean; canWrite: boolean; currentActorId: string;
}
export type RecoveryCaseMutation =
  | { action: "open"; customerId: string; reason: RecoveryCaseReason; idempotencyKey: string }
  | ({ caseId: string; version: number; idempotencyKey: string } & (
    | { action: "claim"; takeOver?: boolean }
    | { action: "schedule"; nextActionOn: string }
    | { action: "note"; text: string }
    | { action: "link_invoice"; invoiceId: string }
    | { action: "link_promise"; promiseId: string }
    | { action: "link_attendance"; protocol: string }
    | { action: "close"; reason: string }
    | { action: "reopen" }
  ));
export interface RecoveryCaseMutationPayload { item: SupervisedRecoveryCase; replay: boolean }
