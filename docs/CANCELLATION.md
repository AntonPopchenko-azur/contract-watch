# Live capture cancellation

Implemented 2026-10-12 for `snapshot` and `snapshot-many`. There are no new
flags, config fields, snapshot/report versions, watch loop, history directory,
provider-wide queue or resume mechanism. Offline inspect, diff and migrate keep
their existing behavior and do not install these signal handlers.

## Lifetime and completion point

After parsing a live command, before config/env/RPC/output work, install one
SIGINT handler and one SIGTERM handler for the invocation. Allow one event-loop
turn for pending signals, then check the shared AbortSignal before starting.
Signals before handler installation use the operating system's normal behavior;
this includes process startup/imports and invalid command syntax.

The first **handled** signal before completion wins: SIGINT gives exit **130**,
SIGTERM **143**. Later signals do not change that status or bypass draining.
Never call process.exit while jobs or cleanup remain. Cancellation produces no
stdout, no partial text report and no JSON outcomes. Stderr is exactly one of:

```text
Error [CAPTURE_CANCELLED]: Capture cancelled; owned output was removed.
Error [CANCEL_CLEANUP]: Capture cancelled; output cleanup was incomplete. Inspect the destination before reuse.
```

Neither error contains paths, names, config/env references, RPC URLs, provider
errors, filesystem errors, stacks or AbortSignal.reason. CANCEL_CLEANUP preserves
the first signal's exit status and means that output may remain and needs manual
inspection. It is not evidence of a successful rollback.

The **commit point** is the synchronous assignment in `runLive` after all target
jobs/writers, report construction, handle closure, one final event-loop turn and
cancellation check, immediately before the complete stdout write. There is no
await between commit and that write. A handled signal before the point rolls
back this invocation, even if all target files have already been linked. A
signal handled during the synchronous output call after commit cannot undo the
result. Handlers are then removed; later signals use normal process behavior
and may stop output delivery, but committed files remain. This is an application
completion point, not a promise that a pipe consumer received every stdout byte.
The existing broken-pipe exit policy is unchanged.

When a signal and an RPC error/deadline coincide, a signal handled before
completion decides the CLI outcome. The internal capture policy still gives
CAPTURE_DEADLINE priority over simultaneous read/wait errors, preserving its
budget contract; the invocation checks cancellation outside that policy.

## Request, queue and writer drain

Every active target uses the same invocation signal: shared leader resolution,
its subsequent capture, admitted followers, independent targets, chain/genesis
reads, block resolution/rechecks, storage, target/implementation code and the
bounded beacon call. The signal is internal runtime state, never persisted.

An abort destroys the HTTP request even while waiting for headers or receiving
a partial body. Clear its timeout and await request close before rejecting or
releasing capacity; remove the abort listener on settlement. No later read,
retry, replacement anchor or target starts. Backoff and bounded Retry-After use
the same abortable promise timer, whose abort removes its timer/listener.

The ready queue stops admission and checks again immediately before an admitted
job starts. Queued targets and shared followers do not read env or issue RPC.
Started jobs drain before the batch promise settles, including jobs awaiting
filesystem operations. Cancellation is never converted into an ordinary failed
outcome or an unavailable shared group followed by more dispatch. The scheduler
removes its abort listener on completion or failure. Signal handlers remain
installed during drain/rollback and are removed on every handled exit path.

File writes accept the signal and check around open/write/fsync/close/link.
Filesystem syscalls already submitted cannot all be cancelled. Await each one;
if a link succeeds while abort is pending, record the owned destination before
checking the signal. Cleanup therefore sees that file. No background writer is
left running after the cancellation response. Waiting for a hung filesystem,
DNS/transport close or a blocked event loop is not subject to a hard cleanup
deadline; repeated signals do not force exit. SIGKILL terminates without cleanup.

## Ownership and rollback

Live commands keep a bounded journal of only this invocation's exclusive new
temporary files, successful no-overwrite hard links and new batch directory.
Record device/inode and mode using bigint stat data. Files also record size and
nanosecond modification time. Keep a read handle to pin each file's inode until
work drains; closing the write handle still precedes publication and its failure
is a per-target FILE_WRITE. At most 64 file handles (one write handle and one
retained read handle per selected target, including failed closes) are needed.
Failure to close retained handles prevents normal completion and produces a
safe FILE_WRITE global error, or CANCEL_CLEANUP if interrupted. Ordinary files retain mode 0600 and directories 0700.

