/* Trade Skills Tracker — frontend. Vanilla JS, no build step. */

const state = {
  config: null,      // { skills, current_period }
  users: [],
  me: null,          // { id, name, role, pin }
  draft: {},         // skill_id -> score|null (current assessment form)
};

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 4200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

function fmtStamp(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function periodOptions(selected) {
  // quarters from 2025-Q1 through one past the current quarter, newest first
  const [cy, cq] = state.config.current_period.split("-Q").map(Number);
  const list = [];
  let y = cy, q = cq + 1;
  if (q > 4) { y += 1; q = 1; }
  while (y > 2025 || (y === 2025 && q >= 1)) {
    list.push(`${y}-Q${q}`);
    q -= 1;
    if (q === 0) { y -= 1; q = 4; }
  }
  const sel = selected || state.config.current_period;
  return list.map((p) =>
    `<option value="${p}" ${p === sel ? "selected" : ""}>${p}${p === state.config.current_period ? " (current)" : ""}</option>`
  ).join("");
}

function userOptions(users, selectedId) {
  return users.map((u) =>
    `<option value="${u.id}" ${u.id === selectedId ? "selected" : ""}>${esc(u.name)}</option>`
  ).join("");
}

function allSkills() {
  return state.config.skills.categories.flatMap((c) => c.skills);
}

function scorePill(score) {
  if (score === null || score === undefined)
    return `<span class="score-pill s-na">N/A</span>`;
  const cls = score >= 7 ? "s-hi" : score >= 4 ? "s-mid" : "s-lo";
  return `<span class="score-pill ${cls}">${score}</span>`;
}

/* ---------------------------------------------------------------- identity */

function saveMe() {
  if (state.me) localStorage.setItem("tst_me", JSON.stringify(state.me));
  else localStorage.removeItem("tst_me");
}

function renderIdentity() {
  const box = $("#identity-box");
  if (state.me) {
    box.innerHTML = `
      <span class="badge">👤 ${esc(state.me.name)}</span>
      <button class="ghost" id="btn-signout">Sign out</button>`;
    $("#btn-signout").onclick = () => {
      state.me = null;
      saveMe();
      renderIdentity();
      renderActiveTab();
    };
    return;
  }
  box.innerHTML = `
    <select id="login-user">
      <option value="">Who are you?</option>
      ${userOptions(state.users)}
    </select>
    <input class="pin" id="login-pin" type="password" inputmode="numeric"
           maxlength="4" placeholder="PIN">
    <button class="ghost" id="btn-login">Sign in</button>`;

  const userSel = $("#login-user");
  const pinInput = $("#login-pin");
  userSel.onchange = () => {
    const u = state.users.find((x) => x.id === Number(userSel.value));
    pinInput.placeholder = u && !u.has_pin ? "New PIN" : "PIN";
  };
  $("#btn-login").onclick = async () => {
    const userId = Number(userSel.value);
    const pin = pinInput.value.trim();
    if (!userId) return toast("Pick your name first", true);
    if (!/^\d{4}$/.test(pin)) return toast("PIN is 4 digits", true);
    const u = state.users.find((x) => x.id === userId);
    try {
      if (u && !u.has_pin) {
        await api("/api/set-pin", { method: "POST", body: JSON.stringify({ user_id: userId, pin }) });
        u.has_pin = true;
        toast("PIN created — keep it to yourself!");
      }
      const me = await api("/api/login", { method: "POST", body: JSON.stringify({ user_id: userId, pin }) });
      state.me = { ...me, pin };
      saveMe();
      renderIdentity();
      renderActiveTab();
    } catch (e) {
      toast(e.message, true);
    }
  };
}

function needSignIn(panel) {
  panel.innerHTML = `<div class="notice info">Sign in up top (pick your name, enter your PIN) to use this page.
    First time? Pick your name and choose a 4-digit PIN — it keeps your review private until both sides are done.</div>`;
}

const isMentor = () => state.me && (state.me.role === "mentor" || state.me.role === "both");

/* ---------------------------------------------------------------- tab: assessment */

async function renderAssess() {
  const panel = $("#tab-assess");
  if (!state.me) return needSignIn(panel);

  const subjects = isMentor()
    ? state.users
    : state.users.filter((u) => u.id === state.me.id);

  panel.innerHTML = `
    <h2>Fill Out a Review</h2>
    <p class="sub">Rate each skill 1–10, or N/A for things they haven't gotten to yet.
       Your answers stay hidden from the other person until both reviews are in.</p>
    <div class="controls">
      <div><label>Reviewing</label>
        <select id="as-subject">${userOptions(subjects, state.me.id)}</select></div>
      <div><label>Quarter</label>
        <select id="as-period">${periodOptions()}</select></div>
    </div>
    <div id="as-status"></div>
    <div id="as-form"></div>`;

  $("#as-subject").onchange = loadAssessForm;
  $("#as-period").onchange = loadAssessForm;
  await loadAssessForm();
}

async function loadAssessForm() {
  const subjectId = Number($("#as-subject").value);
  const period = $("#as-period").value;
  const statusBox = $("#as-status");
  const formBox = $("#as-form");
  const roleWord = subjectId === state.me.id ? "self-review" : "mentor review";

  let review;
  try {
    review = await api(`/api/review?subject_id=${subjectId}&period=${encodeURIComponent(period)}&viewer_id=${state.me.id}&pin=${encodeURIComponent(state.me.pin)}`);
  } catch (e) {
    statusBox.innerHTML = `<div class="notice err">${esc(e.message)}</div>`;
    formBox.innerHTML = "";
    return;
  }
  const st = review.status;

  if (st.locked) {
    statusBox.innerHTML = `<div class="notice ok">Both reviews for ${esc(period)} are submitted and locked
      (self: ${fmtStamp(st.self.submitted_at)}, mentor: ${fmtStamp(st.mentor.submitted_at)}).
      Head to the <b>One-on-One</b> tab to compare them.</div>`;
    formBox.innerHTML = "";
    return;
  }

  const myRole = subjectId === state.me.id ? "self" : "mentor";
  const mine = review[myRole];
  state.draft = {};
  if (mine) {
    Object.assign(state.draft, mine.ratings);
    statusBox.innerHTML = `<div class="notice info">You already submitted this ${roleWord} on
      ${fmtStamp(mine.submitted_at)}. You can revise it below until the other review comes in.</div>`;
  } else {
    const other = myRole === "self" ? st.mentor : st.self;
    statusBox.innerHTML = other
      ? `<div class="notice info">The other side submitted theirs on ${fmtStamp(other.submitted_at)} — it stays hidden until you submit yours.</div>`
      : "";
  }

  const cats = state.config.skills.categories.map((cat) => `
    <div class="category" data-cat="${cat.id}">
      <h3>${esc(cat.name)} <span class="cat-progress" data-cat-progress="${cat.id}"></span></h3>
      ${cat.skills.map((s) => `
        <div class="skill-row" data-skill="${s.id}">
          <div class="skill-name">${esc(s.name)}</div>
          <div class="rating-group">
            <button type="button" class="na" data-val="na">N/A</button>
            ${Array.from({ length: 10 }, (_, i) => `<button type="button" data-val="${i + 1}">${i + 1}</button>`).join("")}
          </div>
        </div>`).join("")}
    </div>`).join("");

  formBox.innerHTML = `
    ${cats}
    <div class="card">
      <h3 style="margin-bottom:12px">Goals</h3>
      <div class="goals-grid">
        <div><label>3-month goals</label><textarea id="g3" placeholder="What should be true in 3 months?">${esc(mine?.goals_3m || "")}</textarea></div>
        <div><label>6-month goals</label><textarea id="g6" placeholder="What should be true in 6 months?">${esc(mine?.goals_6m || "")}</textarea></div>
        <div><label>1-year goals</label><textarea id="g12" placeholder="Where should they be in a year?">${esc(mine?.goals_1y || "")}</textarea></div>
      </div>
    </div>
    <div class="sticky-submit">
      <button class="primary" id="as-submit">Submit ${roleWord}</button>
      <button class="ghost" id="as-fill-na">Mark unanswered as N/A</button>
      <span class="progress-note" id="as-progress"></span>
    </div>`;

  // restore any prefilled selections
  for (const [sid, val] of Object.entries(state.draft)) {
    const row = formBox.querySelector(`[data-skill="${sid}"]`);
    if (!row) continue;
    const btn = row.querySelector(`[data-val="${val === null ? "na" : val}"]`);
    if (btn) btn.classList.add("selected");
  }
  updateProgress();

  formBox.querySelectorAll(".rating-group button").forEach((btn) => {
    btn.onclick = () => {
      const row = btn.closest(".skill-row");
      row.querySelectorAll("button").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      state.draft[row.dataset.skill] = btn.dataset.val === "na" ? null : Number(btn.dataset.val);
      updateProgress();
    };
  });

  $("#as-fill-na").onclick = () => {
    for (const s of allSkills()) {
      if (!(s.id in state.draft)) {
        state.draft[s.id] = null;
        const row = formBox.querySelector(`[data-skill="${s.id}"]`);
        row?.querySelector('[data-val="na"]')?.classList.add("selected");
      }
    }
    updateProgress();
  };

  $("#as-submit").onclick = async () => {
    const total = allSkills().length;
    const answered = Object.keys(state.draft).length;
    if (answered < total)
      return toast(`${total - answered} skills still unanswered — rate them or hit “Mark unanswered as N/A”.`, true);
    try {
      const out = await api("/api/assessments", {
        method: "POST",
        body: JSON.stringify({
          assessor_id: state.me.id,
          pin: state.me.pin,
          subject_id: subjectId,
          period,
          ratings: state.draft,
          goals_3m: $("#g3").value,
          goals_6m: $("#g6").value,
          goals_1y: $("#g12").value,
        }),
      });
      toast(out.status.locked
        ? "Submitted — both reviews are now in! Compare them in the One-on-One tab."
        : "Submitted and timestamped. It stays hidden until the other review is in.");
      loadAssessForm();
    } catch (e) {
      toast(e.message, true);
    }
  };

  function updateProgress() {
    const total = allSkills().length;
    const answered = Object.keys(state.draft).length;
    $("#as-progress").textContent = `${answered} / ${total} skills answered`;
    for (const cat of state.config.skills.categories) {
      const done = cat.skills.filter((s) => s.id in state.draft).length;
      const el = formBox.querySelector(`[data-cat-progress="${cat.id}"]`);
      if (el) el.textContent = `${done}/${cat.skills.length}`;
    }
  }
}

/* ---------------------------------------------------------------- tab: one-on-one */

async function renderOneOnOne() {
  const panel = $("#tab-oneonone");
  if (!state.me) return needSignIn(panel);

  const subjects = isMentor()
    ? state.users
    : state.users.filter((u) => u.id === state.me.id);

  panel.innerHTML = `
    <h2>One-on-One Review</h2>
    <p class="sub">Side-by-side comparison of the self-review and mentor review for a quarter.
       Scores unlock only once both are submitted.</p>
    <div class="controls">
      <div><label>Person</label><select id="oo-subject">${userOptions(subjects, state.me.id)}</select></div>
      <div><label>Quarter</label><select id="oo-period">${periodOptions()}</select></div>
    </div>
    <div id="oo-result"></div>`;

  $("#oo-subject").onchange = loadOneOnOne;
  $("#oo-period").onchange = loadOneOnOne;
  await loadOneOnOne();
}

async function loadOneOnOne() {
  const subjectId = Number($("#oo-subject").value);
  const period = $("#oo-period").value;
  const box = $("#oo-result");
  let data;
  try {
    data = await api(`/api/review?subject_id=${subjectId}&period=${encodeURIComponent(period)}&viewer_id=${state.me.id}&pin=${encodeURIComponent(state.me.pin)}`);
  } catch (e) {
    box.innerHTML = `<div class="notice err">${esc(e.message)}</div>`;
    return;
  }
  const st = data.status;
  const who = esc(state.users.find((u) => u.id === subjectId)?.name || "");

  const stampLine = (label, s) => s
    ? `<b>${label}:</b> submitted ${fmtStamp(s.submitted_at)} by ${esc(s.assessor_name)}`
    : `<b>${label}:</b> not submitted yet`;

  if (!st.locked) {
    box.innerHTML = `
      <div class="notice warn">This quarter isn't unlocked yet — both reviews must be in before anyone sees the comparison.<br>
        ${stampLine("Self-review", st.self)}<br>${stampLine("Mentor review", st.mentor)}</div>
      ${data.self || data.mentor ? `<div class="notice info">Your own submission is saved${
        (data.self || data.mentor).submitted_at ? " (" + fmtStamp((data.self || data.mentor).submitted_at) + ")" : ""
      } — you can revise it on the Fill Out Review tab until the other side submits.</div>` : ""}`;
    return;
  }

  const rows = state.config.skills.categories.map((cat) => {
    const skillRows = cat.skills.map((s) => {
      const a = data.self.ratings[s.id];
      const b = data.mentor.ratings[s.id];
      let gap = "";
      if (a != null && b != null) {
        const d = b - a;
        const cls = Math.abs(d) >= 3 ? "gap-hi" : Math.abs(d) >= 2 ? "gap-med" : "";
        gap = `<span class="${cls}">${d > 0 ? "+" + d : d}</span>`;
      }
      return `<tr><td>${esc(s.name)}</td><td>${scorePill(a)}</td><td>${scorePill(b)}</td><td>${gap}</td></tr>`;
    }).join("");
    return `<tr class="cat-head"><td colspan="4">${esc(cat.name)}</td></tr>${skillRows}`;
  }).join("");

  const goalsBlock = (label, g) => `
    <div class="goal-card card">
      <h4>${label} <span class="stamp">${fmtStamp(g.submitted_at)}</span></h4>
      <dl>
        <dt>3-month</dt><dd class="${g.goals_3m ? "" : "empty"}">${esc(g.goals_3m) || "—"}</dd>
        <dt>6-month</dt><dd class="${g.goals_6m ? "" : "empty"}">${esc(g.goals_6m) || "—"}</dd>
        <dt>1-year</dt><dd class="${g.goals_1y ? "" : "empty"}">${esc(g.goals_1y) || "—"}</dd>
      </dl>
    </div>`;

  box.innerHTML = `
    <div class="notice ok">${who} — ${esc(period)} complete.
      Self-review ${fmtStamp(st.self.submitted_at)} · Mentor review ${fmtStamp(st.mentor.submitted_at)} by ${esc(st.mentor.assessor_name)}.</div>
    <div class="card" style="overflow-x:auto">
      <table class="compare">
        <thead><tr><th>Skill</th><th>Self</th><th>Mentor</th><th>Gap</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <h2 style="margin:18px 0 10px">Goals set this quarter</h2>
    <div class="goal-cols">
      ${goalsBlock("Their own goals (self)", data.self)}
      ${goalsBlock("Mentor's goals for them", data.mentor)}
    </div>`;
}

/* ---------------------------------------------------------------- tab: progress */

async function renderProgress() {
  const panel = $("#tab-progress");
  if (!state.me) return needSignIn(panel);

  const subjects = isMentor()
    ? state.users
    : state.users.filter((u) => u.id === state.me.id);

  panel.innerHTML = `
    <h2>Progress Over Time</h2>
    <p class="sub">Category averages for every completed quarter, shown as <b>self / mentor</b>. Watch the numbers climb.</p>
    <div class="controls">
      <div><label>Person</label><select id="pr-subject">${userOptions(subjects, state.me.id)}</select></div>
    </div>
    <div id="pr-result"></div>`;

  $("#pr-subject").onchange = loadProgress;
  await loadProgress();
}

async function loadProgress() {
  const subjectId = Number($("#pr-subject").value);
  const box = $("#pr-result");
  let hist;
  try {
    hist = await api(`/api/history?subject_id=${subjectId}&viewer_id=${state.me.id}&pin=${encodeURIComponent(state.me.pin)}`);
  } catch (e) {
    box.innerHTML = `<div class="notice err">${esc(e.message)}</div>`;
    return;
  }
  if (!hist.length) {
    box.innerHTML = `<div class="notice info">No completed quarters yet — a quarter shows up here once both the self-review and mentor review are submitted.</div>`;
    return;
  }
  const cats = state.config.skills.categories;
  const head = hist.map((h) => `<th>${esc(h.period)}</th>`).join("");
  const body = cats.map((cat) => {
    const cells = hist.map((h) => {
      const s = h.self[cat.id], m = h.mentor[cat.id];
      return `<td>${s ?? "–"} / ${m ?? "–"}</td>`;
    }).join("");
    return `<tr><th class="rowh">${esc(cat.name)}</th>${cells}</tr>`;
  }).join("");
  box.innerHTML = `
    <div class="card hm-scroll">
      <table class="heatmap">
        <thead><tr><th class="rowh">Category (self / mentor)</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

/* ---------------------------------------------------------------- tab: capabilities */

async function renderCapabilities() {
  const panel = $("#tab-capabilities");
  const cats = state.config.skills.categories;
  panel.innerHTML = `
    <h2>Who Can Do What</h2>
    <p class="sub">A problem came up — find out who's rated highest on the skill you need. Uses each person's most recent review (mentor score first, self score if that's all there is).</p>
    <div class="controls">
      <div><label>Skill needed</label>
        <select id="cap-skill">
          <option value="">— pick a skill —</option>
          ${cats.map((c) => `<optgroup label="${esc(c.name)}">${
            c.skills.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")
          }</optgroup>`).join("")}
        </select></div>
    </div>
    <div id="cap-ranked"></div>
    <h2 style="margin:22px 0 6px">Team overview</h2>
    <p class="sub">Average score by category for everyone with a review on file.</p>
    <div id="cap-matrix"></div>`;

  $("#cap-skill").onchange = async () => {
    const sid = $("#cap-skill").value;
    const box = $("#cap-ranked");
    if (!sid) { box.innerHTML = ""; return; }
    try {
      const data = await api(`/api/capabilities?skill_id=${encodeURIComponent(sid)}`);
      box.innerHTML = data.people.length
        ? `<div class="card">${data.people.map((p) => `
            <div class="cap-row">
              <div class="cap-name">${esc(p.name)}</div>
              <div class="cap-bar-wrap"><div class="cap-bar" style="width:${p.score * 10}%"></div></div>
              <div class="cap-score">${p.score}/10</div>
              <div class="cap-period">${esc(p.period)}</div>
            </div>`).join("")}</div>`
        : `<div class="notice info">Nobody has a rating for that skill yet (all N/A or no reviews on file).</div>`;
    } catch (e) {
      box.innerHTML = `<div class="notice err">${esc(e.message)}</div>`;
    }
  };

  // team matrix
  const matrixBox = $("#cap-matrix");
  try {
    const people = await api("/api/capabilities");
    if (!people.length) {
      matrixBox.innerHTML = `<div class="notice info">No reviews on file yet.</div>`;
      return;
    }
    const catAvg = (ratings, cat) => {
      const vals = cat.skills.map((s) => ratings[s.id]).filter((v) => v != null);
      return vals.length ? Math.round((vals.reduce((a, b) => a + b) / vals.length) * 10) / 10 : null;
    };
    const shade = (v) => {
      if (v == null) return "background:#f6f7f9;color:#9aa1ab";
      const hue = 12 + (v / 10) * 120; // red → green
      return `background:hsl(${hue} 70% 90%);font-weight:700`;
    };
    matrixBox.innerHTML = `
      <div class="card hm-scroll">
        <table class="heatmap">
          <thead><tr><th class="rowh">Category</th>${people.map((p) => `<th>${esc(p.name)}<br><span style="font-weight:400;color:var(--muted)">${esc(p.period)}</span></th>`).join("")}</tr></thead>
          <tbody>${cats.map((cat) => `
            <tr><th class="rowh">${esc(cat.name)}</th>${people.map((p) => {
              const v = catAvg(p.ratings, cat);
              return `<td style="${shade(v)}">${v ?? "–"}</td>`;
            }).join("")}</tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  } catch (e) {
    matrixBox.innerHTML = `<div class="notice err">${esc(e.message)}</div>`;
  }
}

/* ---------------------------------------------------------------- tab: goals */

async function renderGoals() {
  const panel = $("#tab-goals");
  if (!state.me) return needSignIn(panel);

  const subjects = isMentor()
    ? state.users
    : state.users.filter((u) => u.id === state.me.id);

  panel.innerHTML = `
    <h2>Goal History</h2>
    <p class="sub">Every quarter's 3-month, 6-month, and 1-year goals — newest first. Pull this up in a one-on-one to see whether last quarter's goals landed.</p>
    <div class="controls">
      <div><label>Person</label><select id="gl-subject">${userOptions(subjects, state.me.id)}</select></div>
    </div>
    <div id="gl-result"></div>`;

  $("#gl-subject").onchange = loadGoals;
  await loadGoals();
}

async function loadGoals() {
  const subjectId = Number($("#gl-subject").value);
  const box = $("#gl-result");
  let entries;
  try {
    entries = await api(`/api/goals?subject_id=${subjectId}&viewer_id=${state.me.id}&pin=${encodeURIComponent(state.me.pin)}`);
  } catch (e) {
    box.innerHTML = `<div class="notice err">${esc(e.message)}</div>`;
    return;
  }
  if (!entries.length) {
    box.innerHTML = `<div class="notice info">No goals on file yet — goals are saved with each review submission.</div>`;
    return;
  }
  const byPeriod = {};
  for (const e of entries) (byPeriod[e.period] ??= []).push(e);

  box.innerHTML = Object.keys(byPeriod).sort().reverse().map((period) => `
    <div class="goal-quarter">
      <h3>${esc(period)}</h3>
      <div class="goal-cols">
        ${byPeriod[period].map((g) => `
          <div class="goal-card card">
            <h4>${g.role === "self" ? "Their own goals" : `Mentor (${esc(g.assessor_name)})`}
              <span class="stamp">${fmtStamp(g.submitted_at)}</span></h4>
            <dl>
              <dt>3-month</dt><dd class="${g.goals_3m ? "" : "empty"}">${esc(g.goals_3m) || "—"}</dd>
              <dt>6-month</dt><dd class="${g.goals_6m ? "" : "empty"}">${esc(g.goals_6m) || "—"}</dd>
              <dt>1-year</dt><dd class="${g.goals_1y ? "" : "empty"}">${esc(g.goals_1y) || "—"}</dd>
            </dl>
          </div>`).join("")}
      </div>
    </div>`).join("");
}

/* ---------------------------------------------------------------- tab: team */

async function renderTeam() {
  const panel = $("#tab-team");
  panel.innerHTML = `
    <h2>Team</h2>
    <p class="sub">Everyone in the company. Apprentices review themselves; mentors can review anyone. Each person sets their own 4-digit PIN the first time they sign in.</p>
    <div class="card">
      <div class="controls" style="margin-bottom:0">
        <div><label>Name</label><input id="tm-name" placeholder="e.g. Sam Rivera"></div>
        <div><label>Role</label>
          <select id="tm-role">
            <option value="apprentice">Apprentice</option>
            <option value="mentor">Mentor</option>
            <option value="both">Both (mentors & is mentored)</option>
          </select></div>
        <button class="primary" id="tm-add">Add person</button>
      </div>
    </div>
    <div class="card" id="tm-list">
      ${state.users.map((u) => `
        <div class="team-row">
          <span class="t-name">${esc(u.name)}</span>
          <span class="role-tag">${esc(u.role)}</span>
          <span class="role-tag">${u.has_pin ? "PIN set" : "no PIN yet"}</span>
        </div>`).join("") || `<div class="notice info">Nobody here yet — add your crew above.</div>`}
    </div>`;

  $("#tm-add").onclick = async () => {
    const name = $("#tm-name").value.trim();
    const role = $("#tm-role").value;
    if (!name) return toast("Enter a name", true);
    try {
      await api("/api/users", { method: "POST", body: JSON.stringify({ name, role }) });
      toast(`${name} added`);
      state.users = await api("/api/users");
      renderIdentity();
      renderTeam();
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/* ---------------------------------------------------------------- boot */

const RENDERERS = {
  assess: renderAssess,
  oneonone: renderOneOnOne,
  progress: renderProgress,
  capabilities: renderCapabilities,
  goals: renderGoals,
  team: renderTeam,
};

function activeTab() {
  return $("#tabs button.active").dataset.tab;
}

function renderActiveTab() {
  RENDERERS[activeTab()]();
}

async function init() {
  [state.config, state.users] = await Promise.all([
    api("/api/config"),
    api("/api/users"),
  ]);

  const saved = localStorage.getItem("tst_me");
  if (saved) {
    try {
      const me = JSON.parse(saved);
      state.me = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ user_id: me.id, pin: me.pin }),
      }).then((u) => ({ ...u, pin: me.pin }));
    } catch {
      localStorage.removeItem("tst_me");
    }
  }

  renderIdentity();
  $("#tabs").querySelectorAll("button").forEach((btn) => {
    btn.onclick = () => {
      $("#tabs button.active").classList.remove("active");
      btn.classList.add("active");
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      $(`#tab-${btn.dataset.tab}`).classList.add("active");
      renderActiveTab();
    };
  });
  renderActiveTab();
}

init().catch((e) => toast("Failed to load: " + e.message, true));
