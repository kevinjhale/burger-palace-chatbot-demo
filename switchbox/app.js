(() => {
  "use strict";

  const STORAGE_KEY = "switchbox_state_v1";

  const SWITCH_TYPES = {
    "single-pole": {
      label: "Single-Pole",
      terminals: [
        { key: "line", label: "Line (Hot In)", screw: "brass" },
        { key: "load", label: "Load (Hot Out)", screw: "brass" },
        { key: "ground", label: "Ground", screw: "green" },
      ],
    },
    "3-way": {
      label: "3-Way",
      terminals: [
        { key: "common", label: "Common", screw: "black" },
        { key: "traveler1", label: "Traveler 1", screw: "brass" },
        { key: "traveler2", label: "Traveler 2", screw: "brass" },
        { key: "ground", label: "Ground", screw: "green" },
      ],
    },
  };

  const COLOR_LABEL = { black: "Black", white: "White", red: "Red", ground: "Bare/Ground" };

  let uidCounter = 1;
  const uid = () => `id${Date.now().toString(36)}${(uidCounter++).toString(36)}`;
  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function defaultState() {
    const swId = uid();
    return {
      gangs: 1,
      switches: [{ id: swId, type: "single-pole" }],
      wires: [],
      nuts: [],
      terminals: { [swId]: { line: null, load: null, ground: null } },
    };
  }

  let state = loadState();
  let selectedForBundle = new Set();
  let editingWireId = null;
  let currentStepIndex = 0;
  let modalTarget = null; // { switchId, key }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.warn("Could not load saved state", e);
    }
    return defaultState();
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn("Could not save state", e);
    }
  }

  // ---------- lookups ----------
  const wireById = (id) => state.wires.find((w) => w.id === id);
  const nutById = (id) => state.nuts.find((n) => n.id === id);
  const switchById = (id) => state.switches.find((s) => s.id === id);

  function wireUsage(wireId) {
    const inNut = state.nuts.find((n) => n.wireIds.includes(wireId));
    let onTerminal = null;
    for (const sw of state.switches) {
      const termMap = state.terminals[sw.id] || {};
      for (const key of Object.keys(termMap)) {
        const conn = termMap[key];
        if (conn && conn.type === "wire" && conn.id === wireId) {
          onTerminal = { switchId: sw.id, key };
        }
      }
    }
    return { inNut: inNut ? inNut.id : null, onTerminal };
  }

  function terminalsReferencingNut(nutId) {
    const refs = [];
    state.switches.forEach((sw, idx) => {
      const def = SWITCH_TYPES[sw.type];
      const termMap = state.terminals[sw.id] || {};
      def.terminals.forEach((t) => {
        const conn = termMap[t.key];
        if (conn && conn.type === "nut" && conn.id === nutId) {
          refs.push({ switchIdx: idx, label: t.label });
        }
      });
    });
    return refs;
  }

  // ---------- mutations ----------
  function initTerminalsForSwitch(sw) {
    const def = SWITCH_TYPES[sw.type];
    state.terminals[sw.id] = {};
    def.terminals.forEach((t) => (state.terminals[sw.id][t.key] = null));
  }

  function setGangs(n) {
    const old = state.switches;
    state.gangs = n;
    const next = [];
    for (let i = 0; i < n; i++) {
      if (old[i]) next.push(old[i]);
      else {
        const sw = { id: uid(), type: "single-pole" };
        initTerminalsForSwitch(sw);
        next.push(sw);
      }
    }
    // clean up terminals for removed switches
    const keepIds = new Set(next.map((s) => s.id));
    Object.keys(state.terminals).forEach((swId) => {
      if (!keepIds.has(swId)) delete state.terminals[swId];
    });
    state.switches = next;
    saveState();
    render();
  }

  function setSwitchType(swId, type) {
    const sw = switchById(swId);
    if (!sw || sw.type === type) return;
    sw.type = type;
    initTerminalsForSwitch(sw);
    saveState();
    render();
  }

  function addWire(label, gauge, color) {
    state.wires.push({ id: uid(), label: label.trim() || "Unnamed wire", gauge, color });
    saveState();
    render();
  }

  function updateWire(wireId, label, gauge, color) {
    const w = wireById(wireId);
    if (!w) return;
    w.label = label.trim() || "Unnamed wire";
    w.gauge = gauge;
    w.color = color;
    editingWireId = null;
    saveState();
    render();
  }

  function clearConnectionsToWire(wireId) {
    Object.keys(state.terminals).forEach((swId) => {
      const termMap = state.terminals[swId];
      Object.keys(termMap).forEach((key) => {
        const conn = termMap[key];
        if (conn && conn.type === "wire" && conn.id === wireId) termMap[key] = null;
      });
    });
  }

  function dissolveNutIfTooSmall(nut) {
    if (nut.wireIds.length < 2) {
      // clear any pigtail references to this nut
      Object.keys(state.terminals).forEach((swId) => {
        const termMap = state.terminals[swId];
        Object.keys(termMap).forEach((key) => {
          const conn = termMap[key];
          if (conn && conn.type === "nut" && conn.id === nut.id) termMap[key] = null;
        });
      });
      state.nuts = state.nuts.filter((n) => n.id !== nut.id);
    }
  }

  function deleteWire(wireId) {
    state.wires = state.wires.filter((w) => w.id !== wireId);
    state.nuts.forEach((n) => {
      n.wireIds = n.wireIds.filter((id) => id !== wireId);
    });
    state.nuts.slice().forEach((n) => dissolveNutIfTooSmall(n));
    clearConnectionsToWire(wireId);
    selectedForBundle.delete(wireId);
    saveState();
    render();
  }

  function toggleWireSelect(wireId) {
    const usage = wireUsage(wireId);
    if (usage.inNut || usage.onTerminal) return; // can't bundle a wire already in use
    if (selectedForBundle.has(wireId)) selectedForBundle.delete(wireId);
    else selectedForBundle.add(wireId);
    render();
  }

  function bundleSelected() {
    if (selectedForBundle.size < 2) return;
    const nut = { id: uid(), label: `Wire Nut ${state.nuts.length + 1}`, wireIds: [...selectedForBundle] };
    state.nuts.push(nut);
    selectedForBundle.clear();
    saveState();
    render();
  }

  function addWireToNut(nutId, wireId) {
    if (!wireId) return;
    const nut = nutById(nutId);
    if (!nut) return;
    const usage = wireUsage(wireId);
    if (usage.inNut) {
      const oldNut = nutById(usage.inNut);
      oldNut.wireIds = oldNut.wireIds.filter((id) => id !== wireId);
      dissolveNutIfTooSmall(oldNut);
    }
    clearConnectionsToWire(wireId);
    nut.wireIds.push(wireId);
    saveState();
    render();
  }

  function removeWireFromNut(nutId, wireId) {
    const nut = nutById(nutId);
    if (!nut) return;
    nut.wireIds = nut.wireIds.filter((id) => id !== wireId);
    dissolveNutIfTooSmall(nut);
    saveState();
    render();
  }

  function deleteNut(nutId) {
    const nut = nutById(nutId);
    if (!nut) return;
    Object.keys(state.terminals).forEach((swId) => {
      const termMap = state.terminals[swId];
      Object.keys(termMap).forEach((key) => {
        const conn = termMap[key];
        if (conn && conn.type === "nut" && conn.id === nutId) termMap[key] = null;
      });
    });
    state.nuts = state.nuts.filter((n) => n.id !== nutId);
    saveState();
    render();
  }

  function renameNut(nutId, label) {
    const nut = nutById(nutId);
    if (!nut) return;
    nut.label = label.trim() || nut.label;
    saveState();
    render();
  }

  function setTerminalConnection(switchId, key, value) {
    if (!value) {
      state.terminals[switchId][key] = null;
    } else {
      const [type, id] = value.split(":");
      if (type === "wire") clearConnectionsToWire(id);
      state.terminals[switchId][key] = { type, id };
    }
    saveState();
    render();
  }

  function resetAll() {
    if (!confirm("Clear the box, all wires, wire nuts, and connections? This can't be undone.")) return;
    uidCounter = 1;
    state = defaultState();
    selectedForBundle.clear();
    editingWireId = null;
    currentStepIndex = 0;
    saveState();
    render();
  }

  // ---------- step generation ----------
  function nutIsAllColor(nut, color) {
    return nut.wireIds.length > 0 && nut.wireIds.every((id) => wireById(id)?.color === color);
  }

  function describeWireNutWires(nut) {
    return nut.wireIds
      .map((id) => {
        const w = wireById(id);
        return w ? `${w.gauge} AWG ${COLOR_LABEL[w.color]} ("${escapeHtml(w.label)}")` : "";
      })
      .filter(Boolean)
      .join(", ");
  }

  function nutWarning(nut) {
    const wires = nut.wireIds.map(wireById).filter(Boolean);
    if (wires.length < 2) return null;
    const gauges = new Set(wires.map((w) => w.gauge));
    const hasGround = wires.some((w) => w.color === "ground");
    const hasNonGround = wires.some((w) => w.color !== "ground");
    if (gauges.size > 1) return "Mixes 12 AWG and 14 AWG — confirm your connector is rated for both.";
    if (hasGround && hasNonGround) return "Mixes a ground wire with a non-ground wire — double check this is intentional.";
    return null;
  }

  function generateSteps() {
    const steps = [];
    steps.push({
      title: "Turn Off the Power",
      desc: "At the breaker panel, switch off the circuit you'll be working on, then confirm it's dead at the box with a non-contact voltage tester.",
    });
    steps.push({
      title: "Mount the Box",
      desc: `Secure the ${state.gangs}-gang box in the opening so its front edge sits flush with the finished wall surface, then feed the cables in through the knockouts and clamp them.`,
    });

    if (state.wires.length > 0) {
      steps.push({
        title: "Strip the Wires",
        desc:
          "Strip about ¾ inch of insulation from the end of each conductor: " +
          state.wires.map((w) => `${escapeHtml(w.label)} (${COLOR_LABEL[w.color]}, ${w.gauge} AWG)`).join("; ") +
          ".",
        highlight: { wires: state.wires.map((w) => w.id) },
      });
    }

    const used = new Set();
    const pushNutStep = (nut) => {
      const refs = terminalsReferencingNut(nut.id);
      let desc = `Twist together ${describeWireNutWires(nut)} and cap with a wire nut.`;
      if (refs.length) {
        desc += " This bundle also feeds a pigtail to: " + refs.map((r) => `Switch ${r.switchIdx + 1} (${r.label})`).join(", ") + ".";
      }
      const warn = nutWarning(nut);
      if (warn) desc += ` Note: ${warn}`;
      steps.push({
        title: `Splice: ${escapeHtml(nut.label)}`,
        desc,
        highlight: { nuts: [nut.id], wires: nut.wireIds },
      });
      used.add(nut.id);
    };

    state.nuts.filter((n) => nutIsAllColor(n, "ground")).forEach(pushNutStep);
    state.nuts.filter((n) => !used.has(n.id) && nutIsAllColor(n, "white")).forEach(pushNutStep);
    state.nuts.filter((n) => !used.has(n.id)).forEach(pushNutStep);

    state.switches.forEach((sw, idx) => {
      const def = SWITCH_TYPES[sw.type];
      def.terminals.forEach((t) => {
        const conn = state.terminals[sw.id]?.[t.key];
        if (!conn) return;
        let sourceDesc;
        if (conn.type === "wire") {
          const w = wireById(conn.id);
          if (!w) return;
          sourceDesc = `the ${COLOR_LABEL[w.color]} wire "${escapeHtml(w.label)}" (${w.gauge} AWG)`;
        } else {
          const n = nutById(conn.id);
          if (!n) return;
          sourceDesc = `a pigtail from the "${escapeHtml(n.label)}" wire nut`;
        }
        const screwDesc = t.screw === "green" ? "green ground screw" : t.screw === "black" ? "dark common screw" : "brass screw";
        steps.push({
          title: `Switch ${idx + 1}: ${t.label}`,
          desc: `Connect ${sourceDesc} to the ${t.label} (${screwDesc}) on switch ${idx + 1}.`,
          highlight: {
            terminals: [{ switchId: sw.id, key: t.key }],
            wires: conn.type === "wire" ? [conn.id] : [],
            nuts: conn.type === "nut" ? [conn.id] : [],
          },
        });
      });
    });

    steps.push({
      title: "Fold Wires Into the Box",
      desc: "Gently fold the spliced wires and wire nuts back into the box, then screw the switch(es) to the box ears, keeping everything centered and level.",
    });
    steps.push({
      title: "Attach the Cover Plate & Restore Power",
      desc: "Install the wall plate, restore power at the breaker, and test each switch.",
    });

    return steps;
  }

  // ---------- rendering ----------
  function render() {
    renderGangSelect();
    renderSwitchTypes();
    renderDiagram();
    renderWirePool();
    renderNuts();
    renderSteps();
  }

  function renderGangSelect() {
    document.querySelectorAll("#gangSelect .seg-btn").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.gang) === state.gangs);
    });
  }

  function renderSwitchTypes() {
    const el = document.getElementById("switchTypeList");
    el.innerHTML = state.switches
      .map(
        (sw, idx) => `
      <div class="switch-type-row">
        <label>Switch ${idx + 1}</label>
        <select data-switch-id="${sw.id}" class="switch-type-select">
          ${Object.entries(SWITCH_TYPES)
            .map(([key, def]) => `<option value="${key}" ${sw.type === key ? "selected" : ""}>${def.label}</option>`)
            .join("")}
        </select>
      </div>`
      )
      .join("");
  }

  function connectionInfo(conn) {
    if (!conn) return { text: "Not connected", empty: true };
    if (conn.type === "wire") {
      const w = wireById(conn.id);
      if (!w) return { text: "Not connected", empty: true };
      return { text: `${COLOR_LABEL[w.color]} ${w.gauge} AWG — ${escapeHtml(w.label)}`, empty: false };
    }
    const n = nutById(conn.id);
    if (!n) return { text: "Not connected", empty: true };
    return { text: `Pigtail from "${escapeHtml(n.label)}"`, empty: false };
  }

  function renderDiagram() {
    const el = document.getElementById("boxDiagram");
    el.innerHTML = state.switches
      .map((sw, idx) => {
        const def = SWITCH_TYPES[sw.type];
        const rows = def.terminals
          .map((t) => {
            const conn = state.terminals[sw.id]?.[t.key];
            const info = connectionInfo(conn);
            return `
          <div class="terminal-row" data-switch-id="${sw.id}" data-term-key="${t.key}">
            <span class="screw-dot screw-${t.screw}"></span>
            <div class="terminal-info">
              <div class="t-name">${t.label}</div>
              <div class="t-conn ${info.empty ? "empty" : ""}">${info.text}</div>
            </div>
          </div>`;
          })
          .join("");
        return `
        <div class="gang-device">
          <div class="gang-device-head">
            <strong>Switch ${idx + 1}</strong>
            <span>${def.label}</span>
          </div>
          ${rows}
        </div>`;
      })
      .join("");
  }

  function renderWirePool() {
    const bundleBtn = document.getElementById("bundleBtn");
    bundleBtn.disabled = selectedForBundle.size < 2;

    const pool = document.getElementById("wirePool");
    if (state.wires.length === 0) {
      pool.innerHTML = `<p class="empty-note">No wires yet — add one above.</p>`;
      return;
    }

    pool.innerHTML = state.wires
      .map((w) => {
        if (w.id === editingWireId) return renderWireEditForm(w);
        const usage = wireUsage(w.id);
        const isSelected = selectedForBundle.has(w.id);
        let usageNote = "";
        if (usage.inNut) usageNote = `in "${escapeHtml(nutById(usage.inNut)?.label || "?")}"`;
        else if (usage.onTerminal) {
          const sw = switchById(usage.onTerminal.switchId);
          const idx = state.switches.findIndex((s) => s.id === usage.onTerminal.switchId);
          const def = SWITCH_TYPES[sw.type];
          const t = def.terminals.find((t) => t.key === usage.onTerminal.key);
          usageNote = `on Switch ${idx + 1} – ${t.label}`;
        }
        return `
        <div class="wire-chip ${isSelected ? "selected" : ""}" data-wire-id="${w.id}" data-role="chip" title="${usageNote ? "In use " + usageNote : "Click to select for bundling"}">
          <span class="wire-jacket g${w.gauge}"></span>
          <span class="wire-color-dot c-${w.color}"></span>
          <span>
            <div class="w-label">${escapeHtml(w.label)}</div>
            <div class="w-meta">${w.gauge} AWG · ${COLOR_LABEL[w.color]}${usageNote ? " · " + usageNote : ""}</div>
          </span>
          <span class="chip-actions">
            <button type="button" data-action="edit-wire" data-wire-id="${w.id}" title="Edit">✎</button>
            <button type="button" data-action="delete-wire" data-wire-id="${w.id}" title="Delete">✕</button>
          </span>
        </div>`;
      })
      .join("");
  }

  function renderWireEditForm(w) {
    return `
      <div class="wire-chip" style="flex-direction:column; align-items:stretch; border-radius:10px;">
        <input type="text" data-edit="label" value="${escapeHtml(w.label)}" style="margin-bottom:4px;padding:4px;border:1px solid var(--border);border-radius:6px;">
        <div style="display:flex; gap:4px;">
          <select data-edit="gauge" style="flex:1;padding:4px;">
            <option value="14" ${w.gauge === "14" ? "selected" : ""}>14 AWG</option>
            <option value="12" ${w.gauge === "12" ? "selected" : ""}>12 AWG</option>
          </select>
          <select data-edit="color" style="flex:1;padding:4px;">
            ${Object.entries(COLOR_LABEL).map(([v, l]) => `<option value="${v}" ${w.color === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
        </div>
        <div style="display:flex; gap:4px; margin-top:6px;">
          <button type="button" class="btn btn-primary" data-action="save-wire" data-wire-id="${w.id}" style="flex:1;">Save</button>
          <button type="button" class="btn btn-ghost" data-action="cancel-edit-wire" style="flex:1;">Cancel</button>
        </div>
      </div>`;
  }

  function renderNuts() {
    const el = document.getElementById("nutsContainer");
    if (state.nuts.length === 0) {
      el.innerHTML = `<p class="empty-note">No wire nuts yet — select 2+ unassigned wires above and twist them together.</p>`;
      return;
    }
    el.innerHTML = state.nuts
      .map((nut) => {
        const size = nut.wireIds.length <= 2 ? "yellow" : nut.wireIds.length <= 4 ? "orange" : "red";
        const wiresHtml = nut.wireIds
          .map((id) => {
            const w = wireById(id);
            if (!w) return "";
            return `
            <div class="wire-chip" data-wire-id="${w.id}">
              <span class="wire-jacket g${w.gauge}"></span>
              <span class="wire-color-dot c-${w.color}"></span>
              <span class="w-label">${escapeHtml(w.label)}</span>
              <span class="chip-actions">
                <button type="button" data-action="remove-from-nut" data-nut-id="${nut.id}" data-wire-id="${w.id}" title="Remove from this wire nut">✕</button>
              </span>
            </div>`;
          })
          .join("");
        const availableWires = state.wires.filter((w) => {
          const usage = wireUsage(w.id);
          return !usage.inNut && !usage.onTerminal;
        });
        const warn = nutWarning(nut);
        return `
        <div class="nut-card" data-nut-id="${nut.id}">
          <div class="nut-card-head">
            <span class="nut-cap size-${size}"></span>
            <input type="text" class="nut-title-input" value="${escapeHtml(nut.label)}" data-action="rename-nut" data-nut-id="${nut.id}">
            <button type="button" class="nut-delete" data-action="delete-nut" data-nut-id="${nut.id}" title="Delete wire nut">🗑</button>
          </div>
          <div class="nut-wires">${wiresHtml}</div>
          ${warn ? `<div class="nut-warning">⚠ ${warn}</div>` : ""}
          <div class="nut-add-row">
            <select data-action="add-to-nut" data-nut-id="${nut.id}">
              <option value="">+ Add wire to this nut…</option>
              ${availableWires.map((w) => `<option value="${w.id}">${escapeHtml(w.label)} (${COLOR_LABEL[w.color]}, ${w.gauge} AWG)</option>`).join("")}
            </select>
          </div>
        </div>`;
      })
      .join("");
  }

  function renderSteps() {
    const steps = generateSteps();
    if (currentStepIndex >= steps.length) currentStepIndex = steps.length - 1;
    if (currentStepIndex < 0) currentStepIndex = 0;

    const stepCard = document.getElementById("stepCard");
    const step = steps[currentStepIndex];
    stepCard.innerHTML = step
      ? `
      <span class="step-num">Step ${currentStepIndex + 1} of ${steps.length}</span>
      <h4>${escapeHtml(step.title)}</h4>
      <p>${step.desc}</p>`
      : `<p class="empty-note">No steps yet.</p>`;

    document.getElementById("stepProgress").textContent = `${currentStepIndex + 1} / ${steps.length}`;
    document.getElementById("prevStep").disabled = currentStepIndex <= 0;
    document.getElementById("nextStep").disabled = currentStepIndex >= steps.length - 1;

    document.getElementById("allStepsList").innerHTML = steps
      .map((s, i) => `<li class="${i === currentStepIndex ? "active" : ""}" data-step-idx="${i}">${escapeHtml(s.title)}</li>`)
      .join("");

    applyHighlight(step);
  }

  function applyHighlight(step) {
    document.querySelectorAll(".highlight").forEach((elm) => elm.classList.remove("highlight"));
    if (!step || !step.highlight) return;
    (step.highlight.wires || []).forEach((id) => {
      document.querySelectorAll(`[data-wire-id="${id}"]`).forEach((elm) => elm.classList.add("highlight"));
    });
    (step.highlight.nuts || []).forEach((id) => {
      document.querySelectorAll(`.nut-card[data-nut-id="${id}"]`).forEach((elm) => elm.classList.add("highlight"));
    });
    (step.highlight.terminals || []).forEach(({ switchId, key }) => {
      document.querySelectorAll(`.terminal-row[data-switch-id="${switchId}"][data-term-key="${key}"]`).forEach((elm) => elm.classList.add("highlight"));
    });
  }

  // ---------- terminal modal ----------
  function openTerminalModal(switchId, key) {
    const sw = switchById(switchId);
    const def = SWITCH_TYPES[sw.type];
    const t = def.terminals.find((t) => t.key === key);
    modalTarget = { switchId, key };

    const current = state.terminals[switchId]?.[key];
    const availableWires = state.wires.filter((w) => {
      const usage = wireUsage(w.id);
      const isCurrent = current && current.type === "wire" && current.id === w.id;
      return isCurrent || (!usage.inNut && !usage.onTerminal);
    });

    document.getElementById("terminalModalTitle").textContent = `Switch ${state.switches.indexOf(sw) + 1}: ${t.label}`;
    const body = document.getElementById("terminalModalBody");
    body.innerHTML = `
      <p class="hint">Choose a wire to land directly on this screw, or a wire nut to run a pigtail from.</p>
      <select id="terminalSelect">
        <option value="">— Not connected —</option>
        <optgroup label="Wires">
          ${availableWires
            .map((w) => `<option value="wire:${w.id}" ${current && current.type === "wire" && current.id === w.id ? "selected" : ""}>${escapeHtml(w.label)} (${COLOR_LABEL[w.color]}, ${w.gauge} AWG)</option>`)
            .join("")}
        </optgroup>
        <optgroup label="Wire Nuts (pigtail)">
          ${state.nuts
            .map((n) => `<option value="nut:${n.id}" ${current && current.type === "nut" && current.id === n.id ? "selected" : ""}>${escapeHtml(n.label)}</option>`)
            .join("")}
        </optgroup>
      </select>`;
    document.getElementById("terminalModal").classList.remove("hidden");
  }

  function closeTerminalModal() {
    document.getElementById("terminalModal").classList.add("hidden");
    modalTarget = null;
  }

  // ---------- events ----------
  function wireInit() {
    document.getElementById("gangSelect").addEventListener("click", (e) => {
      const btn = e.target.closest(".seg-btn");
      if (btn) setGangs(Number(btn.dataset.gang));
    });

    document.getElementById("switchTypeList").addEventListener("change", (e) => {
      if (e.target.classList.contains("switch-type-select")) {
        setSwitchType(e.target.dataset.switchId, e.target.value);
      }
    });

    document.getElementById("wireForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const label = document.getElementById("wireLabel").value;
      const gauge = document.getElementById("wireGauge").value;
      const color = document.getElementById("wireColor").value;
      addWire(label, gauge, color);
      document.getElementById("wireLabel").value = "";
      document.getElementById("wireLabel").focus();
    });

    document.getElementById("bundleBtn").addEventListener("click", bundleSelected);

    document.getElementById("wirePool").addEventListener("click", (e) => {
      const editBtn = e.target.closest('[data-action="edit-wire"]');
      const delBtn = e.target.closest('[data-action="delete-wire"]');
      const saveBtn = e.target.closest('[data-action="save-wire"]');
      const cancelBtn = e.target.closest('[data-action="cancel-edit-wire"]');
      if (editBtn) {
        editingWireId = editBtn.dataset.wireId;
        render();
        return;
      }
      if (delBtn) {
        if (confirm("Delete this wire? It will be removed from any wire nut or terminal it's connected to.")) deleteWire(delBtn.dataset.wireId);
        return;
      }
      if (saveBtn) {
        const chip = saveBtn.closest(".wire-chip");
        const label = chip.querySelector('[data-edit="label"]').value;
        const gauge = chip.querySelector('[data-edit="gauge"]').value;
        const color = chip.querySelector('[data-edit="color"]').value;
        updateWire(saveBtn.dataset.wireId, label, gauge, color);
        return;
      }
      if (cancelBtn) {
        editingWireId = null;
        render();
        return;
      }
      const chip = e.target.closest('[data-role="chip"]');
      if (chip) toggleWireSelect(chip.dataset.wireId);
    });

    document.getElementById("nutsContainer").addEventListener("click", (e) => {
      const rm = e.target.closest('[data-action="remove-from-nut"]');
      const del = e.target.closest('[data-action="delete-nut"]');
      if (rm) {
        removeWireFromNut(rm.dataset.nutId, rm.dataset.wireId);
        return;
      }
      if (del) {
        if (confirm("Delete this wire nut? Its wires will return to the unassigned pool.")) deleteNut(del.dataset.nutId);
        return;
      }
    });

    document.getElementById("nutsContainer").addEventListener("change", (e) => {
      if (e.target.dataset.action === "add-to-nut") {
        addWireToNut(e.target.dataset.nutId, e.target.value);
      }
    });

    document.getElementById("nutsContainer").addEventListener("blur", (e) => {
      if (e.target.dataset.action === "rename-nut") {
        renameNut(e.target.dataset.nutId, e.target.value);
      }
    }, true);

    document.getElementById("boxDiagram").addEventListener("click", (e) => {
      const row = e.target.closest(".terminal-row");
      if (row) openTerminalModal(row.dataset.switchId, row.dataset.termKey);
    });

    document.getElementById("terminalCloseBtn").addEventListener("click", closeTerminalModal);
    document.getElementById("terminalModal").addEventListener("click", (e) => {
      if (e.target.id === "terminalModal") closeTerminalModal();
    });
    document.getElementById("terminalClearBtn").addEventListener("click", () => {
      if (modalTarget) setTerminalConnection(modalTarget.switchId, modalTarget.key, "");
      closeTerminalModal();
    });
    document.getElementById("terminalModalBody").addEventListener("change", (e) => {
      if (e.target.id === "terminalSelect" && modalTarget) {
        setTerminalConnection(modalTarget.switchId, modalTarget.key, e.target.value);
        closeTerminalModal();
      }
    });

    document.getElementById("prevStep").addEventListener("click", () => {
      currentStepIndex = Math.max(0, currentStepIndex - 1);
      renderSteps();
    });
    document.getElementById("nextStep").addEventListener("click", () => {
      currentStepIndex = currentStepIndex + 1;
      renderSteps();
    });
    document.getElementById("allStepsList").addEventListener("click", (e) => {
      const li = e.target.closest("[data-step-idx]");
      if (li) {
        currentStepIndex = Number(li.dataset.stepIdx);
        renderSteps();
      }
    });

    document.getElementById("resetBtn").addEventListener("click", resetAll);
    document.getElementById("printBtn").addEventListener("click", () => window.print());
  }

  wireInit();
  render();
})();