Before publication, verify the parent directory and temporary inode. Rollback
checks the parent directory's identity and each file's identity/metadata before
unlinking its recorded name. A missing owned filename needs no unlink. Never
register a destination after a failed link (including an existing file/link).
Never follow a substituted batch-directory symlink to publish queued output.
Remove the owned batch directory only after checking its parent and identity,
using nonrecursive rmdir. An added file causes ENOTEMPTY and remains untouched.
No glob, directory sweep, recursive remove, overwrite or cleanup of an earlier
run is performed. Single capture never owns or removes its preexisting parent.

If a file is replaced, modified, inaccessible or cannot be identified, leave it
alone and continue attempting cleanup of the other journal entries. A directory
substitution likewise prevents unsafe cleanup through that path. An I/O error,
unknown ownership after creation, failed handle close or failed removal causes
CANCEL_CLEANUP. Renamed files/directories are not searched for; they may remain.
A failure to remove temporary output on an ordinary target failure does not
permit deleting an unverified path later. Cancellation retries its journaled
cleanup with the same identity checks.

Under ordinary local filesystem operation in unchanged trusted directories, a
handled signal before commit leaves **no partial published snapshot set from
this invocation**, including earlier saved members. This is rollback on handled
cancellation, not all-or-nothing visibility during capture. Ordinary env, RPC,
deadline and write failures still produce per-target outcomes, retain successes
and the batch directory, and continue the ready queue. Snapshot v1/v2/v4, batch
v1/v2, ordinal order and offline reuse are unchanged.

## Filesystem and failure limits

Use a local filesystem supporting same-directory hard links and directories you
control. Identity checks and unlink/rmdir are separate syscalls: Node does not
provide an atomic conditional unlink by inode. Parent creation/identification
and closing retained handles also have race windows. These checks detect stable
substitutions; they do **not** establish safety against a hostile process racing
path swaps, inode reuse, metadata forgery or modification during a write.
Do not mutate a destination while a capture is running. User-added/replaced files
encountered by the checks are preserved rather than recursively removed.

SIGKILL, native crashes, machine shutdown/power loss, signals before handler
installation, hung filesystem I/O and blocked event loops fall outside prompt
rollback. Temporary files, partial sets and absent reports can remain. There is
no durable journal, startup recovery or directory-fsync/crash-atomicity promise.
A filesystem cleanup failure necessarily prevents the normal no-leftovers
postcondition and is reported explicitly. Re-running a batch still requires a
new destination; inspect any interrupted destination before manual removal.

## Verification and references

Regression tests use only loopback servers, disposable directories and real
child CLI SIGINT/SIGTERM. IPC barriers position interrupts at config, request,
backoff, 30-second Retry-After, mkdir, open, partial write, fsync, close, link and
temporary cleanup boundaries; repeated signals are sent before releasing file
work. Tests cover shared anchors/followers, concurrency 1/2/8, earlier saved
files, cancellation/deadline precedence, transport/listener cleanup, collisions,
substituted/modified/user-added files, cleanup I/O failures, commit-point behavior
and ordinary failure/success compatibility. Existing protocol/format suites
remain authoritative for pins, budgets and strict offline formats.

Runtime behavior was checked against the official Node.js documentation for
[signal events](https://nodejs.org/docs/latest-v22.x/api/process.html#signal-events),
[HTTP request destruction and close](https://nodejs.org/docs/latest-v22.x/api/http.html#requestdestroyerror),
[abortable file writes](https://nodejs.org/docs/latest-v22.x/api/fs.html#filehandlewritefiledata-options),
[unlink](https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromisesunlinkpath) and
[cancellable timers](https://nodejs.org/docs/latest-v22.x/api/timers.html#timerspromisessettimeoutdelay-value-options).
The completion point, rollback ownership checks and error policy are local
application contracts, not additional guarantees made by Node or a filesystem.
