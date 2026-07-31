"""Trade Skills Tracker — quarterly skill assessments for apprentices & crew.

FastAPI + SQLite. No external services. Run with:  uvicorn main:app --reload
"""

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

DB_PATH = Path("skills_tracker.db")
SKILLS = json.loads(Path("skills.json").read_text(encoding="utf-8"))

# skill_id -> category_id lookup, and the set of all valid skill ids
SKILL_CATEGORY = {
    s["id"]: cat["id"] for cat in SKILLS["categories"] for s in cat["skills"]
}
ALL_SKILL_IDS = set(SKILL_CATEGORY)

app = FastAPI(title="Trade Skills Tracker")


# ---------------------------------------------------------------- database

@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL CHECK (role IN ('apprentice', 'mentor', 'both')),
            pin TEXT,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS assessments (
            id INTEGER PRIMARY KEY,
            subject_id INTEGER NOT NULL REFERENCES users(id),
            assessor_id INTEGER NOT NULL REFERENCES users(id),
            assessor_role TEXT NOT NULL CHECK (assessor_role IN ('self', 'mentor')),
            period TEXT NOT NULL,
            submitted_at TEXT NOT NULL,
            goals_3m TEXT NOT NULL DEFAULT '',
            goals_6m TEXT NOT NULL DEFAULT '',
            goals_1y TEXT NOT NULL DEFAULT '',
            UNIQUE (subject_id, assessor_role, period)
        );
        CREATE TABLE IF NOT EXISTS ratings (
            assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
            skill_id TEXT NOT NULL,
            score INTEGER,          -- NULL means N/A
            PRIMARY KEY (assessment_id, skill_id)
        );
        """)


init_db()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def current_period() -> str:
    today = datetime.now(timezone.utc)
    return f"{today.year}-Q{(today.month - 1) // 3 + 1}"


def get_user(conn, user_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "User not found")
    return row


def check_pin(conn, user_id: int, pin: str) -> sqlite3.Row:
    user = get_user(conn, user_id)
    if user["pin"] is None:
        raise HTTPException(403, "No PIN set for this user yet — set one first")
    if user["pin"] != pin:
        raise HTTPException(403, "Wrong PIN")
    return user


def period_status(conn, subject_id: int, period: str) -> dict:
    """Submission metadata for a subject+quarter (no scores — safe to show anyone)."""
    rows = conn.execute(
        """SELECT a.assessor_role, a.submitted_at, u.name AS assessor_name
           FROM assessments a JOIN users u ON u.id = a.assessor_id
           WHERE a.subject_id = ? AND a.period = ?""",
        (subject_id, period),
    ).fetchall()
    out = {"self": None, "mentor": None}
    for r in rows:
        out[r["assessor_role"]] = {
            "submitted_at": r["submitted_at"],
            "assessor_name": r["assessor_name"],
        }
    out["locked"] = out["self"] is not None and out["mentor"] is not None
    return out


def assessment_payload(conn, assessment_row) -> dict:
    ratings = {
        r["skill_id"]: r["score"]
        for r in conn.execute(
            "SELECT skill_id, score FROM ratings WHERE assessment_id = ?",
            (assessment_row["id"],),
        )
    }
    return {
        "assessor_id": assessment_row["assessor_id"],
        "submitted_at": assessment_row["submitted_at"],
        "ratings": ratings,
        "goals_3m": assessment_row["goals_3m"],
        "goals_6m": assessment_row["goals_6m"],
        "goals_1y": assessment_row["goals_1y"],
    }


def category_averages(conn, assessment_id: int) -> dict:
    """Average score per category for one assessment, ignoring N/A."""
    sums: dict[str, list[int]] = {}
    for r in conn.execute(
        "SELECT skill_id, score FROM ratings WHERE assessment_id = ? AND score IS NOT NULL",
        (assessment_id,),
    ):
        cat = SKILL_CATEGORY.get(r["skill_id"])
        if cat:
            sums.setdefault(cat, []).append(r["score"])
    return {cat: round(sum(v) / len(v), 1) for cat, v in sums.items()}


# ---------------------------------------------------------------- models

class NewUser(BaseModel):
    name: str
    role: str  # apprentice | mentor | both


class SetPin(BaseModel):
    user_id: int
    pin: str
    old_pin: str | None = None


class Login(BaseModel):
    user_id: int
    pin: str


class SubmitAssessment(BaseModel):
    assessor_id: int
    pin: str
    subject_id: int
    period: str
    ratings: dict[str, int | None]  # skill_id -> 1..10, or None for N/A
    goals_3m: str = ""
    goals_6m: str = ""
    goals_1y: str = ""


# ---------------------------------------------------------------- endpoints

@app.get("/api/config")
def config():
    return {"skills": SKILLS, "current_period": current_period()}


@app.get("/api/users")
def list_users():
    with db() as conn:
        return [
            {
                "id": u["id"],
                "name": u["name"],
                "role": u["role"],
                "has_pin": u["pin"] is not None,
            }
            for u in conn.execute(
                "SELECT * FROM users WHERE active = 1 ORDER BY name"
            )
        ]


@app.post("/api/users")
def add_user(body: NewUser):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Name is required")
    if body.role not in ("apprentice", "mentor", "both"):
        raise HTTPException(400, "Role must be apprentice, mentor, or both")
    with db() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO users (name, role, created_at) VALUES (?, ?, ?)",
                (name, body.role, now_iso()),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(409, "A person with that name already exists")
        return {"id": cur.lastrowid, "name": name, "role": body.role}


@app.post("/api/set-pin")
def set_pin(body: SetPin):
    pin = body.pin.strip()
    if not (pin.isdigit() and len(pin) == 4):
        raise HTTPException(400, "PIN must be exactly 4 digits")
    with db() as conn:
        user = get_user(conn, body.user_id)
        if user["pin"] is not None and user["pin"] != (body.old_pin or ""):
            raise HTTPException(403, "Current PIN is incorrect")
        conn.execute("UPDATE users SET pin = ? WHERE id = ?", (pin, body.user_id))
    return {"ok": True}


@app.post("/api/login")
def login(body: Login):
    with db() as conn:
        user = check_pin(conn, body.user_id, body.pin)
        return {"id": user["id"], "name": user["name"], "role": user["role"]}


@app.get("/api/status")
def status(subject_id: int, period: str):
    with db() as conn:
        get_user(conn, subject_id)
        return period_status(conn, subject_id, period)


@app.post("/api/assessments")
def submit_assessment(body: SubmitAssessment):
    with db() as conn:
        assessor = check_pin(conn, body.assessor_id, body.pin)
        get_user(conn, body.subject_id)

        if body.assessor_id == body.subject_id:
            role = "self"
        else:
            if assessor["role"] not in ("mentor", "both"):
                raise HTTPException(403, "Only mentors can review someone else")
            role = "mentor"

        unknown = set(body.ratings) - ALL_SKILL_IDS
        if unknown:
            raise HTTPException(400, f"Unknown skill ids: {sorted(unknown)[:5]}")
        for skill_id, score in body.ratings.items():
            if score is not None and not (1 <= score <= 10):
                raise HTTPException(400, f"Score for {skill_id} must be 1-10 or N/A")

        st = period_status(conn, body.subject_id, body.period)
        if st["locked"]:
            raise HTTPException(
                409,
                "Both reviews for this quarter are already submitted — "
                "this quarter is locked and can't be changed.",
            )

        # Replace any earlier draft submission for this role (allowed until locked)
        existing = conn.execute(
            """SELECT id FROM assessments
               WHERE subject_id = ? AND assessor_role = ? AND period = ?""",
            (body.subject_id, role, body.period),
        ).fetchone()
        if existing:
            conn.execute("DELETE FROM assessments WHERE id = ?", (existing["id"],))

        cur = conn.execute(
            """INSERT INTO assessments
               (subject_id, assessor_id, assessor_role, period, submitted_at,
                goals_3m, goals_6m, goals_1y)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (body.subject_id, body.assessor_id, role, body.period, now_iso(),
             body.goals_3m.strip(), body.goals_6m.strip(), body.goals_1y.strip()),
        )
        conn.executemany(
            "INSERT INTO ratings (assessment_id, skill_id, score) VALUES (?, ?, ?)",
            [(cur.lastrowid, sid, score) for sid, score in body.ratings.items()],
        )
        return {"ok": True, "role": role, "status": period_status(conn, body.subject_id, body.period)}


