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

Exclusion holds only among writers that use this protocol. A writer that does
not use the protocol is not excluded. Writers never remove the persistent lock
file.

Pillars and Memory each own a slice-local lock adapter and its tests.
Adapters do not import siblings. There is no shared lock library.
