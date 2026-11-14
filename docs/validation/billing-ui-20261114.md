# Billing UI acceptance with explicit doubles

Increment on #84. Eight cases: B01–B04 at 1440/390px, using the real shell,
BillingActions/PaymentPromisePanel/RuleBuilder/DispatchPanel and compiled CSS.
Every API is an in-memory response double. Unknown APIs (including reissue POST,
renegotiation, exports and transport) are rejected into the persistent error ledger.

| Case | Verified in client | Supplied by fixture, not verified as server behavior |
| --- | --- | --- |
| B01 | Fill invoice/customer/date, submit exact create payload; no success before response; render pending promise after response/refetch and no-send notice. | Creation/storage/audit of promise. Date input uses native DOM value setter/events; other controls use WebDriver. |
| B02 | Navigate to rule, render candidates changing from 1 to 0, submit run, render zero candidates and queue-off/no-delivery notice. | Promise eligibility/pause, pausedByPromise=1, ledger=0 and enqueued=0. pausedByPromise is NOT displayed by current UI. |
| B03 | After explicit paid-fixture preparation, click existing review control; verify review payload, fulfilled count, empty pending list and zero candidates on rule remount. | Payment/fulfillment/exclusion decisions. There is NO payment button. preparePaid is setup, not an invented interaction or real demo endpoint. |
| B04 | Render outside-hours warning, then replace it with queue-disabled result on next explicit run; exact run payload, zero enqueue in supplied responses. | Business-hour calculation, record/queue counts. Clock is a fixture variable, not system/browser Date; response branches are explicit. |

The saved rule is prepared by fixture; this increment does not test saving a rule.
UI labels retain IXC/ledger language from the product; they do not imply a real
IXC call or persisted ledger. No payment proof, queue job or message is produced.
Within each scenario, hash navigation preserves only the in-memory fixture;
unique query strings create fresh documents for the next scenario. A ninth Node
contract checks held create response, delivery/frame barrier, fixture state/clock
reset and forbidden-write ledger persistence across document replacement.

The first CI attempt passed all desktop billing cases, then a narrow-screen tab
click was intercepted by the fixed header after form scrolling. The harness now
scrolls the tab to the center and waits two frames before the native WebDriver
click. It does not use JavaScript click, change CSS, or bypass hit testing.

## Reconciliation of the original 16-case matrix

The evidence below distinguishes automated client acceptance from backend tests
and deployed acceptance. No browser run here is human visual approval or DB E2E.

| Matrix item | Current UI evidence / remaining boundary |
| --- | --- |
| L01 | Valid/invalid mocked login and navigation passed (#80); real cookies/auth persistence remain homologation work. Pending/double-submit variants not claimed. |
| L02 | Geometry at 320/390/768/1440 and forward Tab passed (#80); complete keyboard/a11y and human visual review remain. |
| C01 | #85 did not separately accept search/debounce. The subsequent focused gate is documented in [customer-search-ui-20261114.md](customer-search-ui-20261114.md); original 10/501/901 backend scenario remains distinct. |
| C02 | Empty/unknown/error payment pages without false zero passed (#81); invoice-page scope explicit. |
| C03 | Late detail and payment transport/JSON switching passed (#80–81); not every late error variant. |
| C04 | Close/reopen and late payment body discard passed (#80–81); complete keyboard/focus audit not claimed. |
| S01 | Invalid initial mocked admission/navigation passed (#80); old-document completion explicitly not asserted. |
| S02 | auth-me503 and manual reload recovery passed (#82), no logout inference. |
| S03 | Shared readmission, same/new actor, permissions and obsolete origin passed (#82); backend identity remains separate. |
| S04 | Mock logout503/retry and stale UI suppression passed (#80); real cookie revocation remains. |
| H01 | Summary/context/owner and explicit transitions passed (#83–84), writer works with transport disabled; AI text is fixture content. |
| H02 | Product UI gap corrected in #84; read-only open/owned/resolved has no controls/requests at both widths. Backend denial is not inferred from this UI. |
| B01 | Client contract above; persistent promise/audit not inferred. |
| B02 | Client contract above; actual pause/ledger/dedup not inferred. |
| B03 | Client contract above; paid state is explicit fixture setup, not a payment UI or persisted payment. |
| B04 | Client contract above; scheduler business hours are not executed in the client. |

Existing server-side evidence was already included in #84's green aggregate
suite (run 43557953761), without new isolated reruns for this increment:
- payment-promise.test.mjs exercises promise evaluation/review and memory repo;
  unified-promise-pause.test.mjs checks common pause semantics.
- collection-dispatch-route.test.mjs executes the actual application handler
  with memory repositories/fake source: promise added after preview, fresh paid
  invoice exclusion, readonly/anonymous refusal, changed authorization before
  ledger, and malformed evidence refusal. It also documents a residual race
  handled by the consumer. This is handler integration, not PostgreSQL E2E.
- collection-dispatch.test.mjs executes business-hour/candidate functions and
  memory ledger dedup, payment exclusion and queue-disabled behavior.
- conversation-state.test.mjs and conversation-composer-permission.test.mjs
  cover service transitions/identity and handler capability behavior with doubles.
- Four artifact checks exercise compiled Node boundaries without a real DB;
  they do not replace authenticated operational journeys or migrations.

Practical remaining homologation gate: one isolated, authorized disposable DB/app
journey proving real login/cookie revocation, persisted promise/audit/dispatch
consistency and synthetic payment across reload/restart, plus human desktop/mobile
review of the priority screens. Deployment/workspace selection and DB
reconciliation belong to coordination; no new infrastructure or cost is created.
These are acceptance boundaries, not a proposal to expand an endless UI test list.