@app.get("/api/review")
def review(subject_id: int, period: str, viewer_id: int, pin: str):
    """One-on-one comparison. Each side stays hidden until BOTH are submitted;
    a viewer always sees their own submission."""
    with db() as conn:
        viewer = check_pin(conn, viewer_id, pin)
        if viewer_id != subject_id and viewer["role"] not in ("mentor", "both"):
            raise HTTPException(403, "Only the person themselves or a mentor can view reviews")

        st = period_status(conn, subject_id, period)
        rows = conn.execute(
            "SELECT * FROM assessments WHERE subject_id = ? AND period = ?",
            (subject_id, period),
        ).fetchall()

        out = {"status": st, "self": None, "mentor": None}
        for row in rows:
            is_own = row["assessor_id"] == viewer_id
            if st["locked"] or is_own:
                out[row["assessor_role"]] = assessment_payload(conn, row)
        return out


@app.get("/api/history")
def history(subject_id: int, viewer_id: int, pin: str):
    """Quarter-over-quarter category averages for completed (locked) quarters."""
    with db() as conn:
        viewer = check_pin(conn, viewer_id, pin)
        if viewer_id != subject_id and viewer["role"] not in ("mentor", "both"):
            raise HTTPException(403, "Only the person themselves or a mentor can view history")

        periods = [
            r["period"]
            for r in conn.execute(
                """SELECT period, COUNT(DISTINCT assessor_role) AS n
                   FROM assessments WHERE subject_id = ?
                   GROUP BY period HAVING n = 2 ORDER BY period""",
                (subject_id,),
            )
        ]
        out = []
        for period in periods:
            entry = {"period": period, "self": {}, "mentor": {}}
            for row in conn.execute(
                "SELECT * FROM assessments WHERE subject_id = ? AND period = ?",
                (subject_id, period),
            ):
                entry[row["assessor_role"]] = category_averages(conn, row["id"])
            out.append(entry)
        return out


