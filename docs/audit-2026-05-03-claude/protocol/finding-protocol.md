# Finding Protocol

Findings live in [../findings/register.md](../findings/register.md).

## ID Scheme

Use `A4-###` for this audit.

Examples:

- `A4-001`
- `A4-002`
- `A4-103`

Do not reuse IDs.

## Severity

Use [../findings/severity-model.md](../findings/severity-model.md).

Severity must account for:

- exploitability
- blast radius
- financial impact
- privacy impact
- integrity impact
- availability impact
- operator detectability
- likelihood of accidental regression

## Required Fields

Every finding must include:

- ID
- title
- severity
- status
- phase
- surface
- affected files with lines
- evidence references
- impact
- exploitability
- reproduction or reasoning path
- remediation
- verification after remediation
- cold-audit proof statement

## Filing Rules

- File one root cause per finding.
- Do not split one bug into many duplicate findings unless blast radius differs materially.
- Do not hide systemic issues inside a low-severity wording issue.
- Do not file a finding without a concrete code/config/doc/evidence reference.
- If a finding depends on external settings, record the external verification command and the operator owner.
