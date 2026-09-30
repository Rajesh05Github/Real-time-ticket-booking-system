# Tickets (Phase 14)

The last step of the checkout chain: turning a `PAID` order into
`Ticket` rows. Small in scope compared to Phase 13, but it's where the
project's discipline around "commit the business change atomically with
whatever it implies" gets applied one more time — and where a genuinely
broken piece of the Phase 3 schema finally got exercised for the first
time and turned out not to work at all.

## Where issuance happens, and why

Ticket issuance is wired directly into Phase 13's `applyPaymentSucceeded`
transaction (`order.repository.ts`) — not a separate step, not an async
job. The same "no world where X exists without Y" reasoning that governs
every multi-write transaction in this codebase applies here too: there
is no world where an `Order` is `PAID` with zero tickets, and no world
where a `Ticket` exists for a payment that ultimately rolled back.

This is also a case where NOT reaching for a queue is the right call
(section 58). Issuing a `Ticket` row per seat is a fast, purely
in-database operation with a real correctness invariant already sitting
in Postgres since Phase 3 (`tickets_active_reservation_item_unique`) —
nothing about it benefits from being deferred to `apps/worker`, unlike
sending an email (real external I/O, needs retry/backoff) or generating
50,000 seats (too slow for one request). Reach for async/queued work
because a task's shape needs it, not by default.

## Idempotent by construction, not by new logic

`applyPaymentSucceeded` only ever runs past its own `WHERE status =
'PENDING'` guard on a Payment once (Phase 13) — a redelivered or
duplicate webhook short-circuits before ever reaching the ticket-issuing
code. Ticket issuance inherits that guarantee for free: there was no new
idempotency mechanism to design for this phase, only a `createMany`
inside a transaction that's already provably single-fire.

## The ticket number

A ticket needs a public-facing code distinct from its internal UUID —
what a QR code encodes or a support agent reads back to a caller.
`generateTicketNumber()` draws from a deliberately curated 32-character
alphabet that excludes `I`, `L`, `O`, and `Q` — the classic
easily-confused-out-loud-or-on-a-low-res-screen characters (0 vs O, 1 vs
I/L). 32 is not an arbitrary count: it's a power of two, so `byte & 31`
maps every value a random byte can take onto the alphabet with exactly
uniform probability — no modulo bias to reason about, unlike a
79- or 30-character alphabet would need.

12 symbols from that alphabet is `32^12` (~1.15 × 10^18) possible codes.
No retry-on-collision loop exists for the same reason none exists
anywhere in this codebase for Postgres's own `gen_random_uuid()`
primary keys: at this entropy, treating a collision as impossible is the
standard, correct engineering call, not a corner cut. (`ticketNumber` is
still `@unique` in the schema — if the impossible ever happened, the
`createMany` would fail loudly and roll back the whole payment-success
transaction, rather than silently issuing a colliding ticket.)

## A real, load-bearing schema bug this phase found

`Ticket.seatId` has existed as a plain scalar column since Phase 3, with
a comment explaining it was denormalized specifically to "skip a join
through ReservationItem... to show which seat it is." What it never had
was an actual Prisma relation — every OTHER reference on this model
(`userId`, `eventId`, `orderId`, `reservationItemId`) is backed by a
real `@relation`; `seatId` alone was just a bare UUID column pointing at
nothing as far as Prisma's schema was concerned.

This sat unnoticed for eleven phases because nothing had ever actually
tried to read a ticket's seat details until this phase's own `GET
/tickets/:id` did — writing `include: { seat: true }` and getting back
a hard `PrismaClientValidationError: Unknown field 'seat' for include
statement on model 'Ticket'`, live, immediately. The comment's own
stated purpose (skip a join to show the seat) was **impossible to act
on** without the relation the schema never actually had — a caller
wanting seat details still needed a second, manual query, exactly the
join the denormalization was supposed to avoid.

Fixed with a real migration (`20260901124517_ticket_seat_relation`):
added `Seat.tickets Ticket[]` and `Ticket.seat Seat @relation(...)`,
plus the FK and index every other reference on this model already had.
Applied cleanly against the two ticket rows created during this phase's
own live testing — their `seat_id` values already pointed at real,
existing seats, so the new foreign key constraint had nothing to
reject.

This is the third schema gap this project has found by actually
building the feature that exercises a field, rather than by reviewing
the schema in the abstract: Phase 12 found `reservationExpiryQueue`
missing from `app.ts`'s shutdown hook, Phase 13 found
`Payment.providerRef` was never `@unique`, and this phase found
`Ticket.seatId` had no relation at all. The pattern holds: a schema
written five phases ahead of the code that uses it is a reasonable way
to plan, but it doesn't substitute for actually running the code once
it exists.

## Endpoints

`GET /tickets` (mine) and `GET /tickets/:id` (owner or admin) — read-only
by design this phase. `GET /orders/:id` also now returns the order's
`tickets` array (empty until payment succeeds, confirmed live: querying
an order immediately after creation showed `"tickets":[]`; the same
order a few seconds later, after the mock provider's webhook fired,
showed two fully-populated `Ticket` rows, one per seat).

## What Phase 14 deliberately does not include

> **Update:** ticket cancellation (via cancelling a paid order, with refund) has since been built -- see [checkout-lifecycle.md](checkout-lifecycle.md). The web app also renders the ticket number as a QR code.

- **Ticket cancellation.** The schema supports it (`TicketStatus.
  CANCELLED`, and the partial unique index is explicitly scoped to
  `status = 'ISSUED'` so a cancelled ticket can coexist with a later
  reissued one for the same seat) but nothing calls it yet — there's no
  refund flow for it to hang off of (Phase 13 explicitly deferred that),
  and building cancellation with nothing driving it would be
  speculative.
- **QR code generation or any rendering of the ticket number.** Out of
  this project's scope entirely — `ticketNumber` is the data a QR code
  or printed ticket WOULD encode, not something this API renders.
- **A `ticket.issued` outbox event per ticket.** `order.paid` (Phase 13)
  already reaches the buyer's notification feed once per order; nothing
  yet needs per-ticket-level event granularity, and adding it without a
  real consumer would be exactly the kind of complexity section 58
  warns against.
