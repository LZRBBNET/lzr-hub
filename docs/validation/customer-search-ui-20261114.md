# C01 — customer search UI, 2026-11-14

Increment over #85 (`26d7397ae57a9ca9ef9e220b12f7414717adb436`). Real
Customer360 component and compiled CSS, explicit fictitious API responses.
No product, dependency, workflow, TLS or infrastructure changes.

Six browser checks, three at each width (1440 and 390):

- Native keyboard enters `cad & 810002`. Exactly one noninitial list request
  carries the complete decoded query, risk=all and page=1; timestamp follows
  the last input by at least 330ms (350ms product debounce, scheduling tolerance).
  Only the matching fixture row is rendered. This verifies request encoding and
  UI response rendering, not server-side search matching.
- Empty response renders the empty notice without old rows; 503 renders the
  error notice, not the empty-result notice. A later successful query recovers.
- Hold the old query, deliver the new query, select its row and load its real
  detail component. Then deliver and consume the obsolete list JSON, wait two
  frames and one task, and assert both list and selected detail still show the
  current customer. The fixture deliberately returns the obsolete response;
  the product is responsible for discarding it.

A harness contract verifies that release cannot complete before JSON consumption
and frame barriers, that both old and current requests are actually delivered,
and that duplicate release fails. Existing document-persistent error ledger,
loopback CSP, sandbox probe and cleanup remain in force. Test-only query flag
isolates the list fixture from all existing cases. No controlled system clock.

Local: 10 harness contracts passed; bundle/compiled CSS/loopback build-only check
passed and closed its server. Browser acceptance requires the existing sandboxed
CI run; local build-only is not browser evidence. Independent review and remote
result are recorded in the draft PR/report.

Matrix reconciliation: C01 search/debounce/empty/error/obsolete-list handling is
the only added gate. Its fixtures use 810001/810002 rather than the historical
10/501/901 backend scenario. All other matrix rows and their evidence remain
as documented in billing-ui-20261114.md. No IXC search, handler, database,
cookie, persistence E2E or human visual acceptance is inferred.

Essential remaining acceptance boundaries: authorized integrated HTTPS/browser
and disposable DB journey (TLS trust and workspace decisions remain with
coordination), plus human review where required. No additional UI test campaign
is proposed by this increment.
