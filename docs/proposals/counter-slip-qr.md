# Counter-slip proof QR on a 58 mm slip: options

**Status:** decided (2026-10-07): **D + C**, the compact encoding in the
protocol (farmledge-protocol#5) plus the SMS bundle, sent as a link and as
plain text (farmledge-protocol#6, `docs/decisions.md` D47), with instant
reprints by any staff member (D46). Not the lookup code. Smartphone share
is unknown, so the slip plus reprint must work with no smartphone at all.
**Related:** `docs/decisions.md` D45.

## The problem

If the slip's QR code won't scan from a 58 mm thermal print, farmers have
no portable proof. Measured with a realistic deposit leaf (three `G…`
addresses, 32-byte salt), ECC M, 4-module quiet zone:

| Payload                                     | QR version | 58 mm roll (48 mm printable) | 80 mm roll (72 mm printable) |
| ------------------------------------------- | ---------- | ---------------------------- | ---------------------------- |
| Today: leaf JSON, 615 chars                 | 19         | 0.48 mm/module               | 0.71 mm/module               |
| Compact binary leaf, base45 (~345 chars)    | 11         | 0.70 mm/module               | 1.04 mm/module               |
| Reference only (`FL1:KN-DAWANAU:1042:7QK3`) | 2          | 1.45 mm/module               | 2.18 mm/module               |

A typical thermal printer prints 8 dots/mm (203 dpi), so 0.48 mm is under
4 dots per module, which is marginal for phone cameras, worse once the
paper is creased or dusty. **Nothing here has been tested on a real printer.**

Two facts frame every option:

- **The counter QR is not a proof yet.** The proof path only exists once
  the day's tree is built at the cutoff. Leaf and salt alone can't be
  checked against the chain. Their value is letting the farmer confirm,
  later, that the bundle they receive is for what was recorded at the
  counter (protocol#5, point 3).
- **Thermal paper fades.** In heat and sunlight a thermal print can be
  unreadable within months. A slip is short-lived evidence whatever is on
  it; durable proof has to be digital, or reprinted on demand (which the
  protocol already requires).

## Options

### A. Larger slip (80 mm printer)

Today's JSON at 0.71 mm/module scans reliably.

- For: no protocol or API change.
- Against: hardware cost and choice now; still fades; the printed full
  bundle (required on request and on dispatch slips) is larger again and
  won't fit either.

### B. Short lookup code next to the QR

Print a short code (and keep the big QR); the farmer, or anyone, looks the
bundle up by code.

- For: easy to read aloud or type; works for feature phones via a helper.
- Against: doesn't make the QR scannable; retrieval depends on a Farmledge
  service being up and honest about what it returns. Verification stays
  independent, but getting the bundle doesn't.

### C. SMS delivery of the bundle; only a reference on the slip

The slip carries a small reference QR (version 2, scans from anything) and
the printed reference; the bundle arrives by SMS link within 24 h of the
anchor, as protocol §4 already requires.

- For: tiny, robust QR; the durable proof is digital, not fading paper.
- Against: the farmer leaves the counter with no leaf or salt of their own,
  so they can't independently confirm the later bundle matches the counter;
  the SMS link only helps smartphone owners (feature phones get a link they
  can't open); retrieval depends on Farmledge sending it.

### D. Compact encoding, specified in the protocol (protocol#5)

A versioned positional binary encoding of leaf and salt, base45, in
alphanumeric mode: version 11, 0.70 mm/module on a 58 mm roll.

- For: the farmer keeps leaf and salt, independently of Farmledge, on the
  58 mm printer we would buy anyway; third parties implement it from the
  spec; the same work can give a compact bundle encoding for printed proofs.
- Against: protocol and `verify_proof.py` work first; the API and app switch
  after; still paper, still fades.

## Recommendation

**D plus C**: specify the compact encoding (protocol#5) and print it on the
58 mm slip, and treat the SMS bundle (already required) as the durable
proof, with a reprint at the warehouse on request for farmers without
smartphones. That keeps the farmer's own copy of leaf and salt at the
counter, fits the cheap printer, and doesn't rely on paper surviving.

Keep **A** as the fallback if field tests show the compact QR still doesn't
scan. Don't adopt **B** as the main path: it doesn't fix scanning, and it
adds a Farmledge dependency for getting the proof.

## Open questions

1. What share of farmers at the pilot warehouses have a smartphone? That
   decides how much C delivers, and how much load falls on reprints.
2. Which printer will be used? Test D (and today's JSON) on it, with creased
   and dusty paper, on the phones farmers actually carry, before field use.
