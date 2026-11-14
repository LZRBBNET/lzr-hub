# Synthetic readmission UI increment

Stacked on #81. Real LzrHubApp, Customer360Module, InvoicePaymentPages and compiled
CSS; every session/customer/payment API response is an explicit in-memory double.
No cookies, handlers, database persistence, IXC or real accounts are exercised.

Ten additional cases, five at each viewport (1440 and 390 CSS pixels):

- S02: a current detail 401 initiates auth-me; auth-me 503 removes protected UI
  and shows manual recovery without navigation to login, logout request or removal
  of the fictitious session marker. Click the actual reload button; the next
  document admits successfully, without detail replay. Explicit selection works.
- S03 shared/same actor: two invoice reads return 401 while both origins remain
  mounted; exactly one additional auth-me request serves both. Same-actor success
  does not repeat detail/payment reads. A new explicit payment request works.
- S03 actor change: one payment JSON is held, another invoice 401 initiates
  readmission with a new actor. Prior detail is discarded, late body is delivered
  and cannot repopulate it; menu shows the new fictitious actor. Explicit selection
  starts fresh, with no inherited payment page.
- S03 permission change: same actor loses support.write but keeps customer.read.
  The same old-state/late-body assertions apply. This checks context replacement,
  not the whole permission-to-navigation matrix or backend authorization.
- S03 obsolete origin: current detail 401 starts auth-me; its invalid-session
  JSON is held. Select customer B (closing the modal first on mobile), confirm B,
  then deliver invalid JSON. B remains and no login/logout or automatic read occurs.

The fixture has two invoices to exercise shared admission with independent live
payment origins. A sixth Node contract checks that session JSON is genuinely held
after headers and that acknowledgement waits for body delivery plus two frames
and a task. Existing persisted error ledger, process cleanup, mandatory sandbox
gate and workflow remain unchanged. Case navigation uses unique query strings.

Limits: automated browser DOM/state checks, not manual visual approval or E2E.
Finite render barriers cannot exclude arbitrary future work. Recovery uses a
fictional localStorage marker, not a server cookie; no cookie-security inference.
The increment does not cover mid-session polling, every role/permission variant,
or late work surviving a destroyed document. Handoff/billing remain out of scope.

Independent review identified a possible false positive if the second invoice
stayed busy after 401. Both panels now must show the unconfirmed state and enabled
query buttons before and after shared admission; checking only the first invoice
would not establish that both origins completed their failure handling.