@app.get("/api/goals")
def goals(subject_id: int, viewer_id: int, pin: str):
    """Goal history across quarters. Same visibility rule as reviews."""
    with db() as conn:
        viewer = check_pin(conn, viewer_id, pin)
        if viewer_id != subject_id and viewer["role"] not in ("mentor", "both"):
            raise HTTPException(403, "Only the person themselves or a mentor can view goals")

        out = []
        for row in conn.execute(
            """SELECT a.*, u.name AS assessor_name
               FROM assessments a JOIN users u ON u.id = a.assessor_id
               WHERE a.subject_id = ? ORDER BY a.period DESC, a.assessor_role""",
            (subject_id,),
        ):
            st = period_status(conn, subject_id, row["period"])
            if not (st["locked"] or row["assessor_id"] == viewer_id):
                continue
            out.append({
                "period": row["period"],
                "role": row["assessor_role"],
                "assessor_name": row["assessor_name"],
                "submitted_at": row["submitted_at"],
                "goals_3m": row["goals_3m"],
                "goals_6m": row["goals_6m"],
                "goals_1y": row["goals_1y"],
            })
        return out


def latest_ratings(conn, user_id: int) -> dict | None:
    """Most recent completed quarter's ratings for a person (mentor rating wins,
    self fills gaps). Falls back to the most recent single submission if the
    person has never completed a full quarter."""
    rows = conn.execute(
        """SELECT * FROM assessments WHERE subject_id = ?
           ORDER BY period DESC,
                    CASE assessor_role WHEN 'mentor' THEN 0 ELSE 1 END""",
        (user_id,),
    ).fetchall()
    if not rows:
        return None
    by_period: dict[str, list] = {}
    for r in rows:
        by_period.setdefault(r["period"], []).append(r)
    # prefer newest locked period, else newest period with anything
    target = None
    for period in sorted(by_period, reverse=True):
        if len(by_period[period]) == 2:
            target = period
            break
    if target is None:
        target = max(by_period)
    merged: dict[str, int | None] = {}
    for row in by_period[target]:  # mentor first, self fills gaps
        payload = assessment_payload(conn, row)
        for sid, score in payload["ratings"].items():
            if sid not in merged or merged[sid] is None:
                merged[sid] = score
    return {"period": target, "ratings": merged}


@app.get("/api/capabilities")
def capabilities(skill_id: str | None = None):
    """Company-wide 'who can do what', from each person's latest review."""
    with db() as conn:
        result = []
        for u in conn.execute("SELECT * FROM users WHERE active = 1 ORDER BY name"):
            latest = latest_ratings(conn, u["id"])
            if latest is None:
                continue
            result.append({
                "user_id": u["id"],
                "name": u["name"],
                "role": u["role"],
                "period": latest["period"],
                "ratings": latest["ratings"],
            })

        if skill_id:
            if skill_id not in ALL_SKILL_IDS:
                raise HTTPException(404, "Unknown skill")
            ranked = [
                {
                    "user_id": p["user_id"],
                    "name": p["name"],
                    "period": p["period"],
                    "score": p["ratings"].get(skill_id),
                }
                for p in result
                if p["ratings"].get(skill_id) is not None
            ]
            ranked.sort(key=lambda p: p["score"], reverse=True)
            return {"skill_id": skill_id, "people": ranked}
        return result


app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/", response_class=HTMLResponse)
def index():
    return HTMLResponse(Path("static/index.html").read_text(encoding="utf-8"))
