# Billing evidence and usable promise links

Bounded local correction on top of the isolated browser-gate source. This patch
does not deploy, migrate, create users, send messages, change IXC records or add
campaigns. The pending authenticated browser gate is a separate gate.

## Financial semantics

- Billing Overview sums only finite, nonnegative, safe-cent amounts whose source
  is the validated open balance. Face value is not an open-balance substitute.
- Confirmed zero stays zero. No known amount in an incomplete reading is `null`
  and displays as `—`. Known partial sums remain visible with coverage warnings;
  the average is withheld when coverage is incomplete.
- Unknown invoice status, impossible calendar date, duplicate identity or
  mismatched customer is not silently treated as collectible debt.
- Source pagination must not invent a complete financial count from a missing
  or malformed total. Inconsistent financial pages fail closed.
- Receipt windows use one reference instant and include both exact endpoints.
  Explicit-zone timestamps are checked against the actual rolling interval.
  Future/invalid timestamps do not prove a receipt. A date without a confirmed
  time/zone counts only on a wholly interior Brasília calendar day; an ambiguous
  boundary day is excluded and disclosed, not assigned midnight.
- A count of dated payment records is not a sum of unknown payment amounts.
  “Observed” totals are neither the entire customer balance nor causal recovery.

## Operator workflow

1. Read the selected customer's invoices and coverage before taking action.
2. Create a promise only after a fresh exact invoice/customer lookup. The first
   twenty invoices in a customer snapshot are not the validation authority.
3. Copy the visible **Código da promessa no HUB** from pending promises or the
   same customer's history. Link it in the supervised case.
4. The backend rechecks both the promise's customer and its exact invoice. A
   missing/moved link, unavailable source, stale version or unauthorized actor
   must not add an event or report success.
5. Assign responsibility, record a manual note and the next return date in the
   existing case. Manual contact notes do not attest delivery. Manual closure
   does not attest a receipt or a cancellation prevented.
6. Reconcile payment through the existing fresh exact invoice check. A promise
   remains a promise until its financial source is confirmed. Even a verified
   receipt alone does not demonstrate an incremental collection effect.

## Reproducible local gates

```sh
npm run typecheck
npm run lint
npm test
npm run test:staging
node --experimental-strip-types --test tests/billing.test.mjs \
  tests/billing-overview-route.test.mjs tests/promise-link-flow.test.mjs
```

The companion verification artifact contains the offline rendered-component
harness and its commands. It mounts the actual components and exercises actual
case handlers with memory persistence; it is **not** a browser or PostgreSQL
integration test. No production data or credentials are fixtures.

## Assisted-pilot acceptance still requiring real authenticated browser evidence

- Operator sees the right customer, safe code and incomplete-source warnings;
  creates a valid promise, copies its code and links the correct case.
- Another customer's code, absent record/source and stale/concurrent attempts
  cannot report a successful link. Repeat clicks do not duplicate events.
- Close/Back/navigation and late responses never reopen or change the wrong
  customer's case. Attendance navigation resolves the verified same customer.
- The consultation account cannot mutate; a legitimate stale operator form
  submitted after a role/session switch receives a server rejection. No session
  bypass or hidden API invocation is acceptable test evidence.
- A fresh login/reload preserves the audit history. No messages or IXC writes
  occur. Final results distinguish observed receipts, promises and manual notes.

Only after these gates pass should a supervised, explicitly authorized pilot be
considered. A causal lift or retention claim requires a defined eligible cohort,
baseline/control and observation window; raw collected amounts are insufficient.
