/**
 * BC ControlAddin entry point for SVAR Gantt.
 * Builds into a single IIFE bundle that exposes window.BdySvarGantt.
 *
 * BC ControlAddin calls:
 *   LoadGanttData(jsonString)  → mount/update the Gantt
 *   SetReadOnly(bool)         → toggle readonly
 *   SetViewMode(mode)         → change zoom/scale
 *   ScrollToDate(dateStr)     → scroll timeline
 *   CollapseAll()             → collapse all tasks
 *   ExpandAll()               → expand all tasks
 */

import { mount, unmount } from "svelte";
import BcGantt from "./BcGantt.svelte";

// ── Type mapping: BC → SVAR ──
const DEP_TYPE_MAP = { FS: "e2s", FF: "e2e", SS: "s2s", SF: "s2e" };
const DEP_TYPE_REV = { e2s: "FS", e2e: "FF", s2s: "SS", s2e: "SF" };

function mapTasksToSvar(bcTasks) {
	return (bcTasks || []).map(t => {
		const task = {
			id: t.id,
			text: t.name || t.text || "",
			start: t.start ? new Date(t.start) : null,
			end: t.end ? new Date(t.end) : null,
			duration: 0, // SVAR will compute from start/end
			progress:
				typeof t.progress === "number"
					? Math.round(t.progress * 100)
					: 0,
			type:
				t.type === "summary"
					? "summary"
					: t.type === "milestone"
						? "milestone"
						: "task",
			// Preserve BC-specific fields for round-tripping
			_bcTaskNo: t.taskNo,
			_bcSpent: t.spent,
			_bcEtcQty: t.etc_qty,
			_bcBacQty: t.bac_qty,
			_bcPhaseIndex: t.phaseIndex,
			_bcColor: t.color,
			_bcStatus: t.status,
		};
		// Only set parent when there actually is one (root tasks omit it, matching SVAR convention)
		if (t.parentId) {
			task.parent = t.parentId;
		}
		// Only set open on summary tasks — leaf tasks with open:true + data:null crash the tree walker
		if (t.type === "summary") {
			task.open = !t.collapsed;
		}
		return task;
	});
}

/**
 * Compute start/end for summary tasks from their descendants.
 * SVAR needs explicit dates on summaries for the bar and expand/collapse to render.
 */
function computeSummaryDates(tasks) {
	const taskMap = new Map(tasks.map(t => [t.id, t]));

	// Propagate each leaf's dates up through all ancestor summaries
	for (const task of tasks) {
		if (task.type === "summary" || !task.start || !task.end) continue;

		let parentId = task.parent;
		while (parentId) {
			const parent = taskMap.get(parentId);
			if (!parent) break;
			if (!parent.start || task.start < parent.start)
				parent.start = new Date(task.start);
			if (!parent.end || task.end > parent.end)
				parent.end = new Date(task.end);
			parentId = parent.parent;
		}
	}
}

function mapLinksToSvar(bcDeps) {
	return (bcDeps || []).map(d => ({
		id: d.id,
		source: d.from,
		target: d.to,
		type: DEP_TYPE_MAP[d.type] || "e2s",
		lag: d.lag || 0,
	}));
}

function mapTaskToBc(svarTask) {
	return {
		id: svarTask.id,
		taskNo: svarTask._bcTaskNo || svarTask.id,
		name: svarTask.text,
		start: svarTask.start
			? svarTask.start.toISOString().split("T")[0]
			: null,
		end: svarTask.end ? svarTask.end.toISOString().split("T")[0] : null,
		progress: (svarTask.progress || 0) / 100,
	};
}

function mapLinkToBc(svarLink) {
	return {
		id: svarLink.id,
		from: svarLink.source,
		to: svarLink.target,
		type: DEP_TYPE_REV[svarLink.type] || "FS",
		lag: svarLink.lag || 0,
	};
}

// ── Fire BC events ──
/* global Microsoft */
function fireEvent(name, args) {
	if (
		typeof Microsoft !== "undefined" &&
		Microsoft.Dynamics &&
		Microsoft.Dynamics.NAV
	) {
		Microsoft.Dynamics.NAV.InvokeExtensibilityMethod(name, args || []);
	}
}

