# Synthetic payment UI increment

Stacked on the sandboxed browser harness in #80. Product components and compiled
CSS are real; API responses are fictitious in-memory doubles. This does not test
handlers, cookies, database persistence, IXC, transport or payment execution.

Fourteen additional browser assertions at 1440 and 390 CSS pixels:

- C02, three cases per width: empty invoice page explicitly scoped to that page;
  unknown total/value remain unconfirmed rather than zero; HTTP 503 shows only
  the generic failure and no private error, empty result or total. Reads remain
  opt-in and failures do not automatically retry.
- C03, two cases per width: switch from customer A to B during payment transport
  or after headers while JSON is held. Confirm abort, deliver the stale response
  or body, wait delivery and two render frames plus a task, then assert B remains
  selected and stale payment data is absent. Narrow layout closes A before B.
- C04, two cases per width: close during transport or held JSON, deliver stale
  data and assert detail remains closed. Reopen A and assert no replay or stale
  result; explicitly request again and confirm a fresh empty page.

The existing thirteen cases remain. A fifth Node harness contract verifies that
JSON is actually held after headers and that body acknowledgement waits for the
delivery/render barrier. The persistent error ledger, cleanup and mandatory
sandbox gate remain unchanged. No workflow, dependency or product changes.

This is automated DOM/state QA, not manual visual approval or persistence E2E.
The finite frame/task barrier does not prove absence of arbitrarily delayed work.
S02/S03, other payment error variants, handoff and billing remain outside this
increment. No screenshots or artifacts are uploaded. CI results belong to the
specific head/merge recorded in the draft PR.

Independent read-only review found no blocker. Switching/closing unmounts the
keyed payment state: these cases prove no visible stale-data leak in the composed
UI, not isolated coverage of every post-JSON guard in a still-mounted component.
They do not cover actual pagination or backend ownership validation.
