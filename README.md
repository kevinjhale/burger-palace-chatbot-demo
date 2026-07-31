# Trade Skills Tracker

A quarterly skills-assessment tool for a growing trades company. It does two jobs:

1. **Apprentice development** — every quarter, an apprentice and their mentor each
   fill out the same skills questionnaire *about the apprentice*. Neither can see
   the other's answers until **both** are submitted, then the one-on-one view shows
   them side by side with the gaps highlighted. Every submission is timestamped, so
   quarters can be reviewed and compared over time.
2. **Company capability lookup** — when a problem comes up on a job, pull up any
   skill ("shower surrounds", "panel work", "crown molding"…) and see who's rated
   highest, based on everyone's most recent review.

Every skill is rated **1–10 or N/A** (nobody can do everything yet). The
questionnaire covers the full arc of the trades — planning & design through
framing, MEP, drywall, finish carpentry, trim, and punch-list touch-ups — plus
soft skills like communication, punctuality, and attention to detail.

Each review ends with a **goals form** (3-month / 6-month / 1-year), and the Goals
tab pulls up every previous quarter's goals so you can review and compare them in
the next one-on-one.

## Running it

```bash
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

Open http://localhost:8000 (or `http://<your-machine>:8000` from other devices on
the same network — phones on the shop wifi work fine).

Data lives in `skills_tracker.db` (SQLite, created automatically). Back that one
file up and you've backed up everything.

## How it works day to day

1. **Team tab** — add everyone once. Roles:
   - *Apprentice* — can only review themselves.
   - *Mentor* — can review anyone.
   - *Both* — mentors others and also gets reviewed.
2. **Sign in** (top right) — pick your name; first sign-in sets your private
   4-digit PIN. The PIN is what keeps reviews blind.
3. **Fill Out Review** — pick who you're reviewing and the quarter, rate every
   skill (there's a "Mark unanswered as N/A" button), write goals, submit.
   - You can revise your submission until the other side submits.
   - Once both are in, the quarter **locks** — the record is frozen for history.
4. **One-on-One** — sit down together, pull up the quarter, and walk through the
   side-by-side comparison. Gaps of ±2 and ±3+ are flagged — those rows are
   usually where the best conversations happen.
5. **Progress** — category averages quarter over quarter (self / mentor).
6. **Who Can Do What** — ranked list per skill + a whole-team heatmap by category.
7. **Goals** — full goal history per person, newest quarter first.

## The skills list

Lives in [`skills.json`](skills.json) — edit it freely (add, remove, rename,
re-order) and restart the server. Ratings are stored against stable skill ids, so
old reviews keep their history even as the list evolves. ~110 skills across 17
categories out of the box.

## Notes & limits

- PINs are a lightweight honesty lock, not real security — fine for a trusted
  crew on a private network. Don't expose this to the open internet as-is.
- One mentor review per person per quarter (whichever mentor does the review).
- Quarters lock automatically once both sides are in; nothing is editable after
  that, which keeps the historical record honest.
