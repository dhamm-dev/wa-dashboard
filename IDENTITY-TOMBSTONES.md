# Identity tombstones

Each tombstone is SHA-256 over the UTF-8 bytes of `dhexbot:identity-tombstone:v1:<type>`, a zero byte, and the identity. The `google` identity is the exact Google subject; the `email` identity is the email credential address after JavaScript `trim().toLowerCase()`, matching email authentication. The types occupy separate domains. User profile email addresses are not email credentials.

These deterministic hashes are not anonymous: someone who knows or guesses an identity can calculate and match its hash. Tombstones contain no passwords or password hashes. Existing revoked users are backfilled from identities still present, and existing revoked Google subjects are backfilled directly. Identities already removed before this migration cannot be recovered from those records.
