const STATUS_COLUMNS = ["planejado", "em andamento", "com pendencia", "concluída"];
const STATUS_ATRASADA = "atrasada";
const PROJECT_PROGRESS_MACRO_NAME = "Projeto Agrupamento Materiais no ECO";
const FORCED_MACRO_TASK_NAMES = [
  "Levantamento de regras Negócio",
  "Desenho técnico da solução",
];
const STORAGE_KEY = "eco_kanban_overrides_v1";
const DATA_VERSION_KEY = "eco_dashboard_data_version_v1";
const AUTO_RELOAD_MS = 45000;
const SYNC_API_URL = "http://127.0.0.1:8787/api/queue-update";

const state = {
  tarefas: [],
  resolved: [],
  filtered: [],
  overrides: {},
  currentEditUid: null,
};

const el = {
  searchInput: document.getElementById("searchInput"),
  macroFilter: document.getElementById("macroFilter"),
  ownerFilter: document.getElementById("ownerFilter"),
  baselineStartFromFilter: document.getElementById("baselineStartFromFilter"),
  baselineStartToFilter: document.getElementById("baselineStartToFilter"),
  baselineApplyButton: document.getElementById("baselineApplyButton"),
  baselineClearButton: document.getElementById("baselineClearButton"),
  resetButton: document.getElementById("resetButton"),
  summaryCards: document.getElementById("summaryCards"),
  globalIda: document.getElementById("globalIda"),
  macroTimeline: document.getElementById("macroTimeline"),
  taskTableBody: document.getElementById("taskTableBody"),
  kanbanBoard: document.getElementById("kanbanBoard"),
  editDialog: document.getElementById("editDialog"),
  editTitle: document.getElementById("editTitle"),
  editStatus: document.getElementById("editStatus"),
  editOwner: document.getElementById("editOwner"),
  editProgress: document.getElementById("editProgress"),
  editRealStart: document.getElementById("editRealStart"),
  editRealFinish: document.getElementById("editRealFinish"),
  baselineStartText: document.getElementById("baselineStartText"),
  baselineFinishText: document.getElementById("baselineFinishText"),
  editForm: document.getElementById("editForm"),
};

function loadOverrides() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    state.overrides = raw ? JSON.parse(raw) : {};
  } catch {
    state.overrides = {};
  }
}

function persistOverrides() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.overrides));
}

function reconcileOverridesWithProjectData(data) {
  const currentVersion = String(data?.gerado_em || "");
  if (!currentVersion) return;
  const lastVersion = localStorage.getItem(DATA_VERSION_KEY) || "";
  if (lastVersion && lastVersion !== currentVersion) {
    state.overrides = {};
    persistOverrides();
  }
  localStorage.setItem(DATA_VERSION_KEY, currentVersion);
}

async function enqueueProjectSync(uid, updates) {
  try {
    const payload = {
      uid,
      timestamp: new Date().toISOString(),
      updates: {
        status_atual: updates.status_atual,
        evolucao_percentual_atual: updates.evolucao_percentual_atual,
        inicio_real: updates.inicio_real,
        termino_real: updates.termino_real,
      },
    };
    await fetch(SYNC_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      mode: "cors",
    });
  } catch {
    // Sincronização local opcional: ignora se serviço não estiver em execução.
  }
}

function getTodayIsoLocal() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeKanbanStatus(status) {
  const value = normalize(status);
  if (value.includes("conclu")) return "concluída";
  if (value.includes("andamento")) return "em andamento";
  if (value.includes("pend")) return "com pendencia";
  if (value.includes("planej")) return "planejado";
  return "planejado";
}

function isDelayedAgainstBaseline(task, progress) {
  if ((Number(progress) || 0) >= 100) return false;
  const realStart = task.inicio_real_atual || null;
  const baselineStart = task.linha_base_inicio || null;
  const realFinish = task.termino_real_atual || null;
  const baselineFinish = task.linha_base_termino || null;
  const delayedStart = Boolean(realStart && baselineStart && realStart > baselineStart);
  const delayedFinish = Boolean(realFinish && baselineFinish && realFinish > baselineFinish);
  return delayedStart || delayedFinish;
}