// ── Global API ──
const BdySvarGantt = {
	_gantt: null,
	_container: null,
	_api: null,
	_props: {},
	_readOnly: false,

	/**
	 * Load/reload Gantt data from BC JSON string.
	 */
	loadData(jsonString) {
		console.log(
			"[BdySvarGantt] loadData called, length:",
			jsonString?.length
		);
		try {
			const data =
				typeof jsonString === "string"
					? JSON.parse(jsonString)
					: jsonString;
			console.log(
				"[BdySvarGantt] Parsed data - tasks:",
				data.tasks?.length,
				"deps:",
				data.dependencies?.length
			);
			const tasks = mapTasksToSvar(data.tasks);
			computeSummaryDates(tasks);
			const links = mapLinksToSvar(data.dependencies);

			// Parse config
			const config = data.config || {};

			// Build scales from config viewMode
			const viewMode = config.viewMode || "month";
			const scales = this._getScales(viewMode);

			// Build columns from config or use defaults
			const columns = this._getColumns(config);

			const props = {
				tasks,
				links,
				scales,
				columns,
				readonly: this._readOnly,
				cellHeight: 28,
				scaleHeight: 32,
				cellWidth:
					viewMode === "day" ? 40 : viewMode === "week" ? 100 : 120,
				cellBorders: "full",
				init: api => {
					this._api = api;
					this._bindEvents(api);
				},
			};

			if (!this._gantt) {
				// First mount
				this._props = props;
				this._mount(props);
			} else {
				// Update existing — rebuild
				this.destroy();
				this._props = props;
				this._mount(props);
			}
		} catch (err) {
			console.error("[BdySvarGantt] loadData error:", err);
			const controlDiv = document.getElementById("controlAddIn");
			if (controlDiv)
				controlDiv.innerText = "Gantt loadData error: " + err.message;
		}
	},

	_mount(props) {
		const controlDiv = document.getElementById("controlAddIn");
		if (!controlDiv) {
			console.error("[BdySvarGantt] controlAddIn div not found");
			return;
		}

		// Clear existing content
		controlDiv.innerHTML = "";

		// Match the native gantt approach: use height:100% to inherit BC's layout sizing
		// BC's VerticalStretch=true on the control add-in allocates the correct height
		controlDiv.style.cssText =
			"width:100%;height:100%;overflow:hidden;position:relative;";

		// Create wrapper div matching the container
		this._container = document.createElement("div");
		this._container.style.cssText = "width:100%;height:100%;";
		controlDiv.appendChild(this._container);

		try {
			// Mount the BcGantt wrapper (Willow theme + Gantt in one Svelte component)
			this._gantt = mount(BcGantt, {
				target: this._container,
				props,
			});
			console.log(
				"[BdySvarGantt] Mounted successfully, tasks:",
				props.tasks?.length,
				"links:",
				props.links?.length
			);
		} catch (err) {
			console.error("[BdySvarGantt] Mount error:", err);
			this._container.innerText = "Gantt mount error: " + err.message;
		}
	},

	_bindEvents(api) {
		// Task updated (drag, resize, progress, or editor change)
		api.on("update-task", ev => {
			const bcTask = mapTaskToBc(ev.task);
			if (ev.diff && ev.diff.progress !== undefined) {
				fireEvent("OnTaskProgressChanged", [
					bcTask.id,
					bcTask.progress,
				]);
			} else if (
				ev.diff &&
				(ev.diff.start !== undefined || ev.diff.end !== undefined)
			) {
				fireEvent("OnTaskResized", [JSON.stringify(bcTask)]);
			} else {
				// Editor field change (name, type, duration, etc.)
				fireEvent("OnTaskUpdated", [JSON.stringify(bcTask)]);
			}
		});

		// Task deleted (from editor or context menu)
		api.on("delete-task", ev => {
			if (ev.id) {
				fireEvent("OnTaskDeleted", [String(ev.id)]);
			}
		});

		// Task added (from context menu)
		api.on("add-task", ev => {
			const parentId = ev.task?.parent ? String(ev.task.parent) : "";
			fireEvent("OnNewTaskRequested", [parentId]);
		});

		// Task dragged
		api.on("drag-task", ev => {
			const bcTask = mapTaskToBc(ev.task);
			fireEvent("OnTaskMoved", [JSON.stringify(bcTask)]);
		});

		// Task selected
		api.on("select-task", ev => {
			if (ev.id) {
				fireEvent("OnTaskClicked", [String(ev.id)]);
			}
		});

		// Link added
		api.on("add-link", ev => {
			const bcLink = mapLinkToBc(ev.link);
			fireEvent("OnDependencyCreated", [JSON.stringify(bcLink)]);
		});

		// Link deleted
		api.on("delete-link", ev => {
			fireEvent("OnDependencyDeleted", [ev.id]);
		});
	},

	_getScales(viewMode) {
		const mFull = [
			"January",
			"February",
			"March",
			"April",
			"May",
			"June",
			"July",
			"August",
			"September",
			"October",
			"November",
			"December",
		];
		const mShort = [
			"Jan",
			"Feb",
			"Mar",
			"Apr",
			"May",
			"Jun",
			"Jul",
			"Aug",
			"Sep",
			"Oct",
			"Nov",
			"Dec",
		];
		const pad = n => (n < 10 ? "0" + n : "" + n);
		const isoWeek = d => {
			const t = new Date(d.getTime());
			t.setHours(0, 0, 0, 0);
			t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
			const w1 = new Date(t.getFullYear(), 0, 4);
			return (
				1 +
				Math.round(
					((t - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7
				)
			);
		};
		switch (viewMode) {
			case "day":
				return [
					{
						unit: "month",
						step: 1,
						format: d =>
							`${mFull[d.getMonth()]} ${d.getFullYear()}`,
					},
					{ unit: "day", step: 1, format: d => `${d.getDate()}` },
				];
			case "week":
				return [
					{
						unit: "month",
						step: 1,
						format: d =>
							`${mFull[d.getMonth()]} ${d.getFullYear()}`,
					},
					{
						unit: "week",
						step: 1,
						format: d => `W${pad(isoWeek(d))}`,
					},
				];
			case "month":
			default:
				return [
					{
						unit: "year",
						step: 1,
						format: d => `${d.getFullYear()}`,
					},
					{
						unit: "month",
						step: 1,
						format: d => mShort[d.getMonth()],
					},
				];
		}
	},

	_getColumns(config) {
		// Map BC field names to SVAR task property names
		const fieldMap = {
			taskNo: "_bcTaskNo",
			name: "text",
			spent: "_bcSpent",
			etc_qty: "_bcEtcQty",
			bac_qty: "_bcBacQty",
			progress: "progress",
			start: "start",
			end: "end",
			status: "_bcStatus",
		};

		if (config.columns && config.columns.length) {
			return config.columns.map(c => ({
				id: fieldMap[c.field] || c.field || c.id,
				header: c.label || c.header || "",
				width: c.width || 100,
				flexgrow: c.flexgrow || 0,
				align: c.align || "left",
			}));
		}
		// Default columns
		return [
			{ id: "text", header: "Task", flexgrow: 2 },
			{ id: "start", header: "Start", width: 100, align: "center" },
			{ id: "duration", header: "Duration", width: 80, align: "center" },
		];
	},

	setReadOnly(isReadOnly) {
		this._readOnly = isReadOnly;
		// Rebuild if already mounted
		if (this._gantt && this._api) {
			// SVAR doesn't have a runtime readonly toggle, need remount
		}
	},

	setViewMode(mode) {
		if (!this._api) return;
		const m = mode.toLowerCase();
		const scales = this._getScales(m);
		const cellWidth = m === "day" ? 40 : m === "week" ? 100 : 120;
		const store = this._api.getStores().data;
		store.setState({ scales, cellWidth, _cellWidth: cellWidth });
	},

	scrollToDate(dateStr) {
		// SVAR handles scroll internally
		if (!this._api) return;
		this._api.exec("scroll-chart", { date: new Date(dateStr) });
	},

	collapseAll() {
		if (!this._api) return;
		const state = this._api.getState();
		if (state && state.tasks) {
			state.tasks.forEach(t => {
				if (t.type === "summary" && t.open) {
					this._api.exec("open-task", { id: t.id, mode: false });
				}
			});
		}
	},

	expandAll() {
		if (!this._api) return;
		const state = this._api.getState();
		if (state && state.tasks) {
			state.tasks.forEach(t => {
				if (t.type === "summary" && !t.open) {
					this._api.exec("open-task", { id: t.id, mode: true });
				}
			});
		}
	},

	destroy() {
		if (this._gantt) {
			try {
				unmount(this._gantt);
			} catch {
				/* ignore */
			}
			this._gantt = null;
		}
		if (this._container) {
			this._container.innerHTML = "";
		}
		if (this._resizeHandler) {
			window.removeEventListener("resize", this._resizeHandler);
			this._resizeHandler = null;
		}
		this._api = null;
	},
};

window.BdySvarGantt = BdySvarGantt;

// ── BC ControlAddin global functions (called from AL) ──
window.LoadGanttData = function (jsonString) {
	BdySvarGantt.loadData(jsonString);
};
window.UpdateTask = function (taskJson) {
	// For individual task updates
	const task = JSON.parse(taskJson);
	if (BdySvarGantt._api) {
		BdySvarGantt._api.exec("update-task", {
			id: task.id,
			task: mapTasksToSvar([task])[0],
		});
	}
};
window.RemoveTask = function (taskId) {
	if (BdySvarGantt._api) {
		BdySvarGantt._api.exec("delete-task", { id: taskId });
	}
};
window.SetViewMode = function (mode) {
	BdySvarGantt.setViewMode(mode);
};
window.ScrollToDate = function (dateStr) {
	BdySvarGantt.scrollToDate(dateStr);
};
window.ScrollToTask = function (taskId) {
	if (BdySvarGantt._api) {
		BdySvarGantt._api.exec("select-task", { id: taskId });
	}
};
window.HighlightCriticalPath = function () {
	// PRO feature — no-op in open-source
};
window.SetReadOnly = function (isReadOnly) {
	BdySvarGantt.setReadOnly(isReadOnly);
};
window.CollapseAll = function () {
	BdySvarGantt.collapseAll();
};
window.ExpandAll = function () {
	BdySvarGantt.expandAll();
};
