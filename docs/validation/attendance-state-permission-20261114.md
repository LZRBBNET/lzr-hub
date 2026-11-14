# Attendance state controls: effective session permission

Corrects the UI gap characterized in #83, on a separate branch. The existing
backend policy is unchanged: POST /api/conversations/state authorizes support.write
before body parsing and DB access. RBAC grants that permission to authorized roles;
the read-only role has customer.read only. No new permission or grant is introduced.

The only production AttendanceModule call site is Screen in LzrHubApp. It now
passes a capability derived from authenticated session plus effective support.write,
and the existing admission generation/current predicate. Missing/unconfirmed
session fails closed. canReply is not used: it also depends on external transport.

Claim/release/resolve/reopen, resolve-without-claim, composer resolve and takeover
confirmation are gated. The action callback also refuses a stale, unmounted or
unauthorized context. Old response JSON cannot update state, toast success or
force a list refresh after admission/context replacement. This cannot retract a
request already sent; the backend remains responsible for authoritative access.

The existing admission controller rotates Screen's key when actor or permissions
change. No new polling, session API or backend policy was added. Two focused
renderer regressions exercise the actual shell: read-only exposes no controls;
authorized transport-disabled claim works, then permission loss remounts the
context and discards a captured old callback and already-started late JSON.
An additional regression checks same-permission readmission during JSON decoding:
the outdated result is ignored but its still-mounted operation stops being busy.
Request identity prevents an older operation from clearing a newer operation.
Existing admission regressions cover permission/context rotation separately.

Browser acceptance replaces H02 characterization: at 1440/390px, read-only open,
owned and resolved fixtures expose no state action controls and make zero state
requests. H01 keeps summary/context/owner and claim/resolve/reopen assertions with
transport disabled even for the authorized writer. All APIs/data remain doubles;
these checks do not prove backend denial of forged requests, cookies, persistence,
external delivery or human visual approval. No real messages are sent.

The #83 document remains historical evidence of the original gap. This increment
does not change product transport, backend authorization, dependencies or workflow.
