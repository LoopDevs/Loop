# Phase 23 - Journey and Cross-File Pass

Status: in-progress

Required evidence:

- user journey execution notes
- admin journey execution notes
- data/money journey execution notes
- operational journey execution notes
- adversarial journey execution notes
- cross-file interaction findings

Findings:

- A4-010 - parameter routes shadow literal order and payout routes

Evidence captured:

- [api-route-service-parity.txt](./artifacts/api-route-service-parity.txt)

Current verified observations:

- Backend same-method route-order scan found only the two current parameter-shadow defects already filed as A4-010.
- Web direct-fetch scan found API requests confined to service/config/cluster modules plus the documented sitemap loader exception.
- Admin and user web service wrappers were compared against backend route families for path-builder shape; no new component-level API bypass was found in this pass.
- Dynamic HTML sinks are limited to the root theme script, native app-lock overlay, and Leaflet popup/icon HTML in `ClusterMap`; current popup data is escaped or encoded before interpolation.
