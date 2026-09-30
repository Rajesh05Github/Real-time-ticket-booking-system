/**
 * Centralized Redis key builder (section 47). Every Redis key used
 * anywhere in FLASHSALE is built through a function here -- never a
 * string literal scattered in a service file. This is what makes it
 * possible to answer "what does this key mean, what's its TTL, who owns
 * it" from one place instead of grepping the whole codebase.
 *
 * Only two keys exist as of Phase 4 (OTP, session). Phase 7 onward adds
 * cache/counter/set/sorted-set/lock/stream keys to this SAME file, each
 * documented the same way -- see docs/redis.md for the full key registry
 * once those land.
 */
export const redisKeys = {
  /**
   * type: Hash -- fields { hash, attempts }
   * purpose: One-time password for email verification during registration.
   * TTL: OTP_TTL_SECONDS (300s, packages/shared) -- set on every write
   *      (initial send and resend), so a resend restarts the window.
   * owner: apps/api's auth module (write on register/resend, read+delete
   *        on verify).
   * cleanup: Self-expiring via TTL; also explicitly DEL'd by the service
   *          on successful verification or on exhausting OTP_MAX_ATTEMPTS,
   *          so a guessed-out code can't be retried after a key
   *          coincidentally hasn't expired yet.
   */
  otp: (userId: string): string => `otp:user:${userId}`,

  /**
   * type: String (empty value, existence is the signal)
   * purpose: Short cooldown preventing immediate OTP resend spam.
   * TTL: fixed 60s, set only on send/resend.
   * owner: apps/api's auth module.
   * cleanup: Self-expiring via TTL.
   */
  otpResendCooldown: (userId: string): string => `otp:user:${userId}:cooldown`,

  /**
   * type: Hash -- fields { userId, role, createdAt, lastActivityAt }
   * purpose: The actual session lookup used on every authenticated
   *          request (section 21). This is the fast path -- the
   *          corresponding Postgres `Session` row (docs/database.md) is a
   *          low-frequency audit/revocation index, not a duplicate of
   *          this data.
   * TTL: SESSION_TTL_SECONDS (packages/shared), set at creation. Not
   *      currently slid forward on activity (a fixed-lifetime session,
   *      not an idle-timeout one) -- see docs/auth-flow.md for why that
   *      was kept out of scope for Phase 4.
   * owner: apps/api's auth module.
   * cleanup: Self-expiring via TTL; explicitly DEL'd on logout.
   */
  session: (sessionId: string): string => `session:${sessionId}`,

  /**
   * type: String -- JSON-serialized public Event fields
   * purpose: Phase 6's cache-aside read path for GET /events/:eventId
   *          (section 4). Only ever populated with a PUBLISHED event's
   *          data -- see docs/event-browsing.md for why an admin's
   *          draft-inclusive view bypasses this cache entirely rather
   *          than risking a draft leaking into a shared cache key.
   * TTL: EVENT_CACHE_TTL_SECONDS (packages/shared), set on every write.
   * owner: apps/api's events module (write on cache miss and on every
   *        admin mutation's invalidation; read on every public detail
   *        fetch).
   * cleanup: Self-expiring via TTL; explicitly DEL'd on update/publish/
   *          unpublish so a stale cached copy never outlives the write
   *          that changed it.
   */
  eventCache: (eventId: string): string => `cache:event:${eventId}`,

  /**
   * type: String (value unused, existence is the signal) -- SET NX EX
   * purpose: Cache stampede protection. On a cache miss, the request
   *          that wins this lock is the one that queries Postgres and
   *          repopulates cache:event:{eventId}; everyone else who missed
   *          at the same moment waits briefly and re-checks the cache
   *          instead of all issuing the same Postgres query at once.
   * TTL: EVENT_CACHE_LOCK_TTL_SECONDS (packages/shared) -- short, since
   *      this only needs to outlive one Postgres query, not a whole
   *      request. A crashed lock holder self-heals via this TTL alone;
   *      nothing else waits on an explicit release to make progress
   *      (see event-cache.ts's fail-open retry loop).
   * owner: apps/api's events module.
   * cleanup: Self-expiring via TTL; explicitly DEL'd by the lock holder
   *          once it finishes repopulating the cache.
   */
  eventCacheLock: (eventId: string): string => `lock:cache:event:${eventId}`,

  /**
   * type: String -- integer, atomic via INCR
   * purpose: Generation number for the public GET /events list cache.
   *          Every cached list page's key embeds the generation current
   *          at the time it was written, so one INCR here (on any event
   *          update/publish/unpublish or venue change) makes every
   *          previously cached page unreachable at once -- no SCAN, no
   *          per-query invalidation bookkeeping.
   * TTL: none -- a tiny counter that must outlive the pages keyed on it.
   * owner: apps/api's events module (INCR on writes, GET on list reads).
   * cleanup: None needed.
   */
  eventListGeneration: (): string => 'cache:events:list:generation',

  /**
   * type: String -- JSON-serialized { events, total } for one public
   *       list query
   * purpose: Cache-aside for GET /events (anonymous/non-admin callers
   *          only -- an admin's list can include drafts and is never
   *          cached). `queryHash` is a SHA-256 of the normalized query.
   * TTL: EVENT_LIST_CACHE_TTL_SECONDS (packages/shared).
   * owner: apps/api's events module.
   * cleanup: Self-expiring via TTL; orphaned immediately by a
   *          generation bump (eventListGeneration above).
   */
  eventListCache: (generation: string, queryHash: string): string =>
    `cache:events:list:${generation}:${queryHash}`,

  /**
   * type: List -- each element a small JSON blob { id, type, createdAt }
   * purpose: Phase 7's "recent activity feed" (section 12) -- a fast,
   *          capped view over the Notification table (docs/database.md),
   *          NOT a second source of truth. If this list is lost (Redis
   *          restart without AOF, a bug, manual FLUSHALL), nothing is
   *          actually lost -- the durable record is still the Postgres
   *          row each entry references by id.
   * TTL: none -- bounded by LENGTH (LTRIM to
   *      NOTIFICATION_FEED_MAX_LENGTH), not by time. An inactive user's
   *      feed simply stops growing; it doesn't need to expire.
   * owner: apps/api's notifications module (LPUSH on every notification
   *        created elsewhere -- currently only auth.service.ts's OTP
   *        flow; more producers land as later phases add notification
   *        types).
   * cleanup: Self-bounding via LTRIM on every write; no TTL-based or
   *          explicit deletion.
   */
  notificationsFeed: (userId: string): string => `notifications:user:${userId}`,

  /**
   * type: Set -- member = watching user's id
   * purpose: Explicit, persistent "watch this event" action (section 15)
   *          -- deliberately NOT the same concept as a real-time "who is
   *          currently viewing" presence set (section 19), which belongs
   *          to the WebSocket/Pub-Sub connection lifecycle built in
   *          Phase 15/19. Watching is a user decision that persists
   *          across sessions; presence is tied to an open connection.
   * TTL: none -- persists until the user explicitly unwatches
   *      (SREM) or the event's data is removed entirely.
   * owner: apps/api's events module.
   * cleanup: Explicit SREM on unwatch. Not cleaned up on event
   *          unpublish/cancellation in this phase -- a watch persisting
   *          through a temporary unpublish is arguably correct behavior
   *          (the user is still interested), so this is a deliberate
   *          choice, not an oversight.
   */
  eventWatchers: (eventId: string): string => `event:${eventId}:watchers`,

  /**
   * type: String -- integer, atomic via INCR
   * purpose: Total view count for one event (section 17's counter
   *          example). Answers "how many times has this event's detail
   *          page been requested," independent of ranking against other
   *          events (that's event:trending, below).
   * TTL: none -- an all-time counter, not a rolling window.
   * owner: apps/api's events module (INCR on every non-admin detail
   *        view -- see event.service.ts's getEventForViewer).
   * cleanup: None. LOCAL DEVELOPMENT SIMPLIFICATION worth stating
   *          plainly: every view increments this, with no dedup by
   *          session/IP/time window, so it measures REQUEST volume, not
   *          unique visitors. A production version would either dedupe
   *          via a short-TTL per-viewer Set or accept an approximate
   *          count via HyperLogLog (PFADD/PFCOUNT) -- deliberately not
   *          built here; see docs/redis.md.
   */
  eventViewCounter: (eventId: string): string => `event:${eventId}:views`,

  /**
   * type: Sorted Set -- member = eventId, score = view count
   * purpose: Cross-event ranking (section 16) -- "which events are
   *          trending right now," answered by ZREVRANGE instead of
   *          fetching every event's counter and sorting in application
   *          code. The score currently mirrors eventViewCounter's value
   *          (both incremented together on the same view), kept as two
   *          separate structures because they answer different
   *          questions: "how many" (String) vs "how does it rank"
   *          (Sorted Set) -- see docs/redis.md for why one Redis
   *          structure can't cleanly serve both.
   * TTL: none -- a single global key, not one per event.
   * owner: apps/api's events module. ZINCRBY on every non-admin detail
   *        view; ZREM on unpublish (see event.service.ts's
   *        unpublishEvent) so an event stops appearing as "trending"
   *        the moment it's no longer publicly visible, symmetric with
   *        Phase 6's cache invalidation on the same action.
   * cleanup: Explicit ZREM on unpublish. A DRAFT event is never added in
   *          the first place, since recordEventView is only ever called
   *          from the already-PUBLISHED-only viewing path.
   */
  eventTrending: (): string => 'event:trending',

  /**
   * type: String -- integer counter, atomic via the fixed-window Lua
   *       script in packages/redis/src/rate-limiter.ts
   * purpose: Phase 8's request rate limiting (section 20) -- one key per
   *          (bucket, identifier) pair, e.g. bucket "login" + identifier
   *          "203.0.113.4" caps how many login attempts one IP can make
   *          per window. `bucket` is a fixed string per protected route
   *          (see packages/shared/src/constants/rate-limit.ts); `identifier`
   *          is currently always `request.ip`, never the request body (an
   *          attacker controls the body, not their own source IP as easily).
   * TTL: the bucket's own windowSeconds -- set once, on the request that
   *      creates the key (count goes 0->1), by the same script that
   *      increments it. Not reset on subsequent requests within the
   *      window -- this is a FIXED window, not a sliding one (see
   *      docs/rate-limiting.md for the trade-off this implies at a
   *      window boundary).
   * owner: apps/api's rate-limit plugin.
   * cleanup: Self-expiring via TTL. Nothing ever explicitly DELs this --
   *          unlike an OTP or a session, there's no "success" event that
   *          should end a rate-limit window early.
   */
  rateLimit: (bucket: string, identifier: string): string => `ratelimit:${bucket}:${identifier}`,

  /**
   * type: String (value unused, existence is the signal) -- SET NX EX
   * purpose: Phase 9's seat-claim ADMISSION CONTROL (section 59) -- reduces
   *          how often two concurrent requests for the same hot seat both
   *          reach Postgres at all. This is deliberately NOT the
   *          correctness mechanism: that's the partial unique index on
   *          reservation_items (see docs/database.md and
   *          docs/reservation-flow.md). If this lock were somehow bypassed
   *          entirely (a bug, a Redis outage), the worst outcome is more
   *          wasted transactions racing each other in Postgres -- never a
   *          double-booked seat, because the unique index still catches
   *          that regardless of what Redis did or didn't do.
   * TTL: SEAT_LOCK_TTL_SECONDS (packages/shared) -- short, since this only
   *      needs to outlive one claim transaction, not the reservation's
   *      whole hold period (RESERVATION_HOLD_SECONDS, ~10 minutes). A
   *      crashed lock holder self-heals via this TTL alone.
   * owner: apps/api's reservations module.
   * cleanup: Self-expiring via TTL; explicitly DEL'd (best-effort, blind --
   *          same as eventCacheLock's cleanup, no ownership token check)
   *          by the request that acquired it once its transaction attempt
   *          finishes, success or failure.
   */
  seatLock: (seatId: string): string => `lock:seat:${seatId}`,

  /**
   * type: Stream
   * purpose: Phase 10's outbox publisher target -- every OutboxEvent row
   *          apps/worker's publisher successfully XADDs lands here as one
   *          entry, fields { outboxId, aggregateType, aggregateId,
   *          eventType, payload (JSON string) }. Consumers read this via
   *          consumer groups starting Phase 11; nothing consumes it yet
   *          in Phase 10, which is fine -- unlike Pub/Sub, a Stream
   *          retains entries whether or not anyone is listening AT
   *          PUBLISH TIME (see docs/outbox.md for why that distinction
   *          is exactly why this is a Stream and not Pub/Sub).
   * TTL: none -- trimmed by approximate MAXLEN on every XADD
   *      (DOMAIN_EVENTS_STREAM_MAXLEN, packages/shared) instead of a
   *      time-based expiry, since "how much history" is a size/memory
   *      concern here, not an age one.
   * owner: apps/worker's outbox publisher (XADD only -- nothing in this
   *        codebase reads from it yet).
   * cleanup: Self-bounding via approximate MAXLEN trimming; no explicit
   *          deletion.
   */
  domainEventsStream: (): string => 'stream:domain-events',

  /**
   * type: Pub/Sub channel (not a key with a value -- PUBLISH/SUBSCRIBE
   *       don't store anything in the keyspace at all)
   * purpose: Phase 15's real-time viewer-presence broadcast -- "tell
   *          whoever's listening right now" (docs/redis.md's mental
   *          model, finally exercised for real). Every apps/api instance
   *          maintains ONE shared subscriber connection and SUBSCRIBEs
   *          to this channel for every event that has at least one
   *          locally-connected WebSocket client, so a viewer count
   *          change on ANY instance reaches every OTHER instance's
   *          locally-connected clients too -- see docs/pubsub.md for why
   *          this cross-instance fan-out is the entire reason Pub/Sub is
   *          needed here instead of just updating an in-memory counter.
   * TTL: not applicable -- a channel with no subscribers simply drops
   *      the message; there is nothing to expire because nothing is
   *      ever stored.
   * owner: apps/api's live-broadcast plugin (both publishes to and
   *        subscribes to this channel).
   * cleanup: not applicable.
   */
  eventLiveChannel: (eventId: string): string => `event:${eventId}:live`,

  /**
   * type: Set -- member = a random id generated per WebSocket connection
   * purpose: Backs the viewer count broadcast on eventLiveChannel above.
   *          Deliberately NOT the same Set as eventWatchers (Phase 7,
   *          keys.ts's own entry on that key already draws this
   *          distinction): watching is a persistent, explicit user
   *          decision that survives across sessions; this Set's members
   *          exist only as long as one specific WebSocket connection is
   *          open, keyed by a per-CONNECTION id (not userId) so two
   *          browser tabs from the same user correctly count as two
   *          viewers, matching "how many tabs have this page open right
   *          now" rather than "how many distinct people."
   * TTL: none -- membership is maintained explicitly (SADD on connect,
   *      SREM on disconnect), not via expiry.
   * owner: apps/api's live-broadcast plugin.
   * cleanup: Explicit SREM when a WebSocket connection closes. KNOWN GAP
   *          (documented, not fixed, in docs/pubsub.md): if the apps/api
   *          PROCESS crashes rather than one connection closing
   *          normally, its entries are never removed and inflate the
   *          count until... nothing -- there is no TTL-based self-healing
   *          here, unlike every OTHER ephemeral Redis structure in this
   *          codebase. A production version would need per-connection
   *          heartbeat keys with TTL instead of a plain Set; deliberately
   *          not built here to keep this phase scoped to the Pub/Sub
   *          fan-out lesson itself.
   */
  eventLivePresence: (eventId: string): string => `presence:event:${eventId}`,

  /**
   * type: Hash -- field = eventType (e.g. "order.paid"), value = lifetime
   *       count, incremented via HINCRBY
   * purpose: Phase 16's analytics consumer group -- a lifetime count of
   *          every domain event type this codebase has ever emitted onto
   *          stream:domain-events, read independently of (and completely
   *          unaffected by) the `notifications` consumer group reading
   *          the same stream. Deliberately generic like the notification
   *          consumer: every eventType increments its own field with no
   *          per-type branching, so a brand-new event type Phase 17+
   *          introduces starts appearing here with zero code change.
   * TTL: none -- an all-time counter, not a rolling window, matching
   *      eventViewCounter's precedent above.
   * owner: apps/worker's analytics consumer (HINCRBY only). Read-only for
   *        apps/api's analytics summary route.
   * cleanup: None -- see docs/pubsub.md's neighbor, docs/streams.md, for
   *          why an ever-growing lifetime counter is the right shape for
   *          this teaching example rather than a time-windowed one.
   */
  analyticsEventCounts: (): string => 'analytics:eventCounts',

  /**
   * type: Hash -- field = ISO currency code (e.g. "INR"), value = lifetime
   *       revenue in minor units, incremented via HINCRBY
   * purpose: Realized revenue rollup, built on top of analyticsEventCounts
   *          above but scoped to exactly one event type ("order.paid") --
   *          the only point in this codebase where money has definitely
   *          changed hands (an `order.created` event exists before
   *          payment even succeeds, so counting revenue there would count
   *          orders that go on to fail payment entirely).
   * TTL: none -- an all-time counter, same reasoning as
   *      analyticsEventCounts.
   * owner: apps/worker's analytics consumer (HINCRBY only, using the
   *        order's OWN amountMinor/currency carried on the order.paid
   *        outbox payload -- not the triggering Payment's amount, since a
   *        Payment can represent a retry attempt for the same order,
   *        while Order.amountMinor is the authoritative total). Read-only
   *        for apps/api's analytics summary route.
   * cleanup: None.
   */
  analyticsRevenueByCurrency: (): string => 'analytics:revenueMinorByCurrency',
};
