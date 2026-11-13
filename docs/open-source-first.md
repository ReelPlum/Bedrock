# Open source first

Before building a feature or a module, find out whether a tried, tested and
well maintained open source library or system already solves it, and prefer
using it. Bedrock's own code should be the part that makes Bedrock Bedrock.

## The rule

1. **Research first.** Look for existing open source before writing a
   feature, a module, a parser, an algorithm or a tool. Write down what was
   looked at, also when nothing fits.
2. **It must do exactly what we want.** A library is adopted when it covers
   the whole need. If it covers only part, say which part is missing; the
   gap decides whether it is used, used for part of the job, or turned down.
   Behaviour users already rely on must not get worse.
3. **It must allow commercial use.** Fine without asking: MIT, Apache-2.0,
   BSD, ISC, Zlib, Unlicense, CC0, and MPL-2.0 (changes to the library's own
   files must be published). Ask Frederik before using anything else: GPL,
   LGPL, AGPL, "non-commercial" or research-only terms, or no licence at
   all. This covers everything that ships or that a shipped thing is made
   from: code, models and the data they were trained on, word lists, fonts.
4. **Prefer Rust.** If an option that is not Rust is clearly better, ask
   Frederik before adopting it and explain why.
5. **Mature means evidence.** Say how old it is, how widely it is used
   (downloads, well known users), when it was last released, and who
   maintains it. A young or one-person library needs a reason to be trusted.
6. **Building our own needs a good reason**, written down: what the
   libraries lack, or what ours does better (for example the feel of the
   ink, a latency budget, a format we promise to keep).
7. **Data formats are not changed by a library.** The data format rules
   still apply: no change without Frederik's approval, and old files and
   data keep working, with tests that prove it.

## Record it in the spec

When an open source project is added or used, the spec of the feature that
uses it (`openspec/specs/<capability>/spec.md`) gets an **Open source used**
section. A change that adds or swaps one writes it in the proposal and the
delta spec. For each project:

| Field | What to write |
|---|---|
| Name and version | With a link. |
| Used for | What it does in this feature. |
| Why this one | Why it was chosen, and that it does exactly what is needed (or the gap, and how the gap is covered). |
| Why it is mature | Age, use, last release, maintainers. |
| Licence | And that it allows commercial use. |
| Considered | What else was looked at and why it was turned down, including building our own. |
| Not Rust | If so, Frederik's approval and the reason. |

Where we build our own although libraries exist, the same section says so
and gives the reason.

Dependencies that were in use before this rule are listed in the survey of
12 November 2026 and get this section as their specs are next touched.
