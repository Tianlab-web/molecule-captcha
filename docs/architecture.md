# Runtime architecture

[中文版本](architecture.zh-CN.md)

Paths beginning with flask_app/ or molecule_generator/ are relative to
the project root. Other module and static/ paths below are relative to flask_app/.

- flask_app/app.py: routes, browser ownership, one-use sessions, drawing time,
  evidence checkpoints, structure verification and report storage.
- security_validation.py: validates evidence shape, time order, chemistry and
  append-only checkpoint commitments.
- security_scoring.py: scores server-validated evidence.
- security_store.py: persistent SQLite behavior fingerprint index.
- attention_check.py / attention_image.py: server-selected, single-use timed
  click challenge. A 3–8 second randomized delay precedes a 5 second click window.
  The server selects the target independently of client inventories.
- static/attention-check.js: maps actual toolbar clicks to atlas coordinates.
  All candidate buttons receive equivalent image treatment; only one atlas tile
  has visible pixels. Validation clicks do not change the drawing.
- static/usage-monitor.js: live evidence, result panels, PNG export and replay.
- static/quick-atoms.js: atom toolbar randomization, configurable element
  interference, cooldown and native tool synchronization.
- static/disable-canvas-paste.js: guards manual drawing against import/paste.
- molecule_generator: skeleton enumeration, CH2 substitutions and RDKit
  sanitization/deduplication. It also has a CLI.

## Language and assets

The homepage defaults to English; ?lang=zh explicitly selects Chinese.
Changing languages reloads the editor and creates a new challenge.
The challenge stores its language server-side; session creation uses it for
the attention image. Missing or unsupported language values select English.

attention_assets/left.png, right.png and down-0.png through down-7.png are Chinese.
Their -en.png siblings are English. All tiles are 360×128 RGBA with the same target
geometry. English assets are prebuilt, so deployment does not need fonts.
## Evidence and timing

Protocol v3 commits cumulative evidence every 1.5 seconds with a one-use receipt;
final reports must match the sealed live history. Replay fingerprints exclude
the answer and session identity. HTTPS cookies bind challenges to one browser.
The server recalculates trajectory statistics and validates final MOL/SMILES.

Drawing time starts when detection begins. At 8 heavy atoms the default upper
limit is 30 seconds, adjusted by 5 seconds per atom; completion at or below
10 seconds fails the lower limit. Parameters are in config.py.
Attention checks and drawing time are independent requirements.

accepted: true is the successful server verdict. HTTP 200 or ok: true alone
does not mean the user passed. Failed uploads never fall back to local success.

## Limits

Client events are not human attestation. Consistent real-time synthetic
evidence or browser automation can still emulate interaction; bitmap analysis can
locate the attention target. The project has not established a general defense
against such automation. It does not implement business-facing proof
issuance/redemption or distributed sessions/rate limits.
