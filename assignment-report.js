// ==UserScript==
// @name         Canvas Gradebook Dashboard V1.0
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Cijfer overzicht in Canvas!
// @author       Jij
// @match        https://mboutrecht.instructure.com/courses/*/gradebook*
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_KEY = "canvasDashboardSettingsV14";
  const DEFAULT_SETTINGS = "1-15 ; 3 ; 10";

  const STATUS = {
    VOLDAAN: { css: "status-voldaan", symbol: "✓" },
    TE_BEOORDELEN: { css: "status-te-beoordelen", symbol: "✓⏳" },
    MISSEND: { css: "status-missend", symbol: "✕" },
    TOEKOMST: { css: "status-toekomst", symbol: "–" },
  };

  const HTML_ESCAPE_MAP = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  function escapeHtml(value) {
    return String(value).replace(
      /[&<>"']/g,
      (character) => HTML_ESCAPE_MAP[character],
    );
  }

  // ---------- Parsing ----------

  function parseIndexList(text = "") {
    const indexes = [];

    text.split(",").forEach((part) => {
      const value = part.trim();
      if (!value) return;

      if (value.includes("-")) {
        const [start, end] = value
          .split("-")
          .map((number) => parseInt(number.trim(), 10));
        if (!Number.isNaN(start) && !Number.isNaN(end)) {
          for (let index = start; index <= end; index++) indexes.push(index);
        }
        return;
      }

      const index = parseInt(value, 10);
      if (!Number.isNaN(index)) indexes.push(index);
    });

    return indexes;
  }

  // Leeg of "0": één tabel; één getal: automatisch verdelen; een lijst: exacte aantallen.
  function parseSplitConfig(text) {
    const value = (text || "").trim();
    if (!value || value === "0") return { mode: "single" };

    if (value.includes(",")) {
      const sizes = value
        .split(",")
        .map((part) => parseInt(part.trim(), 10))
        .filter((size) => !Number.isNaN(size) && size > 0);
      return sizes.length ? { mode: "custom", sizes } : { mode: "single" };
    }

    const size = parseInt(value, 10);
    return !Number.isNaN(size) && size > 0
      ? { mode: "auto", size }
      : { mode: "single" };
  }

  function buildChunks(students, splitConfig) {
    const total = students.length;

    if (splitConfig.mode === "custom") {
      const chunks = [];
      let offset = 0;

      splitConfig.sizes.forEach((size) => {
        if (offset >= total) return;
        chunks.push(students.slice(offset, offset + size));
        offset += size;
      });

      if (offset < total) chunks.push(students.slice(offset));
      return chunks;
    }

    if (splitConfig.mode === "auto") {
      const blockCount = Math.max(1, Math.ceil(total / splitConfig.size));
      const baseSize = Math.floor(total / blockCount);
      const remainder = total % blockCount;
      const chunks = [];
      let offset = 0;

      for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
        const size = baseSize + (blockIndex < remainder ? 1 : 0);
        chunks.push(students.slice(offset, offset + size));
        offset += size;
      }

      return chunks;
    }

    return [students];
  }

  // ---------- Canvas data collection ----------

  function collectAssignments(selectedIndexes) {
    return Array.from(
      document.querySelectorAll(".slick-header-column.assignment"),
    )
      .flatMap((header, index) => {
        const nameElement = header.querySelector(".assignment-name");
        return nameElement
          ? [{ index: index + 1, name: nameElement.innerText.trim() }]
          : [];
      })
      .filter((assignment) => selectedIndexes.includes(assignment.index));
  }

  function hasGradeValue(value) {
    return value !== "" && value !== "–" && value !== "-";
  }

  function createCellResult(
    status,
    assignmentIndex,
    assignmentName,
    description,
  ) {
    return {
      status,
      title: `Week ${assignmentIndex} (${assignmentName}): ${description}`,
    };
  }

  function evaluateCell(cell, assignmentIndex, assignmentName, currentWeek) {
    const isPending = Boolean(cell?.querySelector(".icon-not-graded"));
    const gradeText = cell?.querySelector(".Grade")?.innerText.trim() || "";
    const cellText = cell?.innerText.trim() || "";
    const hasSubmission =
      isPending || hasGradeValue(gradeText) || hasGradeValue(cellText);

    // Cijfers worden bewust niet weergegeven; alleen de status wordt gerapporteerd.
    if (isPending) {
      return createCellResult(
        STATUS.TE_BEOORDELEN,
        assignmentIndex,
        assignmentName,
        "Ingeleverd - nog te beoordelen",
      );
    }
    if (hasSubmission) {
      return createCellResult(
        STATUS.VOLDAAN,
        assignmentIndex,
        assignmentName,
        "Beoordeeld - voldaan",
      );
    }
    if (assignmentIndex === currentWeek) {
      return createCellResult(
        STATUS.TOEKOMST,
        assignmentIndex,
        assignmentName,
        "Huidige week (nog niets verplicht)",
      );
    }
    if (assignmentIndex < currentWeek) {
      return createCellResult(
        STATUS.MISSEND,
        assignmentIndex,
        assignmentName,
        "Niet ingeleverd (deadline verstreken)",
      );
    }

    return createCellResult(
      STATUS.TOEKOMST,
      assignmentIndex,
      assignmentName,
      "Toekomstige week",
    );
  }

  function collectStudentData(assignments, currentWeek) {
    const leftRows = document.querySelectorAll(".slick-row");
    const rightRows = document.querySelectorAll(
      ".container_1 .grid-canvas .slick-row",
    );
    const students = [];

    leftRows.forEach((leftRow, rowIndex) => {
      const nameLink = leftRow.querySelector(".student-grades-link");
      if (!nameLink) return;

      const rightRow = rightRows[rowIndex];
      const cells = rightRow ? rightRow.querySelectorAll(".slick-cell") : [];
      const student = { name: nameLink.innerText.trim(), cells: [] };

      assignments.forEach((assignment) => {
        const cell = cells[assignment.index - 1];
        const result = evaluateCell(
          cell,
          assignment.index,
          assignment.name,
          currentWeek,
        );
        student.cells.push({ week: assignment.index, ...result });
      });

      students.push(student);
    });

    return students;
  }

  // ---------- Report rendering ----------

  function renderTableBlock(students, assignments, currentWeek, blockLabel) {
    const headerCells = assignments
      .map((assignment) => {
        const currentWeekStyle =
          assignment.index === currentWeek
            ? 'style="background-color:#0077b6;"'
            : "";
        const name = escapeHtml(assignment.name);

        return (
          `<th ${currentWeekStyle} title="${name}">W${assignment.index}<br>` +
          `<span style="font-weight:normal;font-size:9px;opacity:.8;">${escapeHtml(assignment.name.substring(0, 10))}..</span></th>`
        );
      })
      .join("");

    const bodyRows = students
      .map((student) => {
        const cells = assignments
          .map((assignment) => {
            const cellData = student.cells.find(
              (cell) => cell.week === assignment.index,
            );
            if (!cellData) return "<td>–</td>";

            return (
              `<td class="${cellData.status.css}" title="${escapeHtml(cellData.title)}">` +
              `${escapeHtml(cellData.status.symbol)}</td>`
            );
          })
          .join("");

        return `<tr><td title="${escapeHtml(student.name)}">${escapeHtml(student.name)}</td>${cells}</tr>`;
      })
      .join("");

    return `
            <div class="table-block">
                <table>
                    <thead><tr><th>Student ${blockLabel}</th>${headerCells}</tr></thead>
                    <tbody>${bodyRows}</tbody>
                </table>
            </div>`;
  }

  function renderReport(assignments, currentWeek, chunks) {
    const totalStudents = chunks.reduce(
      (total, chunk) => total + chunk.length,
      0,
    );
    const blocksHtml = chunks
      .map((chunk, index) => {
        const label = chunks.length > 1 ? `(${index + 1})` : "";
        return renderTableBlock(chunk, assignments, currentWeek, label);
      })
      .join("");

    return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<title>Canvas Voortgangsdashboard</title>
<style>
    body { font-family: Arial, sans-serif; margin: 15px; color: #333; background: #f4f6f9; font-size: 12px; }
    h1 { color: #2D3B45; font-size: 18px; margin: 0 0 5px 0; }
    .meta { margin-bottom: 15px; font-size: 11px; color: #555; display: flex; gap: 15px; align-items: center; }
    .dashboard-container { display: flex; flex-wrap: wrap; gap: 15px; align-items: flex-start; }
    .table-block { background: #fff; padding: 10px; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    table { border-collapse: collapse; font-size: 11px; }
    th, td { padding: 6px 10px; text-align: center; border-bottom: 1px solid #eee; border-right: 1px solid #f2f2f2; }
    th:first-child, td:first-child { text-align: left; font-weight: bold; width: 140px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    th { background-color: #2D3B45; color: #fff; font-size: 11px; }
    tr:hover { background-color: #f1f7fc; }
    .status-voldaan { background-color: #e2f0d9; color: #385723; font-weight: bold; font-size: 12px; }
    .status-te-beoordelen { background-color: #d9ead3; color: #274e13; font-weight: bold; font-size: 11px; }
    .status-missend { background-color: #fce4d6; color: #c65911; font-weight: bold; font-size: 12px; }
    .status-toekomst { background-color: #fafafa; color: #bbb; font-size: 11px; }
    .legend { display: flex; gap: 15px; background: #fff; padding: 6px 12px; border-radius: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); font-size: 11px; width: fit-content; margin-bottom: 15px; }
    .legend-item { display: flex; align-items: center; gap: 5px; font-weight: bold; }
    .box { width: 10px; height: 10px; border-radius: 2px; }
</style>
</head>
<body>
    <h1>📊 Canvas Voortgangsdashboard</h1>
    <div class="meta">
        <span><strong>Getoonde kolommen:</strong> ${assignments.map((assignment) => "W" + assignment.index).join(", ")}</span>
        <span><strong>Huidige week (spaarweek):</strong> W${currentWeek}</span>
        <span><strong>Totaal studenten:</strong> ${totalStudents}</span>
        <span><strong>Aantal tabellen:</strong> ${chunks.length}</span>
    </div>
    <div class="legend">
        <div class="legend-item"><div class="box" style="background:#e2f0d9;"></div> ✓ Voldaan (beoordeeld)</div>
        <div class="legend-item"><div class="box" style="background:#d9ead3;"></div> ✓⏳ Ingeleverd (nog nakijken)</div>
        <div class="legend-item"><div class="box" style="background:#fce4d6;"></div> ✕ Ontbreekt (eerder dan W${currentWeek})</div>
        <div class="legend-item"><div class="box" style="background:#fafafa; border:1px solid #ccc;"></div> – Huidige week / toekomst</div>
    </div>
    <div class="dashboard-container">${blocksHtml}</div>
</body>
</html>`;
  }

  // ---------- User interaction ----------

  function getSavedSettings() {
    try {
      return localStorage.getItem(STORAGE_KEY) || DEFAULT_SETTINGS;
    } catch (error) {
      console.warn(
        "Canvas dashboard: instellingen konden niet worden gelezen.",
        error,
      );
      return DEFAULT_SETTINGS;
    }
  }

  function saveSettings(settings) {
    try {
      localStorage.setItem(STORAGE_KEY, settings);
    } catch (error) {
      console.warn(
        "Canvas dashboard: instellingen konden niet worden opgeslagen.",
        error,
      );
    }
  }

  function generateProgressReport() {
    const input = prompt(
      "📊 CANVAS VOORTGANGSDASHBOARD\n\n" +
        "Vul de drie instellingen in, gescheiden door | \n\n" +
        "1. CANVAS KOLOMMEN\n" +
        "Welke opdrachtkolommen wil je tonen?\n" +
        "• Bijvoorbeeld: 1-15\n" +
        "• Of: 1,2,3,4,5,8,10\n" +
        "• Kies de kolommen die je nodig hebt.\n\n" +
        "2. ACTIEVE_COL (HUIDIGE LESWEEK)\n" +
        "Welke kolom hoort bij de huidige lesweek?\n" +
        "• Dit bepaalt vanaf welke week opdrachten als ontbrekend worden gemarkeerd.\n" +
        "• Eerdere weken zonder inlevering worden ROOD.\n" +
        "• De actieve week en toekomstige weken worden NIET rood.\n" +
        "• Zo zie je bij het begin van de les direct welke opdrachten nog niet verplicht zijn.\n\n" +
        "3. STUDENT_PER_TABEL\n" +
        "Hoeveel studenten wil je per tabel weergeven?\n" +
        "• Bijvoorbeeld: 10 = automatisch verdelen in tabellen van ongeveer 10 studenten.\n" +
        "• Bijvoorbeeld: 10,10,5 = exact deze verdeling.\n" +
        "• 0 of leeg = alles in één tabel.\n" +
        "• Kies een aantal waarmee alle studenten en kolommen zo goed mogelijk in beeld passen.\n\n" +
        "━━━━━━━━━━━━━━━━━━━━\n" +
        "VOORBEELD:\n" +
        "1-15 | 3 | 10\n" +
        "━━━━━━━━━━━━━━━━━━━━\n\n" +
        "Betekenis van dit voorbeeld:\n" +
        "• Kolommen 1 t/m 15 tonen.\n" +
        "• Week 3 is de actieve lesweek.\n" +
        "• Studenten worden verdeeld over tabellen van ongeveer 10.\n\n" +
        "Voer je instellingen hieronder in:",
      getSavedSettings(),
    );

    if (!input) return;
    saveSettings(input);

    const [columnsInput = "", weekInput = "", splitInput = ""] =
      input.split(";");
    const selectedIndexes = parseIndexList(columnsInput.trim() || "1-15");
    if (selectedIndexes.length === 0) {
      alert("⚠️ Geen geldige kolommen opgegeven.");
      return;
    }

    const currentWeek =
      parseInt(weekInput.trim(), 10) ||
      selectedIndexes[selectedIndexes.length - 1];
    const splitConfig = parseSplitConfig(splitInput);
    const assignments = collectAssignments(selectedIndexes);
    if (assignments.length === 0) {
      alert(
        "⚠️ Geen opdrachten gevonden die voldoen aan de opgegeven indexen.",
      );
      return;
    }

    const students = collectStudentData(assignments, currentWeek);
    if (students.length === 0) {
      alert(
        "⚠️ Geen studentenrijen gevonden. Zorg dat de tabel volledig geladen is.",
      );
      return;
    }

    const html = renderReport(
      assignments,
      currentWeek,
      buildChunks(students, splitConfig),
    );
    const reportWindow = window.open("", "_blank");
    if (!reportWindow) {
      alert(
        "⚠️ Pop-up blokkering gedetecteerd! Sta pop-ups toe voor deze site.",
      );
      return;
    }

    try {
      reportWindow.document.write(html);
      reportWindow.document.close();
    } catch (error) {
      reportWindow.close();
      console.error(
        "Canvas dashboard: rapport kon niet worden geopend.",
        error,
      );
      alert("⚠️ Het dashboard kon niet worden geopend.");
    }
  }

  function addTriggerButton() {
    if (document.getElementById("log-progress-btn") || !document.body) return;

    const button = document.createElement("button");
    button.id = "log-progress-btn";
    button.innerText = "📊 Open Dashboard V14.2";
    Object.assign(button.style, {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      zIndex: "9999",
      padding: "12px 18px",
      backgroundColor: "#008EE2",
      color: "#fff",
      border: "2px solid #fff",
      borderRadius: "6px",
      cursor: "pointer",
      fontWeight: "bold",
      boxShadow: "0 4px 10px rgba(0,0,0,0.3)",
    });

    button.addEventListener("click", generateProgressReport);
    document.body.appendChild(button);
  }

  window.addEventListener("load", () => setTimeout(addTriggerButton, 2000));
})();
