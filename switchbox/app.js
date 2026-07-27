(() => {
  "use strict";

  const STORAGE_KEY = "switchbox_state_v3";

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

  const CABLE_TYPES = {
    "14-2": { display: "14/2 w/G", gauge: "14", conductors: ["black", "white", "ground"] },
    "12-2": { display: "12/2 w/G", gauge: "12", conductors: ["black", "white", "ground"] },
    "14-3": { display: "14/3 w/G", gauge: "14", conductors: ["black", "white", "red", "ground"] },
  };

  let uidCounter = 1;
  const uid = () => `id${Date.now().toString(36)}${(uidCounter++).toString(36)}`;
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function defaultState() {
    const swId = uid();
    return {
      gangs: 1,
      viewMode: "visual",
      layers: { black: true, white: true, red: true, ground: true },
      switches: [{ id: swId, type: "single-pole" }],
      cables: [],
      wires: [],
      nuts: [],
      terminals: { [swId]: { line: null, load: null, ground: null } },
    };
  }

  let state = loadState();
  let selectedForBundle = new Set();
  let currentStepIndex = 0;
  let modalTarget = null; // { switchId, key }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (!parsed.viewMode) parsed.viewMode = "visual";
        if (!parsed.layers) parsed.layers = { black: true, white: true, red: true, ground: true };
        return parsed;
      }
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
  const cableById = (id) => state.cables.find((c) => c.id === id);

  function wireDisplayLabel(w) {
    if (w.isPigtail) return `Pigtail — ${COLOR_LABEL[w.color]}`;
    const cable = cableById(w.cableId);
    return `${cable ? cable.label : "Wire"} — ${COLOR_LABEL[w.color]}`;
  }
  function wireFull(w) {
    return `${wireDisplayLabel(w)} (${w.gauge} AWG)`;
  }

  function nutDominantGauge(nut) {
    const gauges = nut.wireIds.map((id) => wireById(id)?.gauge).filter(Boolean);
    if (gauges.length && gauges.every((g) => g === gauges[0])) return gauges[0];
    return "14";
  }

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

  function setViewMode(mode) {
    if (mode !== "visual" && mode !== "schematic") return;
    state.viewMode = mode;
    saveState();
    render();
  }

  function toggleLayer(color) {
    if (!(color in state.layers)) return;
    state.layers[color] = !state.layers[color];
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

  function addCable(label, typeKey) {
    const type = CABLE_TYPES[typeKey];
    if (!type) return;
    const cableId = uid();
    state.cables.push({ id: cableId, label: label.trim() || "Unnamed cable", type: typeKey });
    type.conductors.forEach((color) => {
      state.wires.push({ id: uid(), cableId, color, gauge: type.gauge });
    });
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

  function deletePigtail(wireId) {
    clearConnectionsToWire(wireId);
    state.wires = state.wires.filter((w) => w.id !== wireId);
    selectedForBundle.delete(wireId);
  }

  function dissolveNutIfTooSmall(nut) {
    if (nut.wireIds.length < 2) {
      // a pigtail only exists to feed this splice — it can't survive without it
      nut.wireIds.forEach((wireId) => {
        const w = wireById(wireId);
        if (w && w.isPigtail) deletePigtail(wireId);
      });
      state.nuts = state.nuts.filter((n) => n.id !== nut.id);
    }
  }

  function deleteWire(wireId) {
    const wire = wireById(wireId);
    state.wires = state.wires.filter((w) => w.id !== wireId);
    state.nuts.forEach((n) => {
      n.wireIds = n.wireIds.filter((id) => id !== wireId);
    });
    state.nuts.slice().forEach((n) => dissolveNutIfTooSmall(n));
    clearConnectionsToWire(wireId);
    selectedForBundle.delete(wireId);
    if (wire && !state.wires.some((w) => w.cableId === wire.cableId)) {
      state.cables = state.cables.filter((c) => c.id !== wire.cableId);
    }
    saveState();
    render();
  }

  function deleteCable(cableId) {
    const conductorIds = state.wires.filter((w) => w.cableId === cableId).map((w) => w.id);
    conductorIds.forEach((id) => {
      state.nuts.forEach((n) => {
        n.wireIds = n.wireIds.filter((wid) => wid !== id);
      });
      clearConnectionsToWire(id);
      selectedForBundle.delete(id);
    });
    state.nuts.slice().forEach((n) => dissolveNutIfTooSmall(n));
    state.wires = state.wires.filter((w) => w.cableId !== cableId);
    state.cables = state.cables.filter((c) => c.id !== cableId);
    saveState();
    render();
  }

  function renameCable(cableId, label) {
    const cable = cableById(cableId);
    if (!cable) return;
    cable.label = label.trim() || cable.label;
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
    const wire = wireById(wireId);
    nut.wireIds = nut.wireIds.filter((id) => id !== wireId);
    if (wire && wire.isPigtail) deletePigtail(wireId);
    dissolveNutIfTooSmall(nut);
    saveState();
    render();
  }

  function addPigtail(nutId, color) {
    const nut = nutById(nutId);
    if (!nut) return;
    const gauge = nutDominantGauge(nut);
    const wire = { id: uid(), cableId: null, color, gauge, isPigtail: true };
    state.wires.push(wire);
    nut.wireIds.push(wire.id);
    saveState();
    render();
  }

  function deleteNut(nutId) {
    const nut = nutById(nutId);
    if (!nut) return;
    nut.wireIds.forEach((wireId) => {
      const w = wireById(wireId);
      if (w && w.isPigtail) deletePigtail(wireId);
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
    if (!confirm("Clear the box, all cables, wire nuts, and connections? This can't be undone.")) return;
    uidCounter = 1;
    state = defaultState();
    selectedForBundle.clear();
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
        return w ? wireFull(w) : "";
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

    if (state.cables.length > 0) {
      steps.push({
        title: "Strip the Cables",
        desc:
          "Strip the outer jacket back and strip about ¾ inch of insulation from the end of each conductor: " +
          state.cables
            .map((c) => `${escapeHtml(c.label)} (${CABLE_TYPES[c.type].display})`)
            .join("; ") +
          ".",
        highlight: { wires: state.wires.map((w) => w.id) },
      });
    }

    const used = new Set();
    const pushNutStep = (nut) => {
      const pigtails = nut.wireIds.map(wireById).filter((w) => w && w.isPigtail);
      let desc = `Twist together ${escapeHtml(describeWireNutWires(nut))} and cap with a wire nut.`;
      if (pigtails.length) {
        desc += ` Cut ${pigtails.length > 1 ? "pigtails" : "a pigtail"} of matching gauge from scrap wire and strip both ends before twisting ${pigtails.length > 1 ? "them" : "it"} in.`;
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
        const w = wireById(conn.id);
        if (!w) return;
        const sourceDesc = escapeHtml(wireFull(w));
        const screwDesc = t.screw === "green" ? "green ground screw" : t.screw === "black" ? "dark common screw" : "brass screw";
        steps.push({
          title: `Switch ${idx + 1}: ${t.label}`,
          desc: `Connect ${sourceDesc} to the ${t.label} (${screwDesc}) on switch ${idx + 1}.`,
          highlight: {
            terminals: [{ switchId: sw.id, key: t.key }],
            wires: [conn.id],
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
    renderCables();
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
    const w = wireById(conn.id);
    if (!w) return { text: "Not connected", empty: true };
    return { text: escapeHtml(wireFull(w)), empty: false };
  }

  function renderDiagram() {
    document.querySelectorAll("#viewModeSelect .seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === state.viewMode);
    });
    document.getElementById("diagramHint").textContent =
      state.viewMode === "visual"
        ? "Wires sticking out of the box are unconnected. Click one to select it for a wire nut, or click a terminal screw to land a wire on it."
        : "Terminals show what's currently landed on each screw. Click a terminal to connect a wire.";

    const visualEl = document.getElementById("boxDiagramVisual");
    const schematicEl = document.getElementById("boxDiagram");
    const isVisual = state.viewMode === "visual";
    visualEl.classList.toggle("hidden", !isVisual);
    schematicEl.classList.toggle("hidden", isVisual);
    document.getElementById("layerToggle").classList.toggle("hidden", !isVisual);

    document.querySelectorAll("#layerToggle .layer-chip").forEach((btn) => {
      btn.classList.toggle("off", !state.layers[btn.dataset.layer]);
    });

    if (isVisual) renderVisualDiagram();
    else renderSchematicDiagram();
  }

  function renderSchematicDiagram() {
    const el = document.getElementById("boxDiagram");
    el.innerHTML = state.switches
      .map((sw, idx) => {
        const def = SWITCH_TYPES[sw.type];
        const rows = def.terminals
          .map((t) => {
            const conn = state.terminals[sw.id]?.[t.key];
            const info = connectionInfo(conn);
            return `
          <div class="terminal-row terminal-marker" data-switch-id="${sw.id}" data-term-key="${t.key}">
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

  // ---------- visual box diagram ----------
  const VIZ = { gangW: 132, boxTop: 70, boxH: 250, wireStep: 20, stubH: 30, cableSlot: 118, nutSlot: 56, sidePad: 40, nutHeadroom: 54 };

  function vizGeometry() {
    const gangs = state.gangs;
    const boxW = gangs * VIZ.gangW;
    const cablesW = state.cables.length > 0 ? state.cables.length * VIZ.cableSlot : 0;
    const nutsW = state.nuts.length > 0 ? state.nuts.length * VIZ.nutSlot : 0;
    const contentW = Math.max(boxW, cablesW, nutsW);
    const boxX = VIZ.sidePad + (contentW - boxW) / 2;
    const boxY = VIZ.boxTop;
    const boxH = VIZ.boxH;
    const boxBottom = boxY + boxH;
    return {
      boxX,
      boxW,
      boxY,
      boxH,
      boxBottom,
      contentX: VIZ.sidePad,
      contentW,
      width: VIZ.sidePad * 2 + contentW,
      height: boxBottom + 78,
    };
  }

  function vizTerminalPositions(sw, slotX, geo) {
    const def = SWITCH_TYPES[sw.type];
    const nonGround = def.terminals.filter((t) => t.key !== "ground");
    const ground = def.terminals.find((t) => t.key === "ground");
    const top = geo.boxY + VIZ.nutHeadroom + 30;
    const bottom = geo.boxBottom - 70;
    const positions = {};
    nonGround.forEach((t, i) => {
      const y = nonGround.length === 1 ? (top + bottom) / 2 : top + ((bottom - top) * i) / (nonGround.length - 1);
      positions[t.key] = { x: slotX + VIZ.gangW - 34, y, t };
    });
    if (ground) positions[ground.key] = { x: slotX + 34, y: geo.boxBottom - 40, t: ground };
    return positions;
  }

  function vizBuildLayout() {
    const geo = vizGeometry();
    const terminalPos = {};
    state.switches.forEach((sw, i) => {
      const slotX = geo.boxX + i * VIZ.gangW;
      terminalPos[sw.id] = vizTerminalPositions(sw, slotX, geo);
    });

    const nutPos = {};
    state.nuts.forEach((nut, i) => {
      const n = state.nuts.length;
      const x = geo.contentX + (geo.contentW * (i + 1)) / (n + 1);
      nutPos[nut.id] = { x, y: geo.boxY + 18 };
    });

    const wirePos = {};
    const cableStubs = [];
    const cableGap = geo.contentW / (state.cables.length + 1);
    state.cables.forEach((cable, ci) => {
      const stubX = geo.contentX + cableGap * (ci + 1);
      const conductors = state.wires.filter((w) => w.cableId === cable.id);
      conductors.forEach((w, wi) => {
        const spread = (wi - (conductors.length - 1) / 2) * 17;
        wirePos[w.id] = { x: stubX + spread, y: geo.boxBottom - 46 - wi * VIZ.wireStep, stubX, stubY: geo.boxBottom };
      });
      cableStubs.push({ cable, x: stubX });
    });

    return { geo, terminalPos, nutPos, wirePos, cableStubs };
  }

  function vizNutSize(nut) {
    return nut.wireIds.length <= 2 ? "yellow" : nut.wireIds.length <= 4 ? "orange" : "red";
  }

  function renderVisualDiagram() {
    const { geo, terminalPos, nutPos, wirePos, cableStubs } = vizBuildLayout();
    const parts = [];

    // wall + box shell
    parts.push(`<rect class="viz-wall" x="0" y="0" width="${geo.width}" height="${geo.height}"></rect>`);
    parts.push(
      `<rect class="viz-box" x="${geo.boxX}" y="${geo.boxY}" width="${geo.boxW}" height="${geo.boxH}" rx="6"></rect>`
    );
    parts.push(
      `<rect class="viz-box-lip" x="${geo.boxX + 4}" y="${geo.boxY + 4}" width="${geo.boxW - 8}" height="${geo.boxH - 8}" rx="4"></rect>`
    );

    // device straps drawn first (background layer) so wires can visibly cross over them
    state.switches.forEach((sw, i) => {
      const slotX = geo.boxX + i * VIZ.gangW;
      const strapX = slotX + 22;
      const strapW = VIZ.gangW - 44;
      const strapY = geo.boxY + VIZ.nutHeadroom;
      const strapH = geo.boxH - VIZ.nutHeadroom - 36;
      parts.push(
        `<rect class="viz-strap" x="${strapX}" y="${strapY}" width="${strapW}" height="${strapH}" rx="5"></rect>`
      );
      parts.push(`<circle class="viz-mount-screw" cx="${strapX + strapW / 2}" cy="${strapY + 10}" r="3.5"></circle>`);
      parts.push(
        `<circle class="viz-mount-screw" cx="${strapX + strapW / 2}" cy="${strapY + strapH - 10}" r="3.5"></circle>`
      );
      parts.push(
        `<rect class="viz-toggle" x="${strapX + strapW / 2 - 8}" y="${strapY + strapH / 2 - 20}" width="16" height="40" rx="3"></rect>`
      );
      parts.push(
        `<text class="viz-device-label" x="${slotX + VIZ.gangW / 2}" y="${geo.boxY - 8}" text-anchor="middle">Switch ${i + 1}</text>`
      );
    });

    // connecting lines (drawn over the straps, under the terminal screws / endpoints)
    const lines = [];
    // every conductor's strand from its cable jacket up to its staging point — always visible,
    // this is the "wire coming out of the box" even before it's connected to anything
    state.wires
      .filter((w) => !w.isPigtail)
      .forEach((w) => {
        const pos = wirePos[w.id];
        if (!pos) return;
        lines.push({ x1: pos.stubX, y1: pos.stubY, x2: pos.x, y2: pos.y, color: w.color, wireId: w.id, strand: true });
      });
    state.nuts.forEach((nut) => {
      nut.wireIds.forEach((wireId) => {
        const w = wireById(wireId);
        if (!w || w.isPigtail) return;
        const pos = wirePos[wireId];
        if (!pos) return;
        lines.push({ x1: pos.x, y1: pos.y, x2: nutPos[nut.id].x, y2: nutPos[nut.id].y, color: w.color, wireId });
      });
    });
    state.wires
      .filter((w) => w.isPigtail)
      .forEach((w) => {
        const nut = state.nuts.find((n) => n.wireIds.includes(w.id));
        if (!nut) return;
        const from = nutPos[nut.id];
        const usage = wireUsage(w.id);
        if (usage.onTerminal) {
          const tp = terminalPos[usage.onTerminal.switchId]?.[usage.onTerminal.key];
          if (tp) lines.push({ x1: from.x, y1: from.y, x2: tp.x, y2: tp.y, color: w.color, wireId: w.id });
        } else {
          lines.push({ x1: from.x, y1: from.y, x2: from.x, y2: from.y + 28, color: w.color, wireId: w.id, dangling: true });
        }
      });
    state.switches.forEach((sw) => {
      const def = SWITCH_TYPES[sw.type];
      def.terminals.forEach((t) => {
        const conn = state.terminals[sw.id]?.[t.key];
        if (!conn) return;
        const w = wireById(conn.id);
        if (!w || w.isPigtail) return;
        const pos = wirePos[w.id];
        if (!pos) return;
        const tp = terminalPos[sw.id][t.key];
        lines.push({ x1: pos.x, y1: pos.y, x2: tp.x, y2: tp.y, color: w.color, wireId: w.id });
      });
    });

    lines.forEach((l) => {
      parts.push(
        `<path class="viz-line c-${l.color} ${l.dangling ? "dangling" : ""}" data-wire-id="${l.wireId}" d="M ${l.x1} ${l.y1} L ${l.x2} ${l.y2}"></path>`
      );
    });
    lines
      .filter((l) => l.dangling)
      .forEach((l) => {
        parts.push(`<circle class="viz-dangling-end c-${l.color}" cx="${l.x2}" cy="${l.y2}" r="4"></circle>`);
      });

    // terminal screws drawn after the lines so a landed wire visibly ends at the screw
    state.switches.forEach((sw) => {
      Object.values(terminalPos[sw.id]).forEach((tp) => {
        parts.push(`
          <g class="terminal-marker viz-terminal" data-switch-id="${sw.id}" data-term-key="${tp.t.key}">
            <circle class="viz-hit" cx="${tp.x}" cy="${tp.y}" r="14"></circle>
            <circle class="screw-${tp.t.screw}" cx="${tp.x}" cy="${tp.y}" r="8"></circle>
            <line x1="${tp.x - 4.5}" y1="${tp.y}" x2="${tp.x + 4.5}" y2="${tp.y}" class="viz-screw-slot"></line>
          </g>`);
      });
    });

    // wire nuts
    state.nuts.forEach((nut) => {
      const pos = nutPos[nut.id];
      const size = vizNutSize(nut);
      parts.push(`
        <g class="nut-marker viz-nut" data-nut-id="${nut.id}">
          <circle class="viz-hit" cx="${pos.x}" cy="${pos.y}" r="16"></circle>
          <path class="viz-nut-cap size-${size}" d="M ${pos.x - 11} ${pos.y + 9} Q ${pos.x - 11} ${pos.y - 13} ${pos.x} ${pos.y - 15} Q ${pos.x + 11} ${pos.y - 13} ${pos.x + 11} ${pos.y + 9} Z"></path>
        </g>`);
    });

    // cable stubs + wire endpoints
    const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
    cableStubs.forEach(({ cable, x }) => {
      const type = CABLE_TYPES[cable.type];
      parts.push(
        `<rect class="viz-jacket g${type.gauge}" x="${x - 11}" y="${geo.boxBottom - 4}" width="22" height="${VIZ.stubH}" rx="3"></rect>`
      );
      parts.push(
        `<text class="viz-cable-label" x="${x}" y="${geo.boxBottom + VIZ.stubH + 16}" text-anchor="middle">${escapeHtml(truncate(cable.label, 15))}</text>`
      );
      parts.push(
        `<text class="viz-cable-type" x="${x}" y="${geo.boxBottom + VIZ.stubH + 28}" text-anchor="middle">${type.display}</text>`
      );
    });

    state.wires
      .filter((w) => !w.isPigtail)
      .forEach((w) => {
        const pos = wirePos[w.id];
        if (!pos) return;
        const usage = wireUsage(w.id);
        const inUse = !!(usage.inNut || usage.onTerminal);
        const selected = selectedForBundle.has(w.id);
        const label = wireDisplayLabel(w);
        parts.push(`
          <g class="viz-wire-endpoint c-${w.color} ${inUse ? "used" : "free"} ${selected ? "selected" : ""}" data-wire-id="${w.id}">
            <circle class="viz-hit" cx="${pos.x}" cy="${pos.y}" r="13"></circle>
            <circle class="viz-endpoint-ring" cx="${pos.x}" cy="${pos.y}" r="9"></circle>
            <circle class="c-${w.color}" cx="${pos.x}" cy="${pos.y}" r="6"></circle>
            <title>${escapeHtml(label)} (${w.gauge} AWG)${inUse ? "" : " — click to select for a wire nut"}</title>
          </g>`);
      });

    const displayW = Math.round(Math.min(620, Math.max(300, geo.width * 1.7)));
    const layerClasses = Object.entries(state.layers)
      .filter(([, visible]) => !visible)
      .map(([color]) => `layer-${color}-off`)
      .join(" ");
    const svg = `<svg class="${layerClasses}" viewBox="0 0 ${geo.width} ${geo.height}" style="max-width:${displayW}px" preserveAspectRatio="xMidYMin meet" role="img" aria-label="Visual switch box diagram">${parts.join("")}</svg>`;
    document.getElementById("boxDiagramVisual").innerHTML = svg;
  }

  function conductorChip(w, { showActions } = { showActions: true }) {
    const usage = wireUsage(w.id);
    const isSelected = selectedForBundle.has(w.id);
    const inUse = !!(usage.inNut || usage.onTerminal);
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
        <span class="wire-color-dot c-${w.color}"></span>
        <span>
          <div class="w-label">${COLOR_LABEL[w.color]}</div>
          <div class="w-meta">${w.gauge} AWG${usageNote ? " · " + usageNote : ""}</div>
        </span>
        ${
          showActions
            ? `<span class="chip-actions">
          <button type="button" data-action="delete-wire" data-wire-id="${w.id}" title="Remove this conductor">✕</button>
        </span>`
            : ""
        }
      </div>`;
  }

  function renderCables() {
    const bundleBtn = document.getElementById("bundleBtn");
    bundleBtn.disabled = selectedForBundle.size < 2;

    const container = document.getElementById("cablesContainer");
    if (state.cables.length === 0) {
      container.innerHTML = `<p class="empty-note">No cables yet — pull one in above.</p>`;
      return;
    }

    container.innerHTML = state.cables
      .map((cable) => {
        const type = CABLE_TYPES[cable.type];
        const conductors = state.wires.filter((w) => w.cableId === cable.id);
        return `
        <div class="cable-card">
          <div class="cable-card-head">
            <span class="jacket-badge g${type.gauge}">${type.display}</span>
            <input type="text" class="cable-title-input" value="${escapeHtml(cable.label)}" data-action="rename-cable" data-cable-id="${cable.id}">
            <button type="button" class="nut-delete" data-action="delete-cable" data-cable-id="${cable.id}" title="Remove this cable">🗑</button>
          </div>
          <div class="cable-conductors">${conductors.map((w) => conductorChip(w)).join("")}</div>
        </div>`;
      })
      .join("");
  }

  function renderNuts() {
    const el = document.getElementById("nutsContainer");
    if (state.nuts.length === 0) {
      el.innerHTML = `<p class="empty-note">No wire nuts yet — select 2+ unassigned conductors above and twist them together.</p>`;
      return;
    }
    el.innerHTML = state.nuts
      .map((nut) => {
        const size = nut.wireIds.length <= 2 ? "yellow" : nut.wireIds.length <= 4 ? "orange" : "red";
        const wiresHtml = nut.wireIds
          .map((id) => {
            const w = wireById(id);
            if (!w) return "";
            let landedNote = "";
            if (w.isPigtail) {
              const usage = wireUsage(w.id);
              if (usage.onTerminal) {
                const sw = switchById(usage.onTerminal.switchId);
                const swIdx = state.switches.findIndex((s) => s.id === usage.onTerminal.switchId);
                const t = SWITCH_TYPES[sw.type].terminals.find((t) => t.key === usage.onTerminal.key);
                landedNote = ` → Switch ${swIdx + 1} – ${t.label}`;
              } else {
                landedNote = " · not yet landed";
              }
            }
            return `
            <div class="wire-chip" data-wire-id="${w.id}">
              <span class="wire-color-dot c-${w.color}"></span>
              <span class="w-label">${escapeHtml(wireDisplayLabel(w))}<span class="w-meta">${landedNote}</span></span>
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
        <div class="nut-card nut-marker" data-nut-id="${nut.id}">
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
              ${availableWires.map((w) => `<option value="${w.id}">${escapeHtml(wireFull(w))}</option>`).join("")}
            </select>
          </div>
          <div class="nut-pigtail-row">
            <select data-role="pigtail-color" data-nut-id="${nut.id}">
              <option value="black">Black</option>
              <option value="white">White</option>
              <option value="red">Red</option>
              <option value="ground">Bare/Ground</option>
            </select>
            <button type="button" class="btn btn-ghost" data-action="add-pigtail" data-nut-id="${nut.id}">+ Add Pigtail</button>
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
      document.querySelectorAll(`.nut-marker[data-nut-id="${id}"]`).forEach((elm) => elm.classList.add("highlight"));
    });
    (step.highlight.terminals || []).forEach(({ switchId, key }) => {
      document.querySelectorAll(`.terminal-marker[data-switch-id="${switchId}"][data-term-key="${key}"]`).forEach((elm) => elm.classList.add("highlight"));
    });
  }

  function flashNutCard(nutId) {
    const card = document.querySelector(`.nut-card[data-nut-id="${nutId}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("flash");
    setTimeout(() => card.classList.remove("flash"), 900);
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
      const isCurrent = current && current.id === w.id;
      if (isCurrent) return true;
      if (usage.onTerminal) return false;
      if (usage.inNut && !w.isPigtail) return false; // regular conductors are used up once spliced
      return true;
    });

    document.getElementById("terminalModalTitle").textContent = `Switch ${state.switches.indexOf(sw) + 1}: ${t.label}`;
    const body = document.getElementById("terminalModalBody");
    body.innerHTML = `
      <p class="hint">Choose a wire to land directly on this screw — including a pigtail already twisted into a wire nut.</p>
      <select id="terminalSelect">
        <option value="">— Not connected —</option>
        ${availableWires
          .map((w) => `<option value="wire:${w.id}" ${current && current.id === w.id ? "selected" : ""}>${escapeHtml(wireFull(w))}</option>`)
          .join("")}
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

    document.getElementById("cableForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const label = document.getElementById("cableLabel").value;
      const type = document.getElementById("cableType").value;
      addCable(label, type);
      document.getElementById("cableLabel").value = "";
      document.getElementById("cableLabel").focus();
    });

    document.getElementById("quickLabels").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-quick-label]");
      if (!btn) return;
      const input = document.getElementById("cableLabel");
      input.value = btn.dataset.quickLabel;
      input.focus();
    });

    document.getElementById("layerToggle").addEventListener("click", (e) => {
      const btn = e.target.closest(".layer-chip");
      if (btn) toggleLayer(btn.dataset.layer);
    });

    document.getElementById("bundleBtn").addEventListener("click", bundleSelected);

    document.getElementById("cablesContainer").addEventListener("click", (e) => {
      const delBtn = e.target.closest('[data-action="delete-wire"]');
      const delCableBtn = e.target.closest('[data-action="delete-cable"]');
      if (delBtn) {
        if (confirm("Remove this conductor? It will be removed from any wire nut or terminal it's connected to.")) deleteWire(delBtn.dataset.wireId);
        return;
      }
      if (delCableBtn) {
        if (confirm("Remove this whole cable and all its conductors?")) deleteCable(delCableBtn.dataset.cableId);
        return;
      }
      const chip = e.target.closest('[data-role="chip"]');
      if (chip) toggleWireSelect(chip.dataset.wireId);
    });

    document.getElementById("cablesContainer").addEventListener(
      "blur",
      (e) => {
        if (e.target.dataset.action === "rename-cable") {
          renameCable(e.target.dataset.cableId, e.target.value);
        }
      },
      true
    );

    document.getElementById("nutsContainer").addEventListener("click", (e) => {
      const rm = e.target.closest('[data-action="remove-from-nut"]');
      const del = e.target.closest('[data-action="delete-nut"]');
      const addPigtailBtn = e.target.closest('[data-action="add-pigtail"]');
      if (rm) {
        removeWireFromNut(rm.dataset.nutId, rm.dataset.wireId);
        return;
      }
      if (del) {
        if (confirm("Delete this wire nut? Its wires will return to the unassigned pool.")) deleteNut(del.dataset.nutId);
        return;
      }
      if (addPigtailBtn) {
        const nutId = addPigtailBtn.dataset.nutId;
        const colorSelect = addPigtailBtn.closest(".nut-pigtail-row").querySelector('[data-role="pigtail-color"]');
        addPigtail(nutId, colorSelect.value);
        return;
      }
    });

    document.getElementById("nutsContainer").addEventListener("change", (e) => {
      if (e.target.dataset.action === "add-to-nut") {
        addWireToNut(e.target.dataset.nutId, e.target.value);
      }
    });

    document.getElementById("nutsContainer").addEventListener(
      "blur",
      (e) => {
        if (e.target.dataset.action === "rename-nut") {
          renameNut(e.target.dataset.nutId, e.target.value);
        }
      },
      true
    );

    document.getElementById("viewModeSelect").addEventListener("click", (e) => {
      const btn = e.target.closest(".seg-btn");
      if (btn) setViewMode(btn.dataset.mode);
    });

    const handleDiagramClick = (e) => {
      const term = e.target.closest(".terminal-marker");
      if (term) {
        openTerminalModal(term.dataset.switchId, term.dataset.termKey);
        return;
      }
      const wireEndpoint = e.target.closest(".viz-wire-endpoint");
      if (wireEndpoint) {
        toggleWireSelect(wireEndpoint.dataset.wireId);
        return;
      }
      const nutMarker = e.target.closest(".viz-nut");
      if (nutMarker) {
        flashNutCard(nutMarker.dataset.nutId);
        return;
      }
    };
    document.getElementById("boxDiagram").addEventListener("click", handleDiagramClick);
    document.getElementById("boxDiagramVisual").addEventListener("click", handleDiagramClick);

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
