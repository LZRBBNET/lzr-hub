# Synthetic handoff UI increment

Stacked on #82. Real AttendanceModule/LzrHubApp and compiled CSS, explicitly
fictitious conversation, session, summary and state API responses. Non-phone
conversation ID avoids customer lookup and delivery reconciliation. No send,
clipboard, notification, IXC, database or transport integration is exercised.

H01 runs at 1440 and 390 CSS pixels: open a recorded fictional AI handoff; inspect
customer context and the suggestion explicitly marked unsent; request a summary
and verify the actual request identifiers/action before delivering the fictional
summary. It neither populates the composer nor adds an agent message. Inspect
unassigned responsibility, claim, verify named owner, resolve and reopen. Each
native click must submit exactly the expected request, leave displayed state
unchanged while response is held, then display the explicitly supplied outcome.
This verifies UI wiring/rendering, not the correctness of server transitions or
AI summary generation. No outbound message is sent.

H02 is a characterization with an OPEN PRODUCT GAP, not full acceptance:
customer.read without support.write and canReply=false hides the composer, but
state action controls are still offered. At both widths, clicking Assumir sends
a state request; a fictional 403 is displayed and ownership stays with AI. That
403 is fixture behavior and proves nothing about backend denial of forged actions.

Static defect evidence: AttendanceModule's chat-actions render Assumir/Resolver/
Reabrir without a write permission check; changeState only checks selected item
and busy. Composer independently checks channelState.canReply. The real state
route calls authorize(request, 'support.write'), but it is NOT executed here.
No product correction is included; review a separate minimal capability contract
before expanding scope. canReply also depends on transport configuration, so it
must not be blindly reused as a state-mutation permission.

The fixture never changes ownership on request alone: tests explicitly release
responses. A seventh Node contract verifies that boundary, delivery/frame waits,
and persistence of unexpected-send errors across document replacement. Unknown
handoff APIs are rejected and recorded even if product code catches the failure.
Existing sandbox, persistent error ledger, unique-document cases and cleanup stay
in place; no new dependency/workflow. Automated DOM/state QA is not human visual
approval, backend authorization, persistence E2E or delivery evidence.

The first browser attempt exposed an incorrect harness assumption: responsive
CSS hides header status pills/badges on narrow screens. Narrow cases now inspect
the visible facts panel for handoff/ownership/state; header textContent only
checks underlying DOM state, not visual visibility. No product CSS was changed.
An eighth Node contract verifies the reader's actual customer.read permission
and false reply capability.
The panel's finite slide-in animation is awaited before the WebDriver displayed
assertion; checking immediately after the click failed during its entrance.
