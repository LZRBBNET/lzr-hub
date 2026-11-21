# Restricted WhatsApp payment directions pilot

This is a directional preview for one already-approved tester, not a
payment/holder verifier or production financial release. It sends only fixed
copy from the code. It cannot query IXC, generate a bank-side Pix request,
read a title, emit boleto, send payment code, modify customer state, or call
an AI. It may read the tester's existing conversation/ticket routing state.

- Default disabled: FEATURE_META_OWNER_FINANCE_PILOT must be exactly true.
- FEATURE_META_OWNER_FINANCE_PILOT_PAUSED=true blocks it immediately.
- META_OWNER_FINANCE_PILOT_SENDER is one explicitly verified canonical phone.
- Use the existing META_PHONE_NUMBER_ID as the official recipient: it
  must match both the signed event and the configured Meta transport.
  An optional META_OWNER_FINANCE_PILOT_RECIPIENT can only narrow this ID;
  if set differently, no pilot response is allowed.
- META_OWNER_FINANCE_PILOT_STARTED_AT and META_OWNER_FINANCE_PILOT_ENDS_AT
  use explicit ISO UTC timestamps; maximum interval 2 hours. Events from
  before activation, after the cutoff, or with invalid signed routing
  metadata are not sent. Use the shortest reasonable operator window.
- With the pilot flag asserted, owner's unsupported finance/identifier-like
  messages are held, not handed to incumbent real financial processing.
  After the cutoff, newly sent post-window events return to pre-pilot routing.
  Re-deliveries originating during the expired pilot remain held and cannot
  fall through to incumbent live finance while the scoped config is retained.
  Existing non-finance routing and every other sender are unchanged.
- Do not send CPF, contract, barcode, payment receipt or real financial data
  in this pilot. Try a payment question, then reply by quoting the response
  with “Pix” (or “boleto”). A bare choice requires Meta delivery or an exact
  quote of the immediately preceding verified pilot menu. The two approved
  inbound phrases are normalized before persistence. Provider acceptance is
  only acceptance, not delivery. Do not claim live validation until observed.
- Owner/private/human state and the scope cutoff are rechecked before send.
  Duplicate inbound, duplicate anchored answer and uncertain send cannot
  trigger a retry. No migration is needed; existing operational locks
  and idempotency tables are reused. No shared flags are modified.
