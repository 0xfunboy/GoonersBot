# Resource budget and safe activation

The default companion governor reserves two in-process slots for interactive replies. Heavy
lanes additionally coordinate between bot/worker processes of the same OS user through private
kernel `flock` slot locks in `/tmp/goonerbot-resources-<uid>`: subprocess/media/generation 2 each,
browser/mining 1 each. A tiny pipe-bound lock holder exits when the owner releases its pipe
or dies; the kernel releases the lock without unsafe stale-file deletion or PID-reuse races.
An active lease is not stolen merely because an operation runs slowly. Linux requires the
standard `flock` and `cat` utilities; non-Linux keeps the process-local concurrency limits.

Heavy admission waits while Linux `MemAvailable` is below max(512 MiB, 6% RAM), memory full
PSI avg10 reaches 10%, or working/tmp filesystems have less than 512 MiB available. Waiting
is bounded and abortable; interactive and lightweight network work remain available. This
does not modify swappiness, systemd units or other applications on the workstation.

`runProcess` additionally applies actual Linux `prlimit` CPU time (up to 600 seconds by
default), individual file size (2 GiB), no core dumps and 1024 open-file limits. `setpriv`
sets SIGKILL on parent death for the direct child. A 1-second watchdog sums RSS over the
actual detached process group and kills the group above min(2 GiB, 15% RAM), with a 256 MiB
floor; it also stops work at critical host RAM/disk reserves of 256 MiB. Existing wall-time,
abort, stdout and stderr bounds remain in force. Trusted callers may set tighter budgets.

Limitations are explicit: RSS is sampled, not a cgroup hard ceiling; CPU/file limits are
inherited per process/file, not an aggregate cgroup quota. Parent-death SIGKILL applies to
the direct child, not independent daemons that escape its process group. These safeguards
cover callers of the common governor/process helper, not arbitrary direct spawns elsewhere.
The separate Firefox service retains its existing process-tree watchdog and session
rotation; a service `MemoryMax` alone still does not cover Snap Firefox's escaped scope.
Non-Linux hosts retain admission and wall/output limits, but do not get Linux kernel limits.

Verification uses mocked host pressure, independent coordinator instances sharing a lease
directory, and a real 1 KiB file-size limit. It never stress-tests RAM/swap or changes live
Firefox sessions. Production activation still requires the normal rebuild/restart procedure.