function isForcedMacroTaskName(name) {
  const normalizedName = normalize(name);
  return FORCED_MACRO_TASK_NAMES.some((macroName) => normalize(macroName) === normalizedName);
}

function isProjectProgressMacroTask(task) {
  return Boolean(task && task.macro && normalize(task.nome) === normalize(PROJECT_PROGRESS_MACRO_NAME));
}

function applyOverrides(task) {
  const over = state.overrides[String(task.uid)] || {};
  const isForcedMacro = isForcedMacroTaskName(task.nome);
  const isMacroTask = Boolean(task.macro || isForcedMacro);
  const isProjectProgressMacro = isMacroTask && normalize(task.nome) === normalize(PROJECT_PROGRESS_MACRO_NAME);
  const effectiveRealStart = isProjectProgressMacro ? (task.inicio_real ?? null) : (over.inicio_real ?? task.inicio_real ?? null);
  const effectiveRealFinish = isProjectProgressMacro ? (task.termino_real ?? null) : (over.termino_real ?? task.termino_real ?? null);
  const kanbanStatus = normalizeKanbanStatus((isProjectProgressMacro ? task.status_inicial : (over.status_atual || task.status_inicial)) || "planejado");
  const baseProgress = Number(task.evolucao_percentual) || 0;
  let progress = isProjectProgressMacro ? baseProgress : Number(over.evolucao_percentual_atual);
  if (Number.isNaN(progress)) {
    progress = baseProgress;
  }
  if (!isProjectProgressMacro && (kanbanStatus === "concluída" || progress >= 100)) {
    progress = 100;
  }
  const patchedTask = {
    ...task,
    macro: isMacroTask,
    macro_pai: isForcedMacro ? null : task.macro_pai,
    inicio_real_atual: effectiveRealStart,
    termino_real_atual: effectiveRealFinish,
    linha_base_inicio: task.linha_base_inicio ?? null,
    linha_base_termino: task.linha_base_termino ?? null,
  };
  const delayed = isDelayedAgainstBaseline(patchedTask, progress);
  const visualStatus = progress >= 100 ? "concluída" : (delayed ? STATUS_ATRASADA : kanbanStatus);

  return {
    ...patchedTask,
    kanban_status: kanbanStatus,
    status_atual: visualStatus,
    atrasada: delayed,
    ida_atual: task.ida ?? "ND",
    evolucao_atual: progress,
    inicio_real_texto_atual: formatDateShort(effectiveRealStart),
    termino_real_texto_atual: formatDateShort(effectiveRealFinish),
    linha_base_inicio_texto: formatDateShort(task.linha_base_inicio),
    linha_base_termino_texto: formatDateShort(task.linha_base_termino),
    responsavel_atual: over.responsavel_atual ?? task.responsavel ?? "",
  };
}

