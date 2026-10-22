# Test-target configuration verification (2026-10-19)
- `exit_codes.txt`: numeric exit codes (v1-v9 controlled refusals, all 1; p1-p8 positive checks, all 0).
- `commands.txt`: commands run (password redacted as <pw>). `v*.txt` / `p*.txt`: captured output. `integration-junit.xml`: JUnit of the full run.
- Target for positive runs: twins_rehearsal_f2_fresh (synthetic writes only). v8 used the retained twins_rehearsal_fresh read-only (it was refused before any test ran).
- Credential scan of this directory: no match for the container password.
