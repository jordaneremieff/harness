# Local file exclusion

A writer owns exclusion through an open descriptor, not through file presence,
contents, age or a recorded process identifier. Local adapters use macOS
`O_EXLOCK` with read/write, create, nonblocking and no-follow flags. They make one
acquisition attempt. Contention refuses immediately. Unsupported platforms refuse
writes. Release closes the descriptor; process exit also releases the kernel lock.

The lock pathname and inode remain stable. Writers never unlink, truncate or
rewrite the lock, and never reclaim ownership through PID or age checks. Safe
hard-link aliases share the same kernel exclusion. Validate the regular file,
owner, private permissions, bounded size and named/descriptor identity. Creation
uses mode `0600`; acquisition requires read/write access and no group/other bits.
Unsafe attributes require inspection, not automatic deletion or permission repair.

Before a publication or retention namespace change, compare the held descriptor
and no-follow named device/inode synchronously. Missing, changed or unverifiable
identity poisons that lease and refuses the operation. Do not retry, recreate the
lock or remove shared temporary state after identity loss. Preserve actual partial
receipts and unpublished batches. A previously published file is not rolled back.

The identity check and namespace syscall are not atomic. An external unlink
between them still defeats exclusion. This is cooperative exclusion, not fencing
against another process that removes or replaces the path. Network and remote
filesystems are unsupported; adapters do not detect filesystem types.

Before a protocol change, retire every older writer and write-capable launcher
for the affected root. An old pathname owner does not hold the kernel lock. A
persistent inode refuses later old acquisitions but cannot fence an old writer
already inside its critical section. Selecting a release does not update loaded
processes. Rollback needs the same quiet boundary. Never delete a lock to restore
an older writer. Trials use private state roots before any write-capable hook runs.

Pillars and Memory own their slice-local implementations and tests. Rex supplies
existing evidence of the OS primitive; it does not own a shared lock service.
Extensions do not import sibling adapters. This convention does not prescribe
Agent host takeover or create a shared runtime library.