function rollupMacroTasks(tasks) {
  const rolled = tasks.map((t) => ({ ...t }));
  const macros = rolled.filter((t) => t.macro && t.estrutura).sort((a, b) => b.estrutura.length - a.estrutura.length);

  macros.forEach((macro) => {
    const isProjectProgressMacro = isProjectProgressMacroTask(macro);
    const subtasks = rolled.filter((t) => !t.macro && t.estrutura && t.estrutura.startsWith(`${macro.estrutura}.`));
    if (subtasks.length === 0) return;

    const macroProgress = clampProgress(macro.evolucao_atual ?? macro.evolucao_percentual ?? 0, 0);
    const starts = subtasks.map((t) => t.inicio_real_atual).filter(Boolean).sort();
    const finishes = subtasks.map((t) => t.termino_real_atual).filter(Boolean).sort();
    const firstStart = starts.length ? starts[0] : null;
    const lastFinish = finishes.length ? finishes[finishes.length - 1] : null;

    let macroStatus = "planejado";
    if (macroProgress >= 100) {
      macroStatus = "concluída";
    } else if (subtasks.some((t) => t.kanban_status === "com pendencia")) {
      macroStatus = "com pendencia";
    } else if (subtasks.some((t) => t.kanban_status === "em andamento" || (Number(t.evolucao_atual) || 0) > 0) || macroProgress > 0) {
      macroStatus = "em andamento";
    }

    macro.evolucao_atual = macroProgress;
    if (isProjectProgressMacro) {
      macro.inicio_real_atual = macro.inicio_real ?? null;
      macro.termino_real_atual = macro.termino_real ?? null;
      macro.inicio_real_texto_atual = formatDateShort(macro.inicio_real);
      macro.termino_real_texto_atual = formatDateShort(macro.termino_real);
    } else {
      macro.inicio_real_atual = firstStart;
      macro.termino_real_atual = lastFinish;
      macro.inicio_real_texto_atual = formatDateShort(firstStart);
      macro.termino_real_texto_atual = formatDateShort(lastFinish);
    }
    const macroDelayed = isDelayedAgainstBaseline(macro, macroProgress);
    macro.status_atual = macroProgress >= 100 ? "concluída" : (macroDelayed ? STATUS_ATRASADA : macroStatus);
    macro.kanban_status = macro.status_atual === STATUS_ATRASADA ? "em andamento" : macroStatus;
    macro.atrasada = macro.status_atual === STATUS_ATRASADA;
  });

  return rolled;
}

function clampProgress(value, fallback = 0) {
  let progress = Number(value);
  if (Number.isNaN(progress)) {
    progress = fallback;
  }
  return Math.max(0, Math.min(100, Math.round(progress)));
}

