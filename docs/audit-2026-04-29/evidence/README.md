# Evidence Convention

Create one folder per phase during execution:

- `phase-0-inventory/`
- `phase-1-governance/`
- ...
- `phase-19-signoff/`

Each phase folder should contain:

- `notes.md`: dated narrative notes, evidence refs, findings discovered
- `artifacts/`: large command outputs, JSON, logs, grep dumps, schema dumps

Rules:

- every evidence file records capture date/time and commit SHA
- evidence is append-only while a phase is active
- large outputs belong under `artifacts/`
- no secrets, tokens, or PII
- corrections after phase close go in `tracker.md`, not by rewriting old notes
