# FinAI – מערכת סוכני AI להמלצות השקעה (שיעור 2)

Academic project: a Hebrew RTL UI for a multi-agent investment-recommendation **simulator**. The PRD is the source of truth for product behavior; DESIGN.md is the source of truth for visuals.

## Folder layout
- `docs/spec.md` – the PRD (אפיון מאוחד). Read it before changing any screen.
- `docs/code.docx` – Word export of the original dashboard (reference only).
- `design/DESIGN.md` – design system "Sovereign Intelligence Fintech" (tokens, components, RTL rules).
- `design/screen.png` – screenshot of the original dashboard.
- `design/screens/NN-name.png` – screenshots of the 8 Stitch screens.
- `code/code.html` – original dashboard (Tailwind CDN, standalone).
- `code/screens/NN-name.html` – Stitch HTML for each screen, same names as the PNGs.

Screen numbering (follows PRD §8): 01 onboarding-settings, 02 home-v2, 03 recommendation, 04 simulated-execution, 05 holdings, 06 personal-assistant, 07 notifications-history, 08 reports.

## Stitch
- Project: "AI Investment Advisory Agent", id `14179146316905195923`
- Design system asset: `assets/b19e556a886f442999540934e368b877`
- Always pass that design system and `DESKTOP` when generating screens.
- `generate_screen_from_text` usually times out on the client but still finishes server-side. Do not retry; poll with `list_screens`, and send one request at a time.
- `download_file` results are too large to show inline and get saved to a tool-results file as JSON (`image` is base64, or `html`); decode them with PowerShell.
- Direct `downloadUrl` fetches return 401.

## Product rules (from the PRD – never violate in UI copy or flows)
- Simulated money only: ₪30,000 = short term ₪20,000 + medium term ₪10,000. The "כסף מדומה" marker stays prominent on every screen.
- No automatic execution, no conditional orders, and no trades while the user is unavailable. Approving a card never executes a trade; execution needs its own explicit screen with a fresh revalidation.
- Stocks only, Israel and the US. No leverage, shorting, derivatives or bank access, and no purchases outside the system's recommendations.
- Risk thresholds are measured from initial capital, for each scope:
  - Total portfolio: ₪1,500 (5%) / ₪3,000 (10%)
  - Short term: ₪1,000 / ₪2,000
  - Medium term: ₪500 / ₪1,000
  - 5% opens a mandatory review; it does not pause entries.
  - 10% pauses new entries in the affected scope.
  - A price recovery does not lift a pause; that needs an explicit, documented decision. The thresholds are not a guaranteed loss cap.
- Agent D's decisions are exactly: להמליץ / להמשיך לעקוב / לפסול. The system may decline to recommend and keep cash.
- **Do not invent diversification percentages.** Agent ג׳ proposes a policy and the user approves it; until then, show values as "הצעה – ממתין לאישור".
- Response window: up to 1 hour by default. The fast window is time-limited and reverts automatically. A response window is not a guarantee of validity.
- Notifications must distinguish sent, opened and executed.
- Reports: keep the short and detailed reports separate. A metric without enough data is marked "לא ניתן להערכה", never shown as a success.
- Experiment ends 1.1.2027 (proposed cutoff 00:00 Israel time, pending approval).

## Agents
- א׳: market, stocks and data
- ב׳: news and events, separating fact from interpretation
- ג׳: profile, risk, availability and feedback
- ד׳: integration, recommendations and holdings tracking

## UI conventions
- `dir="rtl" lang="he"`, Rubik font, dark theme, tokens from DESIGN.md.
- Colors: emerald = positive/active, amber = 5% review and human-in-the-loop, crimson only for 10% freeze, breaches and losses.
- Use tabular numbers. Use CSS logical properties (`inline-start`/`inline-end`), not left/right.
- Every price, FX rate and recommendation shows an update timestamp.

## Known issues in current screens (to fix)
- The navigation shell is inconsistent across screens. The sidebar should be: דף הבית, המלצות, ביצוע מדומה, החזקות, עוזר אישי, התראות והיסטוריה, דוחות, היכרות והגדרות.
- Some screens show a hard-coded "20%" concentration limit, which conflicts with the no-invented-percentages rule.

## Working with the user
The user writes in Hebrew; reply in Hebrew. Files live under Downloads, which is not a git repo, so look at a file before overwriting it.