function formatDate(isoDate) {
  if (!isoDate) return "-";
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

function formatDateShort(isoDate) {
  if (!isoDate) return "ND";
  const [y, m, d] = isoDate.split("-");
  if (!y || !m || !d) return "ND";
  return `${d}/${m}/${String(y).slice(-2)}`;
}

function parseDateToIso(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return null;
  const day = match[1].padStart(2, "0");
  const month = match[2].padStart(2, "0");
  const yearRaw = match[3];
  const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
  return `${year}-${month}-${day}`;
}

function toDate(isoDate) {
  if (!isoDate) return null;
  const d = new Date(`${isoDate}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalize(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function parseOwnerTokens(value) {
  return String(value || "")
    .split(";")
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function statusBadgeClass(status) {
  if (status === STATUS_ATRASADA) return "badge-atrasada";
  if (status === "planejado") return "badge-planejado";
  if (status === "em andamento") return "badge-andamento";
  if (status === "com pendencia") return "badge-pendencia";
  return "badge-concluida";
}

function statusClassSuffix(status) {
  if (status === STATUS_ATRASADA) return "atrasada";
  if (status === "em andamento") return "andamento";
  if (status === "com pendencia") return "pendencia";
  if (status === "concluída") return "concluida";
  return "planejado";
}

function renderFilters() {
  const resolvedPreview = rollupMacroTasks(state.tarefas.map(applyOverrides));
  const macros = [...new Set(resolvedPreview.filter((t) => t.macro).map((t) => t.nome))];
  const owners = [...new Set(
    resolvedPreview
      .map((t) => t.responsavel_atual)
      .flatMap((r) => parseOwnerTokens(r))
  )].sort((a, b) => a.localeCompare(b, "pt-BR"));

  el.macroFilter.innerHTML = `<option value="">Todas</option>${macros.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("")}`;
  el.ownerFilter.innerHTML = `<option value="">Todos</option>${owners.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("")}`;
}

function applyFilters() {
  const search = normalize(el.searchInput.value);
  const macro = el.macroFilter.value;
  const owner = el.ownerFilter.value;
  const ownerNormalized = normalize(owner);
  const baselineStartFrom = parseDateToIso(el.baselineStartFromFilter.value);
  const baselineStartTo = parseDateToIso(el.baselineStartToFilter.value);
  const hasBaselineStartRange = Boolean(baselineStartFrom || baselineStartTo);

  state.resolved = rollupMacroTasks(state.tarefas.map(applyOverrides));

  state.filtered = state.resolved
    .filter((t) => {
      const okSearch = !search || normalize(`${t.nome} ${t.macro_pai || ""}`).includes(search);
      const okMacro = !macro || t.macro_pai === macro || t.nome === macro;
      const okOwner = !owner || parseOwnerTokens(t.responsavel_atual).some((name) => normalize(name) === ownerNormalized);
      const baselineStart = t.linha_base_inicio || null;
      const okBaselineStartFrom = !baselineStartFrom || (baselineStart && baselineStart >= baselineStartFrom);
      const okBaselineStartTo = !baselineStartTo || (baselineStart && baselineStart <= baselineStartTo);
      const okBaselineStartRange = okBaselineStartFrom && okBaselineStartTo;
      const okSubtaskWhenRange = !hasBaselineStartRange || !t.macro;
      return okSearch && okMacro && okOwner && okBaselineStartRange && okSubtaskWhenRange;
    });

  renderSummary();
  renderMacroTimeline();
  renderTable();
  renderKanban();
}

function renderMacroTimeline() {
  const globalMacro = state.resolved.find((t) => isProjectProgressMacroTask(t));
  if (el.globalIda) {
    const idaGlobal = globalMacro ? String(globalMacro.ida_atual || globalMacro.ida || "ND").trim() : "ND";
    el.globalIda.textContent = `IDA Global do Projeto: ${idaGlobal || "ND"}`;
  }

  const visibleMacroNames = new Set();
  state.filtered.forEach((t) => {
    if (t.macro) {
      visibleMacroNames.add(t.nome);
    } else if (t.macro_pai) {
      visibleMacroNames.add(t.macro_pai);
    }
  });

  const macros = state.resolved
    .filter((t) => t.macro && (visibleMacroNames.size === 0 || visibleMacroNames.has(t.nome)))
    .sort((a, b) => a.id - b.id);

  if (macros.length === 0) {
    el.macroTimeline.innerHTML = '<p class="kanban-empty">Nenhuma macro tarefa para os filtros atuais.</p>';
    return;
  }

  const dates = macros
    .flatMap((m) => [m.inicio || m.linha_base_inicio, m.termino || m.linha_base_termino])
    .map(toDate)
    .filter(Boolean);

  const minDate = new Date(Math.min(...dates.map((d) => d.getTime())));
  const maxDate = new Date(Math.max(...dates.map((d) => d.getTime())));
  const totalMs = Math.max(maxDate.getTime() - minDate.getTime(), 86400000);

  el.macroTimeline.innerHTML = macros.map((m) => {
    const isProjectProgressMacro = isProjectProgressMacroTask(m);
    const progressFill = clampProgress(m.evolucao_atual, 0);
    const start = toDate(m.inicio || m.linha_base_inicio) || minDate;
    const end = toDate(m.termino || m.linha_base_termino) || maxDate;
    const left = ((start.getTime() - minDate.getTime()) / totalMs) * 100;
    const width = Math.max(((end.getTime() - start.getTime()) / totalMs) * 100, 1.4);
    return `
      <article class="timeline-row ${isProjectProgressMacro ? "timeline-row-highlight" : ""}">
        <div class="timeline-meta">
          <strong>${escapeHtml(m.nome)}${isProjectProgressMacro ? ' <span class="timeline-badge-highlight">Consolidado</span>' : ""}</strong>
          <span>${formatDateShort(m.inicio || m.linha_base_inicio)} → ${formatDateShort(m.termino || m.linha_base_termino)} | ${progressFill}%</span>
        </div>
        <div class="timeline-track">
          <div class="timeline-bar status-${statusClassSuffix(m.status_atual)} ${isProjectProgressMacro ? "timeline-bar-highlight" : ""}" style="left:${left.toFixed(2)}%; width:${width.toFixed(2)}%">
            <div class="timeline-bar-fill status-${statusClassSuffix(m.status_atual)} ${progressFill >= 100 ? "complete" : ""}" style="width:${progressFill}%"></div>
            <span>${progressFill}%</span>
          </div>
        </div>
      </article>
    `;
  }).join("");
}

function renderSummary() {
  const total = state.filtered.length;
  const macros = state.filtered.filter((t) => t.macro).length;
  const subtarefas = total - macros;

  const statusCount = [...STATUS_COLUMNS, STATUS_ATRASADA].reduce((acc, st) => ({ ...acc, [st]: 0 }), {});
  state.filtered.forEach((t) => { statusCount[t.status_atual] = (statusCount[t.status_atual] || 0) + 1; });

  el.summaryCards.innerHTML = `
    <article class="summary-card"><h3>Total de tarefas</h3><strong>${total}</strong></article>
    <article class="summary-card"><h3>Macro tarefas</h3><strong>${macros}</strong></article>
    <article class="summary-card"><h3>Subtarefas</h3><strong>${subtarefas}</strong></article>
    <article class="summary-card summary-card-planejado"><h3>Planejado</h3><strong>${statusCount["planejado"] || 0}</strong></article>
    <article class="summary-card summary-card-andamento"><h3>Em andamento</h3><strong>${statusCount["em andamento"] || 0}</strong></article>
    <article class="summary-card summary-card-pendencia"><h3>Com pendencia</h3><strong>${statusCount["com pendencia"] || 0}</strong></article>
    <article class="summary-card summary-card-concluida"><h3>Concluída</h3><strong>${statusCount["concluída"] || 0}</strong></article>
    <article class="summary-card summary-card-atrasada"><h3>Atrasada</h3><strong>${statusCount[STATUS_ATRASADA] || 0}</strong></article>
  `;
}

function renderTable() {
  const statusOptions = STATUS_COLUMNS.map((status) => `<option value="${escapeHtml(status)}">${escapeHtml(status)}</option>`).join("");
  const rows = state.filtered
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((t) => {
      const visualStatus = t.status_atual;
      const realStartCell = t.macro
        ? `<span class="table-readonly">${escapeHtml(t.inicio_real_texto_atual || "ND")}</span>`
        : `<input class="table-input date-short" data-field="inicio_real" data-uid="${t.uid}" type="text" placeholder="dd/mm/aa" value="${escapeHtml(t.inicio_real_texto_atual)}" />`;
      const realFinishCell = t.macro
        ? `<span class="table-readonly">${escapeHtml(t.termino_real_texto_atual || "ND")}</span>`
        : `<input class="table-input date-short" data-field="termino_real" data-uid="${t.uid}" type="text" placeholder="dd/mm/aa" value="${escapeHtml(t.termino_real_texto_atual)}" />`;
      const progressCell = t.macro
        ? ((isProjectProgressMacroTask(t) || isForcedMacroTaskName(t.nome))
          ? `<span class="table-readonly">${escapeHtml(String(t.evolucao_atual))}%</span>`
          : '<span class="table-readonly">-</span>')
        : `<input class="table-input progress" data-field="evolucao_percentual_atual" data-uid="${t.uid}" type="number" min="0" max="100" step="1" value="${t.evolucao_atual}" />`;
      const isProjectMacro = isProjectProgressMacroTask(t);
      return `
      <tr class="table-row status-${statusClassSuffix(visualStatus)} ${t.macro ? "row-macro" : "row-subtask"} ${isProjectMacro ? "row-project-consolidated" : ""}">
        <td>${escapeHtml(t.estrutura)}</td>
        <td>${t.macro ? "Macro" : "Subtarefa"}</td>
        <td class="task-name ${t.macro ? "macro-name" : "subtask-name"}">${escapeHtml(t.nome)}${isProjectMacro ? ' <span class="inline-consolidated-badge">Consolidado</span>' : ""}</td>
        <td>${escapeHtml(t.macro_pai || "-")}</td>
        <td>${escapeHtml(t.linha_base_inicio_texto)}</td>
        <td>${escapeHtml(t.linha_base_termino_texto)}</td>
        <td>${realStartCell}</td>
        <td>${realFinishCell}</td>
        <td>${progressCell}</td>
        <td><input class="table-input owner" data-field="responsavel_atual" data-uid="${t.uid}" type="text" value="${escapeHtml(t.responsavel_atual || "")}" /></td>
        <td>
          <div class="status-cell">
            <select class="table-input status" data-field="status_atual" data-uid="${t.uid}">
              ${statusOptions}
            </select>
            <span class="badge ${statusBadgeClass(t.status_atual)}">${escapeHtml(t.status_atual)}</span>
          </div>
        </td>
      </tr>
    `;
    })
    .join("");

  el.taskTableBody.innerHTML = rows;
  document.querySelectorAll('select[data-field="status_atual"]').forEach((select) => {
    const uid = Number(select.getAttribute("data-uid"));
    const task = state.filtered.find((t) => t.uid === uid);
    if (task) {
      select.value = task.kanban_status;
    }
  });
  wireTableEvents();
}

function wireTableEvents() {
  document.querySelectorAll(".table-input").forEach((input) => {
    input.addEventListener("change", () => {
      const uid = Number(input.getAttribute("data-uid"));
      const field = input.getAttribute("data-field");
      if (!uid || !field) return;
      const currentTask = state.resolved.find((t) => t.uid === uid);
      if (currentTask && currentTask.macro && (field === "evolucao_percentual_atual" || field === "inicio_real" || field === "termino_real")) {
        applyFilters();
        return;
      }

      if (field === "status_atual") {
        updateTaskFields(uid, { status_atual: normalizeKanbanStatus(input.value) });
        return;
      }
      if (field === "evolucao_percentual_atual") {
        updateTaskFields(uid, { evolucao_percentual_atual: clampProgress(input.value, 0) });
        return;
      }
      if (field === "responsavel_atual") {
        updateTaskFields(uid, { responsavel_atual: input.value.trim() });
        return;
      }
      if (field === "inicio_real") {
        const iso = parseDateToIso(input.value);
        if (iso || input.value.trim() === "" || normalize(input.value) === "nd") {
          updateTaskFields(uid, { inicio_real: iso });
        } else {
          applyFilters();
        }
        return;
      }
      if (field === "termino_real") {
        const iso = parseDateToIso(input.value);
        if (iso || input.value.trim() === "" || normalize(input.value) === "nd") {
          updateTaskFields(uid, { termino_real: iso });
        } else {
          applyFilters();
        }
      }
    });
  });
}

function renderKanban() {
  const subtarefas = state.filtered.filter((t) => !t.macro);
  const macroOrderMap = new Map(
    state.tarefas
      .filter((t) => t.macro)
      .sort((a, b) => a.id - b.id)
      .map((t, idx) => [t.nome, idx])
  );
  const byStatus = Object.fromEntries(STATUS_COLUMNS.map((s) => [s, new Map()]));

  subtarefas.forEach((t) => {
    const macroName = t.macro_pai || "Sem macro";
    if (!byStatus[t.kanban_status]) byStatus[t.kanban_status] = new Map();
    if (!byStatus[t.kanban_status].has(macroName)) {
      byStatus[t.kanban_status].set(macroName, []);
    }
    byStatus[t.kanban_status].get(macroName).push(t);
  });

  el.kanbanBoard.innerHTML = STATUS_COLUMNS.map((status) => `
    <article class="kanban-column" data-status="${status}">
      <h3>${status} <span class="column-count">(${subtarefas.filter((t) => t.kanban_status === status).length})</span></h3>
      ${Array.from((byStatus[status] || new Map()).entries())
        .sort((a, b) => {
          const keyA = macroOrderMap.has(a[0]) ? macroOrderMap.get(a[0]) : Number.MAX_SAFE_INTEGER;
          const keyB = macroOrderMap.has(b[0]) ? macroOrderMap.get(b[0]) : Number.MAX_SAFE_INTEGER;
          if (keyA !== keyB) return keyA - keyB;
          return a[0].localeCompare(b[0], "pt-BR");
        })
        .map(([macroName, tasks]) => `
          <section class="kanban-group">
            <h4 class="kanban-group-title">${escapeHtml(macroName)} <span class="column-count">(${tasks.length})</span></h4>
            ${tasks
              .sort((a, b) => a.id - b.id)
              .map((t) => `
                <div class="kanban-card status-${statusClassSuffix(t.status_atual)}" draggable="true" data-uid="${t.uid}">
                  <h4>${escapeHtml(t.nome)}</h4>
                  <div class="kanban-meta">
                    ${formatDateShort(t.inicio)} → ${formatDateShort(t.termino)}<br />
                    Real: ${formatDateShort(t.inicio_real_atual)} → ${formatDateShort(t.termino_real_atual)}<br />
                    Linha base: ${formatDateShort(t.linha_base_inicio)} → ${formatDateShort(t.linha_base_termino)}<br />
                    ${t.evolucao_atual}% | Resp: ${escapeHtml(t.responsavel_atual || "-")}
                  </div>
                  <div class="kanban-actions">
                    <span>#${t.id}</span>
                    <button type="button" data-edit="${t.uid}">Editar</button>
                  </div>
                </div>
              `)
              .join("")}
          </section>
        `)
        .join("")}
      ${((byStatus[status] || new Map()).size === 0) ? '<p class="kanban-empty">Nenhuma tarefa nesta coluna.</p>' : ""}
    </article>
  `).join("");

  wireKanbanEvents();
}

function wireKanbanEvents() {
  document.querySelectorAll(".kanban-card").forEach((card) => {
    card.addEventListener("dragstart", () => card.classList.add("dragging"));
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });

  document.querySelectorAll(".kanban-column").forEach((col) => {
    col.addEventListener("dragover", (ev) => ev.preventDefault());
    col.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const dragging = document.querySelector(".kanban-card.dragging");
      if (!dragging) return;
      updateTaskStatus(Number(dragging.dataset.uid), col.dataset.status);
    });
  });

  document.querySelectorAll("button[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => openEditDialog(Number(btn.dataset.edit)));
  });
}

function updateTaskFields(uid, updates) {
  const key = String(uid);
  const current = state.overrides[key] || {};
  const next = { ...current, ...updates };
  const currentTask = state.resolved.find((t) => t.uid === uid) || state.tarefas.find((t) => t.uid === uid);
  const isMacroTask = Boolean(currentTask && currentTask.macro);

  if (isMacroTask) {
    delete next.evolucao_percentual_atual;
    delete next.evolucao_ajustada_por_conclusao;
    delete next.inicio_real;
    delete next.termino_real;
  }

  if (updates.status_atual) {
    next.status_atual = normalizeKanbanStatus(updates.status_atual);
  }

  const progressInputDefined = !isMacroTask && updates.evolucao_percentual_atual !== undefined;
  const progressInputValue = progressInputDefined ? clampProgress(updates.evolucao_percentual_atual, 0) : null;
  if (progressInputDefined && progressInputValue === 0) {
    next.status_atual = "planejado";
  }

  const startedByProgress = !isMacroTask
    && progressInputDefined
    && progressInputValue > 0;
  const startedByRealStart = !isMacroTask
    && Object.prototype.hasOwnProperty.call(updates, "inicio_real")
    && ![null, undefined, ""].includes(updates.inicio_real);
  const startedSignal = startedByProgress || startedByRealStart;

  if (
    !isMacroTask
    && startedSignal
    && next.status_atual !== "concluída"
    && next.status_atual !== "com pendencia"
  ) {
    next.status_atual = "em andamento";
  }

  if (!isMacroTask && next.status_atual === "concluída") {
    next.evolucao_percentual_atual = 100;
    next.evolucao_ajustada_por_conclusao = true;
  } else if (!isMacroTask && updates.evolucao_percentual_atual !== undefined) {
    next.evolucao_percentual_atual = clampProgress(updates.evolucao_percentual_atual, 0);
    delete next.evolucao_ajustada_por_conclusao;
  } else if (!isMacroTask && current.evolucao_ajustada_por_conclusao) {
    delete next.evolucao_percentual_atual;
    delete next.evolucao_ajustada_por_conclusao;
  }
  state.overrides[key] = next;
  persistOverrides();
  applyFilters();
  enqueueProjectSync(uid, next);
}

function updateTaskStatus(uid, status) {
  updateTaskFields(uid, { status_atual: status });
}

function openEditDialog(uid) {
  const task = state.resolved.find((t) => t.uid === uid) || rollupMacroTasks(state.tarefas.map(applyOverrides)).find((t) => t.uid === uid);
  if (!task) return;
  state.currentEditUid = uid;
  el.editTitle.textContent = `Atualizar tarefa #${task.id} - ${task.nome}`;
  el.editStatus.value = task.kanban_status;
  el.editOwner.value = task.responsavel_atual || "";
  el.editProgress.value = String(task.evolucao_atual ?? 0);
  el.editRealStart.value = task.inicio_real_atual || "";
  el.editRealFinish.value = task.termino_real_atual || "";
  el.baselineStartText.textContent = task.linha_base_inicio_texto || "ND";
  el.baselineFinishText.textContent = task.linha_base_termino_texto || "ND";
  el.editDialog.showModal();
}

function saveEdit(event) {
  event.preventDefault();
  const uid = state.currentEditUid;
  if (!uid) return;
  updateTaskFields(uid, {
    status_atual: el.editStatus.value,
    responsavel_atual: el.editOwner.value.trim(),
    evolucao_percentual_atual: clampProgress(el.editProgress.value, 0),
    inicio_real: el.editRealStart.value || null,
    termino_real: el.editRealFinish.value || null,
  });
  el.editDialog.close();
}

function wireFilters() {
  el.searchInput.addEventListener("input", applyFilters);
  el.macroFilter.addEventListener("change", applyFilters);
  el.ownerFilter.addEventListener("change", applyFilters);
  el.baselineApplyButton.addEventListener("click", (event) => {
    event.preventDefault();
    applyFilters();
  });
  el.baselineClearButton.addEventListener("click", (event) => {
    event.preventDefault();
    el.baselineStartFromFilter.value = "";
    el.baselineStartToFilter.value = "";
    applyFilters();
  });
  el.resetButton.addEventListener("click", () => {
    el.searchInput.value = "";
    el.macroFilter.value = "";
    el.ownerFilter.value = "";
    el.baselineStartFromFilter.value = "";
    el.baselineStartToFilter.value = "";
    applyFilters();
  });
  el.editForm.addEventListener("submit", saveEdit);
}

function startAutoReloadForFileMode() {
  if (window.location.protocol !== "file:") return;
  setInterval(() => {
    window.location.reload();
  }, AUTO_RELOAD_MS);
}

async function init() {
  let data = window.TASKS_DATA || null;
  if (!data) {
    const response = await fetch("./tasks.json");
    data = await response.json();
  }
  state.tarefas = data.tarefas || [];
  loadOverrides();
  reconcileOverridesWithProjectData(data);
  renderFilters();
  wireFilters();
  applyFilters();
  startAutoReloadForFileMode();
}

init().catch((error) => {
  document.body.innerHTML = `<main style="padding:24px"><h2>Falha ao carregar o dashboard</h2><pre>${escapeHtml(error.message)}</pre></main>`;
});
