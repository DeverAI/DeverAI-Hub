/**
 * @deverai/hub — client half.
 *
 * DeverAI Hub workbench UI for the DeepSeek Harness web shell: a resizable
 * right-side dock with Summary / Terminal / Files tabs, a sidebar toggle
 * button, and a settings page. Follows DSH: the file bridge and terminal act
 * on the harness workspace; no chat, no separate LLM channel. Pure workbench.
 *
 * Loaded by window.__ModuleLoader__ (CommonJS factory, require available).
 * React arrives through require("react"); elements are created with
 * React.createElement — no JSX. Timers go through the `timer` service
 * (ctx.interval / ctx.timeout), never setTimeout/setInterval globals.
 */
window.__ModuleLoader__.load({
	id: "@deverai/hub",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");
		const h = React.createElement;

		const PLUGIN_ID = "deverai-hub";
		const API_BASE = "/hub";
		/** Captured at apply(): fiber-owned timer service for dock auto-refresh. */
		let hubTimer = null;

		/* ================================================================ *
		 * API helper
		 * ================================================================ */

		const RPC_BASE = "deverai-hub";

		/**
		 * Call a hub endpoint. Uses DSH's host.call RPC when available
		 * (Package-private, no network stack), falls back to HTTP fetch for
		 * contexts where host is unavailable.
		 */
		async function api(method, endpoint, body) {
			// Convert /foo/bar → foo.bar for RPC
			const rpcMethod = RPC_BASE + endpoint.split("/").filter(Boolean).join(".");
			// Try RPC first (efficient, no network)
			if (typeof globalThis.host?.call === "function") {
				try {
					const result = await globalThis.host.call(rpcMethod, body ?? {});
					return result;
				} catch (rpcError) {
					// If RPC method not found, fall through to HTTP
					if (rpcError?.code === "method-not-found") { /* fall through */ }
					else throw rpcError;
				}
			}
			// HTTP fallback
			let response;
			try {
				response = await fetch(API_BASE + endpoint, {
					method,
					headers: body !== undefined ? { "content-type": "application/json" } : undefined,
					body: body !== undefined ? JSON.stringify(body) : undefined,
				});
			} catch (networkError) {
				const error = new Error("无法连接 Host(网络或服务未就绪)");
				error.code = "network";
				throw error;
			}
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			if (!response.ok || !payload || payload.ok !== true) {
				const info = payload && payload.error ? payload.error : {};
				const error = new Error(info.message || ("请求失败 HTTP " + response.status));
				error.code = info.code || String(response.status);
				error.status = response.status;
				throw error;
			}
			return payload.data;
		}

		/** Same contract as api(), but against the model-router prefix. */
		async function routerApi(method, endpoint, body) {
			// Try RPC first (model-router registers its own handlers)
			const rpcMethod = "deverai-router" + endpoint.split("/").filter(Boolean).join(".");
			if (typeof globalThis.host?.call === "function") {
				try {
					return await globalThis.host.call(rpcMethod, body ?? {});
				} catch (rpcError) {
					if (rpcError?.code === "method-not-found") { /* fall through */ }
					else throw rpcError;
				}
			}
			// HTTP fallback
			let response;
			try {
				response = await fetch("/router" + endpoint, {
					method,
					headers: body !== undefined ? { "content-type": "application/json" } : undefined,
					body: body !== undefined ? JSON.stringify(body) : undefined,
				});
			} catch (networkError) {
				const error = new Error("无法连接路由器(网络或服务未就绪)");
				error.code = "network";
				throw error;
			}
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			if (!response.ok || !payload || payload.ok !== true) {
				const info = payload && payload.error ? payload.error : {};
				const error = new Error(info.message || ("请求失败 HTTP " + response.status));
				error.code = info.code || String(response.status);
				error.status = response.status;
				throw error;
			}
			return payload.data;
		}

		function errorMessage(error) {
			return error && error.message ? String(error.message) : String(error);
		}

		/* ================================================================ *
		 * Dock store (visible / tab / width) + config persistence
		 * ================================================================ */

		const dockStore = {
			state: { visible: false, tab: "summary", width: 400, ready: false },
			userTouched: false,
			listeners: new Set(),
			getState() { return this.state; },
			subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
			emit() { for (const fn of [...this.listeners]) fn(); },
			patch(next, persist) {
				this.state = { ...this.state, ...next };
				// Any real interaction (open/close/tab/drag) outranks the server seed:
				// a late config response must never slam the dock shut mid-use.
				if (persist !== false) this.userTouched = true;
				this.emit();
				if (persist !== false) schedulePersist({ dock: { visible: this.state.visible, tab: this.state.tab, widthPx: this.state.width } });
			},
		};

		let persistTimer = null;
		let pendingPersist = null;
		function schedulePersist(patch) {
			pendingPersist = { ...(pendingPersist ?? {}), ...patch };
			if (persistTimer !== null) return;
			persistTimer = setTimeout(() => {
				persistTimer = null;
				const body = pendingPersist;
				pendingPersist = null;
				api("POST", "/config", body).catch(() => { /* persistence is best-effort */ });
			}, 500);
		}
		// The hub client owns no timer service inside the store module scope;
		// setTimeout here is replaced at apply time via ctx.timeout wrapper below.

		function useDockState() {
			if (typeof React.useSyncExternalStore === "function") {
				return React.useSyncExternalStore(
					(fn) => dockStore.subscribe(fn),
					() => dockStore.getState(),
				);
			}
			const [state, setState] = React.useState(dockStore.getState());
			React.useEffect(() => dockStore.subscribe(() => setState(dockStore.getState())), []);
			return state;
		}

		/* ================================================================ *
		 * Icons (stroke SVG, currentColor, no emoji anywhere)
		 * ================================================================ */

		function svgProps(size) {
			return {
				width: size ?? 16,
				height: size ?? 16,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.8,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true,
			};
		}

		const Icon = {
			hub: (size) => h("svg", svgProps(size),
				h("rect", { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }),
				h("rect", { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }),
				h("rect", { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }),
				h("path", { d: "M17.5 14v7M14 17.5h7" })),
			close: (size) => h("svg", svgProps(size), h("path", { d: "M6 6l12 12M18 6L6 18" })),
			refresh: (size) => h("svg", svgProps(size),
				h("path", { d: "M20 11a8 8 0 1 0-2.34 6.34" }), h("path", { d: "M20 5v6h-6" })),
			file: (size) => h("svg", svgProps(size),
				h("path", { d: "M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" }),
				h("path", { d: "M13 3v6h6" })),
			filePlus: (size) => h("svg", svgProps(size),
				h("path", { d: "M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" }),
				h("path", { d: "M13 3v6h6M12 12v6M9 15h6" })),
			folder: (size) => h("svg", svgProps(size),
				h("path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" })),
			folderPlus: (size) => h("svg", svgProps(size),
				h("path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" }),
				h("path", { d: "M12 11v6M9 14h6" })),
			chevronRight: (size) => h("svg", svgProps(size), h("path", { d: "M9 6l6 6-6 6" })),
			chevronDown: (size) => h("svg", svgProps(size), h("path", { d: "M6 9l6 6 6-6" })),
			trash: (size) => h("svg", svgProps(size),
				h("path", { d: "M4 7h16M10 11v6M14 11v6" }),
				h("path", { d: "M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" })),
			pen: (size) => h("svg", svgProps(size),
				h("path", { d: "M4 20l4-1L20 7l-3-3L5 16z" }), h("path", { d: "M14 6l3 3" })),
			terminal: (size) => h("svg", svgProps(size),
				h("path", { d: "M5 8l4 4-4 4" }), h("path", { d: "M12 17h7" })),
			chart: (size) => h("svg", svgProps(size),
				h("path", { d: "M4 20V10M10 20V4M16 20v-7M21 20H3" })),
			play: (size) => h("svg", svgProps(size), h("path", { d: "M7 5l12 7-12 7z" })),
			branch: (size) => h("svg", svgProps(size),
				h("circle", { cx: 6, cy: 6, r: 2.2 }), h("circle", { cx: 18, cy: 8, r: 2.2 }), h("circle", { cx: 6, cy: 18, r: 2.2 }),
				h("path", { d: "M6 8.2v7.6M8.2 6.5c5 .3 7.6 1 7.6 4.5 0 1.2-.6 2-1.8 2.5" })),
			snapshot: (size) => h("svg", svgProps(size),
				h("path", { d: "M12 3v9l6-3M5 7a7 7 0 1 0 14 0 7 7 0 0 0-14 0" })),
			restore: (size) => h("svg", svgProps(size),
				h("path", { d: "M4 11a8 8 0 1 0 2.34-6.34" }), h("path", { d: "M4 5v6h6" })),
			stop: (size) => h("svg", svgProps(size), h("rect", { x: 6, y: 6, width: 12, height: 12, rx: 1.5 })),
			warning: (size) => h("svg", svgProps(size),
				h("path", { d: "M12 3L2 20h20zM12 10v4M12 17v.5" })),
			check: (size) => h("svg", svgProps(size), h("path", { d: "M4 12l5 5L20 7" })),
			clock: (size) => h("svg", svgProps(size),
				h("circle", { cx: 12, cy: 12, r: 8 }), h("path", { d: "M12 8v4l3 2" })),
			settings: (size) => h("svg", svgProps(size),
				h("circle", { cx: 12, cy: 12, r: 3 }),
				h("path", { d: "M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.06-.4.1-.8.1-1.2z" })),
		};

		/* ================================================================ *
		 * Shared bits: banner, spinner text, buttons
		 * ================================================================ */

		function ErrorBanner(props) {
			const message = props.message;
			if (!message) return null;
			return h("div", { className: "dvh-banner dvh-banner-error", role: "alert" },
				Icon.warning(14),
				h("span", { className: "dvh-banner-text" }, message),
				props.onRetry ? h("button", { className: "dvh-btn dvh-btn-mini", onClick: props.onRetry }, "重试") : null,
			);
		}

		function SectionCard(props) {
			return h("div", { className: "dvh-card" },
				h("div", { className: "dvh-card-title" }, props.icon ? props.icon : null, h("span", null, props.title)),
				props.children,
			);
		}

		function formatBytes(bytes) {
			const value = Number(bytes) || 0;
			if (value < 1024) return value + " B";
			if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
			return (value / 1024 / 1024).toFixed(1) + " MB";
		}

		function formatTime(iso) {
			if (!iso) return "";
			try {
				const date = new Date(iso);
				const pad = (n) => String(n).padStart(2, "0");
				return pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
			} catch {
				return iso;
			}
		}

		/* ================================================================ *
		 * Files tab
		 * ================================================================ */

		function FilesTab() {
			const [tree, setTree] = React.useState(() => new Map([[".", { items: null, open: true, loading: false, error: null }]]));
			const [banner, setBanner] = React.useState(null);
			const [preview, setPreview] = React.useState(null); // {path, content, size, truncated}
			const [dialog, setDialog] = React.useState(null); // {mode:'newFile'|'newFolder'|'rename', dir, path, name}
			const [confirmDelete, setConfirmDelete] = React.useState(null); // {path, recursive}
			const [tick, setTick] = React.useState(0);

			const loadDir = React.useCallback(async (dirPath) => {
				setTree((prev) => {
					const next = new Map(prev);
					next.set(dirPath, { ...(next.get(dirPath) ?? {}), items: next.get(dirPath)?.items ?? null, loading: true, error: null });
					return next;
				});
				try {
					const data = await api("GET", "/fs/list?path=" + encodeURIComponent(dirPath));
					setTree((prev) => {
						const next = new Map(prev);
						next.set(dirPath, { items: data.items, open: true, loading: false, error: null });
						return next;
					});
				} catch (error) {
					setTree((prev) => {
						const next = new Map(prev);
						next.set(dirPath, { items: [], open: true, loading: false, error: errorMessage(error) });
						return next;
					});
				}
			}, []);

			React.useEffect(() => { loadDir("."); }, [loadDir, tick]);

			const toggleDir = (dirPath) => {
				const entry = tree.get(dirPath);
				if (entry && entry.open && !entry.error) {
					setTree((prev) => {
						const next = new Map(prev);
						next.set(dirPath, { ...entry, open: false });
						return next;
					});
				} else {
					loadDir(dirPath);
				}
			};

			const refreshAll = () => {
				setTree(new Map([[".", { items: null, open: true, loading: false, error: null }]]));
				setTick((value) => value + 1);
			};

			const openPreview = async (filePath) => {
				setPreview({ path: filePath, loading: true });
				try {
					const data = await api("GET", "/fs/read?maxBytes=262144&path=" + encodeURIComponent(filePath));
					setPreview({ path: data.path, content: data.content, size: data.size, truncated: data.truncated });
				} catch (error) {
					setPreview({ path: filePath, error: errorMessage(error) });
				}
			};

			const submitDialog = async () => {
				if (!dialog) return;
				const rawName = dialog.name.trim();
				if (!rawName) { setDialog(null); return; }
				try {
					if (dialog.mode === "newFile") {
						await api("POST", "/fs/write", { path: joinPath(dialog.dir, rawName), content: "" });
					} else if (dialog.mode === "newFolder") {
						await api("POST", "/fs/mkdir", { path: joinPath(dialog.dir, rawName) });
					} else if (dialog.mode === "rename") {
						await api("POST", "/fs/rename", { from: dialog.path, to: joinPath(parentOf(dialog.path), rawName) });
					}
					setDialog(null);
					const parent = dialog.mode === "rename" ? parentOf(dialog.path) : dialog.dir;
					invalidateDir(parent);
					loadDir(parent === "." ? "." : parent);
					loadDir(".");
				} catch (error) {
					setBanner(errorMessage(error));
				}
			};

			const invalidateDir = (dirPath) => {
				setTree((prev) => {
					const next = new Map(prev);
					next.delete(dirPath === "." ? "." : dirPath);
					return next;
				});
			};

			const submitDelete = async () => {
				if (!confirmDelete) return;
				try {
					await api("POST", "/fs/delete", { path: confirmDelete.path, confirm: true, recursive: confirmDelete.recursive });
					setConfirmDelete(null);
					const parent = parentOf(confirmDelete.path);
					invalidateDir(parent);
					loadDir(parent === "." ? "." : parent);
				} catch (error) {
					if (error.code === "not-empty") {
						// Non-empty directory: re-arm the dialog in recursive mode.
						setConfirmDelete({ path: confirmDelete.path, recursive: true });
					} else {
						setBanner(errorMessage(error));
						setConfirmDelete(null);
					}
				}
			};

			const renderRow = (item, dirPath, depth) => {
				const childPath = dirPath === "." ? item.name : dirPath + "/" + item.name;
				const entry = tree.get(childPath);
				const isOpen = Boolean(entry && entry.open);
				const rowKey = childPath;
				return h("div", { key: rowKey },
					h("div", {
						className: "dvh-file-row" + (item.type === "dir" ? " is-dir" : ""),
						style: { paddingLeft: 8 + depth * 14 },
						onDoubleClick: item.type === "file" ? () => openPreview(childPath) : undefined,
					},
						item.type === "dir"
							? h("button", { className: "dvh-tree-twist", onClick: () => toggleDir(childPath), title: isOpen ? "收起" : "展开" },
								isOpen ? Icon.chevronDown(13) : Icon.chevronRight(13))
							: h("span", { className: "dvh-tree-twist dvh-tree-spacer" }),
						h("span", { className: "dvh-file-icon" }, item.type === "dir" ? Icon.folder(14) : Icon.file(14)),
						h("button", {
							className: "dvh-file-name",
							title: childPath,
							onClick: item.type === "dir" ? () => toggleDir(childPath) : () => openPreview(childPath),
						}, item.name),
						item.type === "file" ? h("span", { className: "dvh-file-size" }, formatBytes(item.size)) : null,
						h("span", { className: "dvh-file-actions" },
							item.writable ? h("button", { className: "dvh-icon-btn", title: "重命名", onClick: () => setDialog({ mode: "rename", path: childPath, name: item.name }) }, Icon.pen(13)) : null,
							item.writable ? h("button", { className: "dvh-icon-btn", title: "删除", onClick: () => setConfirmDelete({ path: childPath, recursive: false }) }, Icon.trash(13)) : null,
						),
					),
					item.type === "dir" && isOpen
						? (entry?.loading ? h("div", { className: "dvh-tree-loading", style: { paddingLeft: 30 + depth * 14 } }, "加载中…")
							: entry?.error ? h("div", { className: "dvh-tree-error", style: { paddingLeft: 30 + depth * 14 } }, entry.error)
								: (entry?.items ?? []).map((child) => renderRow(child, childPath, depth + 1)))
						: null,
				);
			};

			const rootEntry = tree.get(".") ?? {};

			return h("div", { className: "dvh-tab-body dvh-files" },
				h("div", { className: "dvh-files-toolbar" },
					h("button", { className: "dvh-icon-btn", title: "新建文件(根目录)", onClick: () => setDialog({ mode: "newFile", dir: ".", name: "" }) }, Icon.filePlus(15)),
					h("button", { className: "dvh-icon-btn", title: "新建文件夹(根目录)", onClick: () => setDialog({ mode: "newFolder", dir: ".", name: "" }) }, Icon.folderPlus(15)),
					h("button", { className: "dvh-icon-btn", title: "刷新", onClick: refreshAll }, Icon.refresh(15)),
					h("span", { className: "dvh-toolbar-hint" }, "双击文件预览"),
				),
				h(ErrorBanner, { message: banner, onRetry: () => setBanner(null) }),
				h("div", { className: "dvh-tree" },
					rootEntry.loading && !rootEntry.items ? h("div", { className: "dvh-tree-loading" }, "加载中…") :
						rootEntry.error ? h("div", { className: "dvh-tree-error" }, rootEntry.error) :
							(rootEntry.items ?? []).length === 0 ? h("div", { className: "dvh-empty" }, "此目录为空") :
								(rootEntry.items ?? []).map((item) => renderRow(item, ".", 0)),
				),
				preview ? h(FilePreviewModal, { preview, onClose: () => setPreview(null) }) : null,
				dialog ? NameDialog({
					title: dialog.mode === "rename" ? "重命名" : dialog.mode === "newFolder" ? "新建文件夹" : "新建文件",
					value: dialog.name,
					onChange: (name) => setDialog({ ...dialog, name }),
					onSubmit: submitDialog,
					onCancel: () => setDialog(null),
				}) : null,
				confirmDelete ? h(ConfirmDialog, {
					title: "确认删除",
					text: "删除 " + confirmDelete.path + (confirmDelete.recursive ? "(含全部内容,递归删除)" : "") + "?该操作会先创建检查点。",
					confirmLabel: "删除",
					onCancel: () => setConfirmDelete(null),
					onConfirm: submitDelete,
				}) : null,
			);
		}

		function joinPath(dir, name) {
			return dir === "." || dir === "" ? name : dir + "/" + name;
		}

		function parentOf(p) {
			const index = p.lastIndexOf("/");
			return index <= 0 ? "." : p.slice(0, index);
		}

		function FilePreviewModal({ preview, onClose }) {
			React.useEffect(() => {
				const onKey = (event) => { if (event.key === "Escape") onClose(); };
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [onClose]);
			return h("div", { className: "dvh-modal-mask", onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); } },
				h("div", { className: "dvh-modal dvh-preview-modal" },
					h("div", { className: "dvh-modal-head" },
						h("span", { className: "dvh-modal-title" }, preview.path),
						h("span", { className: "dvh-modal-sub" },
							preview.loading ? "" : (typeof preview.size === "number" ? formatBytes(preview.size) : "") + (preview.truncated ? " · 已截断" : "")),
						h("button", { className: "dvh-icon-btn", onClick: onClose, title: "关闭 (Esc)" }, Icon.close(14)),
					),
					h("pre", { className: "dvh-preview-body" },
						preview.loading ? "加载中…" : preview.error ? preview.error : preview.content),
				));
		}

		function NameDialog({ title, value, onChange, onSubmit, onCancel }) {
			const inputRef = React.useRef(null);
			React.useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);
			return h("div", { className: "dvh-modal-mask", onMouseDown: (event) => { if (event.target === event.currentTarget) onCancel(); } },
				h("div", { className: "dvh-modal dvh-name-modal" },
					h("div", { className: "dvh-modal-head" }, h("span", { className: "dvh-modal-title" }, title)),
					h("input", {
						ref: inputRef,
						className: "dvh-input",
						value,
						placeholder: "名称",
						onChange: (event) => onChange(event.target.value),
						onKeyDown: (event) => { if (event.key === "Enter") onSubmit(); if (event.key === "Escape") onCancel(); },
					}),
					h("div", { className: "dvh-modal-actions" },
						h("button", { className: "dvh-btn", onClick: onCancel }, "取消"),
						h("button", { className: "dvh-btn dvh-btn-primary", onClick: onSubmit }, "确定"),
					)));
		}

		function ConfirmDialog({ title, text, confirmLabel, onCancel, onConfirm }) {
			return h("div", { className: "dvh-modal-mask", onMouseDown: (event) => { if (event.target === event.currentTarget) onCancel(); } },
				h("div", { className: "dvh-modal dvh-confirm-modal" },
					h("div", { className: "dvh-modal-head" },
						h("span", { className: "dvh-modal-title dvh-danger-text" }, Icon.warning(15), " " + title)),
					h("div", { className: "dvh-confirm-text" }, text),
					h("div", { className: "dvh-modal-actions" },
						h("button", { className: "dvh-btn", onClick: onCancel }, "取消"),
						h("button", { className: "dvh-btn dvh-btn-danger", onClick: onConfirm }, confirmLabel),
					)));
		}

		/* ================================================================ *
		 * Terminal tab
		 * ================================================================ */

		let terminalSeq = 0;

		function TerminalTab() {
			const [entries, setEntries] = React.useState([]); // {id, cmd, result?, pending?, danger?}
			const [input, setInput] = React.useState("");
			const [banner, setBanner] = React.useState(null);
			const [confirming, setConfirming] = React.useState(null); // cmd awaiting dangerOk
			const [busy, setBusy] = React.useState(false);
			const [history, setHistory] = React.useState([]);
			const [historyIndex, setHistoryIndex] = React.useState(-1);
			const bottomRef = React.useRef(null);
			const runningRef = React.useRef(false);

			React.useEffect(() => {
				if (bottomRef.current) bottomRef.current.scrollIntoView({ block: "end" });
			}, [entries]);

			const appendEntry = (entry) => setEntries((prev) => [...prev.slice(-40), entry]);
			const patchEntry = (id, patch) => setEntries((prev) => prev.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));

			const runCommand = async (cmdText, dangerOk) => {
				if (!cmdText || runningRef.current) return;
				runningRef.current = true;
				setBusy(true);
				setBanner(null);
				setConfirming(null);
				const id = "t" + (++terminalSeq);
				appendEntry({ id, cmd: cmdText, pending: true });
				try {
					const body = { cmd: cmdText, timeoutMs: 120000 };
					if (dangerOk) body.dangerOk = true;
					const result = await api("POST", "/term/run", body);
					patchEntry(id, { pending: false, result });
				} catch (error) {
					if (error.code === "danger-confirm-required") {
						patchEntry(id, { pending: false, blocked: true });
						setConfirming(cmdText);
					} else {
						patchEntry(id, { pending: false, runError: errorMessage(error) });
					}
				} finally {
					runningRef.current = false;
					setBusy(false);
				}
			};

			const submit = () => {
				const cmdText = input.trim();
				if (!cmdText) return;
				setInput("");
				setHistory((prev) => [...prev.filter((item) => item !== cmdText).slice(-49), cmdText]);
				setHistoryIndex(-1);
				runCommand(cmdText, false);
			};

			const navigateHistory = (direction) => {
				if (history.length === 0) return;
				let next = historyIndex;
				if (direction === "up") next = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
				else next = historyIndex < 0 ? -1 : Math.min(history.length - 1, historyIndex + 1);
				setHistoryIndex(next);
				setInput(next >= 0 ? history[next] : "");
			};

			const stopRunning = async () => {
				try {
					const state = await api("GET", "/term/state");
					if (state.running && state.running.length > 0) {
						await api("POST", "/term/stop", { id: state.running[state.running.length - 1] });
					}
				} catch (error) {
					setBanner(errorMessage(error));
				}
			};

			return h("div", { className: "dvh-tab-body dvh-term" },
				h("div", { className: "dvh-files-toolbar" },
					h("button", { className: "dvh-icon-btn", title: "清空显示", onClick: () => { setEntries([]); setConfirming(null); setBanner(null); } }, Icon.trash(15)),
					busy ? h("button", { className: "dvh-icon-btn dvh-danger-text", title: "中断最新任务", onClick: stopRunning }, Icon.stop(15)) : null,
					h("span", { className: "dvh-toolbar-hint" }, "命令在 DSH 工作区内执行 · 危险命令需显式确认"),
				),
				h(ErrorBanner, { message: banner, onRetry: () => setBanner(null) }),
				h("div", { className: "dvh-term-out" },
					entries.length === 0 ? h("div", { className: "dvh-empty" }, "尚未执行命令。输出将在此逐条展示。") : null,
					entries.map((entry) => h("div", { key: entry.id, className: "dvh-term-entry" },
						h("div", { className: "dvh-term-cmd" },
							h("span", { className: "dvh-term-prompt" }, ">"),
							h("span", { className: "dvh-term-cmdtext" }, entry.cmd),
							entry.pending ? h("span", { className: "dvh-term-flag" }, "运行中…") : null,
							entry.blocked ? h("span", { className: "dvh-term-flag dvh-warn-text" }, "已拦截") : null,
							entry.result && entry.result.timedOut ? h("span", { className: "dvh-term-flag dvh-warn-text" }, "超时中断") : null,
						),
						entry.runError ? h("div", { className: "dvh-term-error" }, entry.runError) : null,
						entry.result ? h("pre", { className: "dvh-term-pre" },
							(entry.result.stdout || "") + (entry.result.stderr ? (entry.result.stdout ? "\n" : "") + "[stderr]\n" + entry.result.stderr : "") || (entry.result.code === 0 ? "(无输出)" : ""),
							entry.result.truncated ? "\n…输出已截断…" : "",
						) : null,
						entry.result ? h("div", { className: "dvh-term-meta" },
							"exit " + (entry.result.code ?? "null") + " · " + entry.result.durationMs + "ms · " + entry.result.shell,
						) : null,
					)),
					h("div", { ref: bottomRef }),
				),
				confirming ? h("div", { className: "dvh-danger-bar" },
					Icon.warning(14),
					h("span", { className: "dvh-danger-bar-text" }, "危险命令模式命中: "),
					h("code", null, confirming),
					h("span", { className: "dvh-flex-spacer" }),
					h("button", { className: "dvh-btn dvh-btn-mini", onClick: () => setConfirming(null) }, "取消"),
					h("button", { className: "dvh-btn dvh-btn-mini dvh-btn-danger", onClick: () => runCommand(confirming, true) }, "仍要执行"),
				) : null,
				h("div", { className: "dvh-term-input-row" },
					h("span", { className: "dvh-term-prompt" }, ">"),
					h("input", {
						className: "dvh-input dvh-term-input",
						value: input,
						spellCheck: false,
						placeholder: busy ? "命令执行中…" : "输入命令,回车执行;上/下箭头翻历史",
						disabled: busy,
						onChange: (event) => setInput(event.target.value),
						onKeyDown: (event) => {
							if (event.key === "Enter") { event.preventDefault(); submit(); }
							else if (event.key === "ArrowUp") { event.preventDefault(); navigateHistory("up"); }
							else if (event.key === "ArrowDown") { event.preventDefault(); navigateHistory("down"); }
						},
					}),
					h("button", { className: "dvh-btn dvh-btn-primary", disabled: busy || !input.trim(), onClick: submit, title: "执行" }, Icon.play(14)),
				));
		}

		/* ================================================================ *
		 * Summary tab
		 * ================================================================ */

		function SummaryTab({ overview, loading, error, onRefresh }) {
			if (loading && !overview) return h("div", { className: "dvh-tab-body" }, h("div", { className: "dvh-empty" }, "加载中…"));
			if (error && !overview) return h("div", { className: "dvh-tab-body" }, h(ErrorBanner, { message: error, onRetry: onRefresh }));
			if (!overview) return null;
			const workspace = overview.workspace ?? {};
			const counts = overview.counts ?? {};
			return h("div", { className: "dvh-tab-body" },
				h(SectionCard, { icon: Icon.folder(14), title: "工作区" },
					h("div", { className: "dvh-kv" },
						h("span", { className: "dvh-kv-key" }, "根目录"),
						h("span", { className: "dvh-kv-val dvh-mono", title: workspace.root }, workspace.root),
					),
					workspace.overrideActive ? h("div", { className: "dvh-note" }, "已启用手动覆盖(设置页可改回跟随 DSH)") : h("div", { className: "dvh-note" }, "跟随 DeepSeek Harness 工作区"),
				),
				h(SectionCard, { icon: Icon.check(14), title: "检查点与终端" },
					h("div", { className: "dvh-stat-row" },
						h("span", { className: "dvh-stat" }, String(counts.checkpoints ?? 0), h("span", { className: "dvh-stat-label" }, "检查点")),
						h("span", { className: "dvh-stat" }, String(counts.runningTerminals ?? 0), h("span", { className: "dvh-stat-label" }, "运行中终端")),
					),
				),
				h(CheckpointListCompact, {}),
				h(SectionCard, { icon: Icon.clock(14), title: "最近动作(audit)" },
					(overview.recentAudit ?? []).length === 0
						? h("div", { className: "dvh-empty" }, "暂无记录")
						: h("div", { className: "dvh-audit-list" },
							(overview.recentAudit ?? []).slice().reverse().slice(0, 8).map((entry, index) =>
								h("div", { key: index, className: "dvh-audit-row" },
									h("span", { className: "dvh-audit-ts dvh-mono" }, formatTime(entry.ts)),
									h("span", { className: "dvh-audit-action" }, auditActionLabel(entry.action)),
									h("span", { className: "dvh-audit-target dvh-mono", title: String(entry.target ?? "") }, String(entry.target ?? "").slice(0, 42)),
									entry.ok === false ? h("span", { className: "dvh-warn-text" }, "失败") : null,
								))),
				),
				h(SectionCard, { icon: Icon.settings(14), title: "关于" },
					h("div", { className: "dvh-note" }, "DeverAI Hub v" + (overview.version ?? "?") + " · 纯工作台,无独立聊天;AI 能力来自 DSH 会话。"),
					h("div", { className: "dvh-note dvh-mono dvh-break", title: overview.storage?.root }, "数据目录: " + (overview.storage?.root ?? "")),
				),
			);
		}

		function auditActionLabel(action) {
			const table = { write: "写入", mkdir: "建目录", rename: "改名", delete: "删除", restore: "恢复", terminal: "终端" };
			return table[action] ?? action;
		}

		function CheckpointListCompact() {
			const [items, setItems] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [busyId, setBusyId] = React.useState(null);
			const load = React.useCallback(async () => {
				try {
					const data = await api("GET", "/checkpoints?limit=6");
					setItems(data.items);
				} catch (err) { setError(errorMessage(err)); }
			}, []);
			React.useEffect(() => { load(); }, [load]);
			const restore = async (id) => {
				setBusyId(id);
				try {
					await api("POST", "/checkpoints/restore", { id });
					await load();
				} catch (err) { setError(errorMessage(err)); }
				finally { setBusyId(null); }
			};
			return h(SectionCard, { icon: Icon.refresh(14), title: "检查点(最近)" },
				error ? h(ErrorBanner, { message: error, onRetry: load }) : null,
				items === null ? h("div", { className: "dvh-empty" }, "加载中…")
					: items.length === 0 ? h("div", { className: "dvh-empty" }, "暂无检查点;首次覆盖写入后会自动出现")
						: h("div", { className: "dvh-cp-list" },
							items.map((cp) => h("div", { key: cp.id, className: "dvh-cp-row" },
								h("span", { className: "dvh-audit-ts dvh-mono" }, formatTime(cp.ts)),
								h("span", { className: "dvh-cp-path dvh-mono", title: cp.absolute ?? cp.path }, cp.path),
								h("span", { className: "dvh-file-size" }, formatBytes(cp.size)),
								h("button", { className: "dvh-btn dvh-btn-mini", disabled: busyId === cp.id, onClick: () => restore(cp.id), title: "恢复到此快照" }, busyId === cp.id ? "恢复中" : "恢复"),
							))));
		}

		/* ================================================================ *
		 * Settings page
		 * ================================================================ */

		function HubSettingsPage() {
			const [info, setInfo] = React.useState(null);
			const [loadError, setError] = React.useState(null);
			const [saveState, setSaveState] = React.useState(null); // 'saved' | Error string
			const [workspaceInput, setWorkspaceInput] = React.useState("");

			const reload = React.useCallback(async () => {
				try {
					const data = await api("GET", "/state/overview");
					setInfo(data);
					setWorkspaceInput(data.config?.workspaceOverride ?? "");
					setError(null);
				} catch (err) {
					setError(errorMessage(err));
				}
			}, []);
			React.useEffect(() => { reload(); }, [reload]);

			const saveTimer = React.useRef(null);
			React.useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);
			const save = async (patch) => {
				try {
					await api("POST", "/config", patch);
					setSaveState("saved");
					if (saveTimer.current) clearTimeout(saveTimer.current);
					saveTimer.current = setTimeout(() => setSaveState(null), 1500);
					await reload();
				} catch (err) {
					setSaveState(errorMessage(err));
				}
			};

			if (loadError) return h("div", { className: "dvh-settings-page" }, h(ErrorBanner, { message: loadError, onRetry: reload }));
			if (!info) return h("div", { className: "dvh-settings-page" }, h("div", { className: "dvh-empty" }, "加载中…"));

			const cfg = info.config ?? {};
			return h("div", { className: "dvh-settings-page" },
				h("h3", { className: "dvh-settings-heading" }, "工作区"),
				h("div", { className: "dvh-settings-block" },
					h("div", { className: "dvh-note" }, "文件树与终端的作用范围。留空 = 跟随 DSH 启动工作区(sandbox 根目录);要固定到某个项目请填写绝对路径。"),
					h("div", { className: "dvh-settings-row" },
						h("input", {
							className: "dvh-input dvh-grow",
							value: workspaceInput,
							placeholder: "跟随 DSH(" + (info.workspace?.root ?? "") + ")",
							onChange: (event) => setWorkspaceInput(event.target.value),
						}),
						h("button", { className: "dvh-btn dvh-btn-primary", onClick: () => save({ workspaceOverride: workspaceInput.trim() }) }, "保存"),
						h("button", { className: "dvh-btn", onClick: () => { setWorkspaceInput(""); save({ workspaceOverride: "" }); } }, "恢复默认"),
					),
					cfg.workspaceOverride ? h("div", { className: "dvh-note dvh-warn-text" }, "当前为手动覆盖模式") : null,
				),

				h("h3", { className: "dvh-settings-heading" }, "文件"),
				h("div", { className: "dvh-settings-block" },
					ToggleRow({
						label: "允许写入 / 新建 / 改名",
						hint: "关闭后文件桥只读;所有覆盖写入都会先创建检查点",
						checked: cfg.files?.allowWrite !== false,
						onChange: (value) => save({ files: { allowWrite: value } }),
					}),
					ToggleRow({
						label: "允许删除",
						hint: "默认关闭。开启后删除仍需逐次显式确认,且自动创建检查点",
						checked: cfg.files?.allowDelete === true,
						danger: true,
						onChange: (value) => save({ files: { allowDelete: value } }),
					}),
				),

				h("h3", { className: "dvh-settings-heading" }, "终端"),
				h("div", { className: "dvh-settings-block" },
					ToggleRow({
						label: "启用终端",
						hint: "在工作区内执行命令;超时自动中断",
						checked: cfg.terminal?.enabled !== false,
						onChange: (value) => save({ terminal: { enabled: value } }),
					}),
					ToggleRow({
						label: "危险命令需二次确认",
						hint: "rm -rf、rd /s、taskkill /f、shutdown 等模式命中时要求显式确认",
						checked: cfg.terminal?.dangerConfirm !== false,
						onChange: (value) => save({ terminal: { dangerConfirm: value } }),
					}),
					h("div", { className: "dvh-settings-row" },
						h("label", { className: "dvh-settings-label" }, "Shell"),
						h("select", {
							className: "dvh-select",
							value: cfg.terminal?.shell ?? "powershell",
							onChange: (event) => save({ terminal: { shell: event.target.value } }),
						},
							h("option", { value: "powershell" }, "Windows PowerShell"),
							h("option", { value: "pwsh" }, "PowerShell (pwsh)"),
							h("option", { value: "cmd" }, "CMD")),
					),
				),

				h("h3", { className: "dvh-settings-heading" }, "Dock"),
				h("div", { className: "dvh-settings-block" },
					h("div", { className: "dvh-settings-row" },
						h("label", { className: "dvh-settings-label" }, "默认标签页"),
						h("select", {
							className: "dvh-select",
							value: cfg.dock?.tab ?? "summary",
							onChange: (event) => save({ dock: { tab: event.target.value } }),
						},
							h("option", { value: "summary" }, "Summary"),
							h("option", { value: "terminal" }, "Terminal"),
							h("option", { value: "files" }, "Files")),
					),
					h("div", { className: "dvh-settings-row" },
						h("label", { className: "dvh-settings-label" }, "启动时展开"),
						ToggleRow({
							label: "",
							hint: "",
							checked: cfg.dock?.visible === true,
							onChange: (value) => save({ dock: { visible: value } }),
						}),
					),
				),

				h("h3", { className: "dvh-settings-heading" }, "数据与安全"),
				h("div", { className: "dvh-settings-block" },
					h("div", { className: "dvh-note dvh-mono dvh-break" }, "存储目录: " + (info.storage?.root ?? "")),
					h("div", { className: "dvh-note" }, "敏感文件(api.txt/.env/config.json/Err.log)全深度禁读写;.git/node_modules/.dsh 禁写删;路径越界一律拒绝;全部动作写审计日志。"),
				),
				saveState ? h("div", { className: "dvh-note " + (saveState === "saved" ? "dvh-ok-text" : "dvh-warn-text") },
					saveState === "saved" ? "已保存" : saveState) : null,
			);
		}

		function ToggleRow({ label, hint, checked, onChange, danger }) {
			return h("label", { className: "dvh-toggle-row" },
				h("span", { className: "dvh-toggle-text" },
					h("span", { className: "dvh-toggle-label" + (danger ? " dvh-danger-text" : "") }, label),
					hint ? h("span", { className: "dvh-toggle-hint" }, hint) : null),
				h("button", {
					className: "dvh-switch" + (checked ? " is-on" : ""),
					role: "switch",
					"aria-checked": checked,
					onClick: (event) => { event.preventDefault(); onChange(!checked); },
				}, h("span", { className: "dvh-switch-knob" })),
			);
		}

		/* ================================================================ *
		 * The dock itself
		 * ================================================================ */

		function SnapshotTab() {
			// --- Level 2: workspace snapshots (full-workspace zip) ---
			const [snaps, setSnaps] = React.useState(null);
			const [snapBusy, setSnapBusy] = React.useState(false);
			const [snapName, setSnapName] = React.useState("");
			const [snapError, setSnapError] = React.useState(null);

			// --- Level 1: file checkpoints (.bak per write) ---
			const [cps, setCps] = React.useState(null);
			const [cpBusy, setCpBusy] = React.useState(false);
			const [cpError, setCpError] = React.useState(null);
			const [cpExpand, setCpExpand] = React.useState({}); // file -> bool

			const loadSnaps = React.useCallback(async () => {
				setSnapBusy(true);
				try {
					const data = await api("GET", "/snapshots");
					setSnaps(data.items ?? []);
					setSnapError(null);
				} catch (err) { setSnapError(errorMessage(err)); }
				finally { setSnapBusy(false); }
			}, []);

			const loadCps = React.useCallback(async () => {
				setCpBusy(true);
				try {
					const data = await api("GET", "/checkpoints");
					setCps(data.items ?? []);
					setCpError(null);
				} catch (err) { setCpError(errorMessage(err)); }
				finally { setCpBusy(false); }
			}, []);

			React.useEffect(() => { loadSnaps(); loadCps(); }, [loadSnaps, loadCps]);

			const createSnap = async () => {
				if (snapBusy) return;
				setSnapBusy(true);
				try {
					await api("POST", "/snapshots/create", { name: snapName.trim() || `快照 ${new Date().toLocaleString()}` });
					setSnapName("");
					await loadSnaps();
				} catch (err) { setSnapError(errorMessage(err)); }
				finally { setSnapBusy(false); }
			};

			const restoreSnap = async (id) => {
				if (snapBusy) return;
				setSnapBusy(true);
				try {
					await api("POST", "/snapshots/restore", { id });
					await loadSnaps();
				} catch (err) { setSnapError(errorMessage(err)); }
				finally { setSnapBusy(false); }
			};

			const deleteSnap = async (id) => {
				if (snapBusy) return;
				setSnapBusy(true);
				try {
					await api("POST", "/snapshots/delete", { id });
					await loadSnaps();
				} catch (err) { setSnapError(errorMessage(err)); }
				finally { setSnapBusy(false); }
			};

			const restoreCp = async (id) => {
				if (cpBusy) return;
				setCpBusy(true);
				try {
					await api("POST", "/checkpoints/restore", { id });
					await loadCps();
				} catch (err) { setCpError(errorMessage(err)); }
				finally { setCpBusy(false); }
			};

			// Group checkpoints by file
			const cpByFile = {};
			for (const c of cps ?? []) {
				const key = c.path || c.absolute || String(c.id);
				(cpByFile[key] = cpByFile[key] ?? []).push(c);
			}
			const cpFiles = Object.keys(cpByFile).sort();

			const fmtSize = (n) => {
				if (!n) return "0 B";
				const u = ["B", "KB", "MB", "GB"];
				let i = 0; let v = n;
				while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
				return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
			};
			const fmtTs = (ts) => { try { return new Date(ts).toLocaleString(); } catch { return ts; } };

			return h("div", { className: "dvh-snapshot" },
				// ---------- Level 2: workspace snapshots ----------
				h("div", { className: "dvh-snap-section" },
					h("div", { className: "dvh-section-title" }, "工作区快照"),
					h("div", { className: "dvh-files-toolbar" },
						h("button", { className: "dvh-btn", onClick: loadSnaps, title: "刷新" }, Icon.refresh(14), h("span", null, "刷新")),
					),
					h("div", { className: "dvh-snap-create" },
						h("input", { className: "dvh-input", placeholder: "快照名称(可选)", value: snapName,
							onChange: (e) => setSnapName(e.target.value), disabled: snapBusy }),
						h("button", { className: "dvh-btn dvh-btn-primary", onClick: createSnap, disabled: snapBusy, title: "创建当前工作区的 zip 快照" },
							Icon.snapshot(14), h("span", null, "创建快照")),
					),
					snapError ? h("div", { className: "dvh-tree-error" }, snapError) : null,
					!snapError && snaps && snaps.length === 0 ? h("div", { className: "dvh-empty" }, "无快照——工作区改动前建议先创建一个") : null,
					h("div", { className: "dvh-tree" },
						(snaps ?? []).map((s) => h("div", { key: s.id, className: "dvh-snap-row" },
							h("div", { className: "dvh-snap-info" },
								h("div", { className: "dvh-file-name" }, s.name || "(未命名)"),
								h("div", { className: "dvh-file-meta" }, `${fmtTs(s.ts)} · ${fmtSize(s.size)}`),
							),
							h("div", { className: "dvh-row-actions" },
								h("button", { className: "dvh-icon-btn", title: "恢复此快照(恢复前会自动再做一次快照，可二次回退)", disabled: snapBusy,
									onClick: () => restoreSnap(s.id) }, Icon.restore(13)),
								h("button", { className: "dvh-icon-btn dvh-danger", title: "删除此快照", disabled: snapBusy,
									onClick: () => deleteSnap(s.id) }, Icon.trash(13)),
							),
						)),
					),
				),
				// ---------- Level 1: file checkpoints ----------
				h("div", { className: "dvh-snap-section" },
					h("div", { className: "dvh-section-title" }, "文件版本快照(写文件前自动备份)"),
					h("div", { className: "dvh-files-toolbar" },
						h("button", { className: "dvh-btn", onClick: loadCps, title: "刷新" }, Icon.refresh(14), h("span", null, "刷新")),
					),
					cpError ? h("div", { className: "dvh-tree-error" }, cpError) : null,
					!cpError && cps && cps.length === 0 ? h("div", { className: "dvh-empty" }, "无文件快照——通过 hub 文件桥改写文件时会自动备份") : null,
					h("div", { className: "dvh-tree" },
						cpFiles.map((file) => {
							const versions = cpByFile[file];
							const open = cpExpand[file];
							return h("div", { key: file, className: "dvh-cp-file" },
								h("div", { className: "dvh-cp-summary", onClick: () => setCpExpand({ ...cpExpand, [file]: !open }) },
									h("div", { className: "dvh-file-name" }, file, h("span", { className: "dvh-cp-count" }, `${versions.length}版`)),
									h("div", { className: "dvh-file-meta" }, `${versions.length} 个版本`),
								),
								open ? h("div", { className: "dvh-cp-versions" },
									versions.map((v) => h("div", { key: v.id, className: "dvh-cp-ver" },
										h("div", { className: "dvh-cp-ver-info" },
											h("span", { className: "dvh-cp-source" }, v.action || "unknown"),
											h("span", { className: "dvh-cp-ts" }, fmtTs(v.ts)),
										),
										h("button", { className: "dvh-icon-btn", title: "恢复此版本(恢复前会自动备份当前内容)", disabled: cpBusy,
											onClick: () => restoreCp(v.id) }, Icon.restore(13)),
									)),
								) : null,
							);
						}),
					),
				),
			);
		}

		function RouterTab() {
			const [snap, setSnap] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [probing, setProbing] = React.useState(null);

			const load = React.useCallback(async () => {
				try { setSnap(await routerApi("GET", "/state")); setError(null); }
				catch (err) { setError(errorMessage(err)); }
			}, []);
			React.useEffect(() => { load(); }, [load]);

			const patchConfig = async (patch) => {
				setBusy(true);
				try { setSnap(await routerApi("POST", "/config", patch)); setError(null); }
				catch (err) { setError(errorMessage(err)); }
				finally { setBusy(false); }
			};

			const toggleModel = async (id) => {
				if (!snap || busy) return;
				await patchConfig({ models: snap.models.map((m) => ({
					id: m.id, provider: m.provider, model: m.model, priority: m.priority,
					enabled: m.id === id ? !m.enabled : m.enabled,
				})) });
			};

			const probe = async (id) => {
				if (probing) return;
				setProbing(id);
				try { await routerApi("POST", "/probe", { id }); await load(); }
				catch (err) { setError(errorMessage(err)); await load(); }
				finally { setProbing(null); }
			};

			if (!snap) return h("div", { className: "dvh-tree-loading" }, error ?? "加载中…");
			return h("div", { className: "dvh-router" },
				h("div", { className: "dvh-files-toolbar" },
					h("button", { className: "dvh-btn", onClick: load, title: "刷新" }, Icon.refresh(14), h("span", null, "刷新")),
					h("label", { className: "dvh-wt-toggle" },
						h("input", { type: "checkbox", checked: snap.enabled === true, disabled: busy,
							onChange: (e) => patchConfig({ enabled: e.target.checked }) }),
						h("span", null, "启用路由"),
					),
					h("select", { className: "dvh-input dvh-router-select", value: snap.strategy, disabled: busy,
						onChange: (e) => patchConfig({ strategy: e.target.value }) },
						h("option", { value: "score" }, "按实力打分"),
						h("option", { value: "priority" }, "按优先级"),
						h("option", { value: "round-robin" }, "轮转"),
					),
				),
				!snap.gateActive ? h("div", { className: "dvh-danger-bar" },
					h("span", { className: "dvh-danger-bar-text" }, "此实例未开启路由(用 start-deverai.cmd 启动 fork 生效)")) : null,
				error ? h("div", { className: "dvh-tree-error" }, error) : null,
				snap.lastDecision && snap.lastDecision.action !== "pass" ?
					h("div", { className: "dvh-router-decision" },
						"最近决策: ", snap.lastDecision.action,
						snap.lastDecision.to ? ` ${snap.lastDecision.from} → ${snap.lastDecision.to}` : "",
					) : null,
				h("div", { className: "dvh-tree" },
					snap.models.map((m) => h("div", { key: m.id, className: "dvh-wt-row" },
						h("label", { className: "dvh-wt-toggle" },
							h("input", { type: "checkbox", checked: m.enabled, disabled: busy || !snap.gateActive,
								onChange: () => toggleModel(m.id) }),
						),
						h("div", { className: "dvh-wt-info" },
							h("div", { className: "dvh-file-name" }, m.id,
								m.cooling ? h("span", { className: "dvh-wt-tag dvh-danger-text" }, "冷却中") : null),
							h("div", { className: "dvh-file-meta" }, `${m.provider} · score ${m.score}` +
								(m.lastMs ? ` · ${m.lastMs}ms` : "")),
							h("div", { className: "dvh-router-window" },
								m.window.slice(-10).map((flag, i) => h("span", { key: i, className: flag ? "dvh-dot dvh-dot-ok" : "dvh-dot dvh-dot-bad" })),
							),
						),
						h("div", { className: "dvh-row-actions" },
							h("button", { className: "dvh-btn", disabled: probing !== null || !snap.gateActive,
								onClick: () => probe(m.id), title: "发送 ping 探活并计入打分" },
								h("span", null, probing === m.id ? "探测中…" : "探活")),
						),
					)),
					snap.models.length === 0 ? h("div", { className: "dvh-empty" }, "池为空;POST /router/config 可添加模型") : null,
				),
			);
		}

		const TABS = [
			{ id: "summary", label: "Summary", icon: Icon.chart },
			{ id: "terminal", label: "Terminal", icon: Icon.terminal },
			{ id: "files", label: "Files", icon: Icon.folder },
			{ id: "worktree", label: "Snapshot", icon: Icon.snapshot },
			{ id: "router", label: "Router", icon: Icon.chart },
		];

		function WorkbenchDock() {
			const state = useDockState();
			const [overview, setOverview] = React.useState(null);
			const [loading, setLoading] = React.useState(false);
			const [error, setError] = React.useState(null);

			const refreshOverview = React.useCallback(async () => {
				setLoading(true);
				try {
					const data = await api("GET", "/state/overview");
					setOverview(data);
					setError(null);
				} catch (err) {
					setError(errorMessage(err));
				} finally {
					setLoading(false);
				}
			}, []);

			// Refresh overview when opening or switching to summary; keep it fresh
			// with a fiber-owned interval while the summary tab stays visible.
			React.useEffect(() => {
				if (!state.visible) return undefined;
				if (state.tab === "summary") refreshOverview();
				return undefined;
			}, [state.visible, state.tab, refreshOverview]);

			React.useEffect(() => {
				if (!state.visible || state.tab !== "summary") return undefined;
				let alive = true;
				const tick = async () => {
					if (!alive) return;
					try {
						const data = await api("GET", "/state/overview");
						setOverview(data);
						setError(null);
					} catch { /* transient; banner already reflects last hard failure */ }
				};
				const disposer = hubTimer && typeof hubTimer.interval === "function"
					? hubTimer.interval(tick, 15000)
					: null;
				return () => { alive = false; if (disposer) disposer(); };
			}, [state.visible, state.tab]);

			const dragRef = React.useRef(null);
			const startDrag = (event) => {
				event.preventDefault();
				const startX = event.clientX;
				const startWidth = state.width;
				const move = (moveEvent) => {
					const nextWidth = Math.max(300, Math.min(720, startWidth + (startX - moveEvent.clientX)));
					dockStore.patch({ width: nextWidth });
				};
				const up = () => {
					window.removeEventListener("mousemove", move);
					window.removeEventListener("mouseup", up);
					document.body.classList.remove("dvh-dragging");
				};
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", up);
				document.body.classList.add("dvh-dragging");
				void dragRef;
			};

			if (!state.visible) return null;

			return h("div", { className: "dvh-overlay-root" },
				h("aside", { className: "dvh-dock", style: { width: state.width } },
					h("div", { className: "dvh-resize-handle", onMouseDown: startDrag, title: "拖拽调整宽度" }),
					h("header", { className: "dvh-dock-head" },
						h("span", { className: "dvh-dock-brand" }, Icon.hub(15), h("span", null, "DeverAI Hub")),
						h("nav", { className: "dvh-tabs" },
							TABS.map((tab) => h("button", {
								key: tab.id,
								className: "dvh-tab" + (state.tab === tab.id ? " is-active" : ""),
								onClick: () => dockStore.patch({ tab: tab.id }),
							}, tab.icon(14), h("span", null, tab.label)))),
						h("span", { className: "dvh-flex-spacer" }),
						h("button", { className: "dvh-icon-btn", title: "关闭 Dock", onClick: () => dockStore.patch({ visible: false }) }, Icon.close(15)),
					),
					h(ErrorBanner, { message: error, onRetry: refreshOverview }),
					h("div", { className: "dvh-dock-body" },
						state.tab === "summary" ? h(SummaryTab, { overview, loading, error, onRefresh: refreshOverview }) : null,
						state.tab === "terminal" ? h(TerminalTab) : null,
						state.tab === "files" ? h(FilesTab) : null,
						state.tab === "worktree" ? h(SnapshotTab) : null,
						state.tab === "router" ? h(RouterTab) : null,
					),
				));
		}

		/* ================================================================ *
		 * Sidebar toggle button
		 * ================================================================ */

		function HubToggleEntry() {
			const state = useDockState();
			return h("button", {
				className: "dvh-sidebar-btn" + (state.visible ? " is-active" : ""),
				title: "DeverAI Hub 工作台(Summary / Terminal / Files)",
				onClick: () => dockStore.patch({ visible: !state.visible }),
			}, Icon.hub(15), h("span", { className: "dvh-sidebar-btn-label" }, "Hub"));
		}

		/* ================================================================ *
		 * Styles
		 * ================================================================ */

		const CSS = `
.dvh-overlay-root{position:fixed;inset:0;z-index:60;pointer-events:none;display:flex;justify-content:flex-end;font-size:13px;color:var(--dsw-alias-label-primary,#1f2328)}
.dvh-dock{pointer-events:auto;position:relative;height:100%;display:flex;flex-direction:column;background:var(--dsw-specific-menu,#fff);border-left:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));box-shadow:-12px 0 32px rgba(0,0,0,.10);min-width:300px;max-width:720px}
.dvh-dragging,.dvh-dragging *{cursor:col-resize!important;user-select:none!important}
.dvh-resize-handle{position:absolute;left:-3px;top:0;bottom:0;width:6px;cursor:col-resize;z-index:2}
.dvh-dock-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));flex:none}
.dvh-dock-brand{display:inline-flex;align-items:center;gap:6px;font-weight:600;margin-right:2px}
.dvh-tabs{display:flex;gap:2px}
.dvh-tab{display:inline-flex;align-items:center;gap:5px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);padding:5px 9px;border-radius:8px;cursor:pointer;font:inherit}
.dvh-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dvh-tab.is-active{color:var(--dsw-alias-label-primary,#1f2328);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));font-weight:600}
.dvh-flex-spacer{flex:1}
.dvh-dock-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.dvh-tab-body{flex:1;min-height:0;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:10px}
.dvh-banner{display:flex;align-items:center;gap:6px;padding:7px 10px;border-radius:8px;font-size:12px}
.dvh-banner-error{background:var(--dsw-alias-state-error-bg,rgba(220,38,38,.08));color:var(--dsw-alias-state-error-primary,#b91c1c)}
.dvh-banner-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dvh-card{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-radius:10px;padding:9px 11px;background:var(--dsw-alias-bg-base,transparent)}
.dvh-card-title{display:flex;align-items:center;gap:6px;font-weight:600;margin-bottom:6px;color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.dvh-kv{display:flex;gap:8px;align-items:baseline;min-width:0}
.dvh-kv-key{flex:none;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px}
.dvh-kv-val{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dvh-note{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px;margin-top:4px;line-height:1.5}
.dvh-stat-row{display:flex;gap:18px}
.dvh-stat{font-size:20px;font-weight:600;display:flex;align-items:baseline;gap:6px}
.dvh-stat-label{font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary,#8b949e)}
.dvh-empty{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px;padding:8px 2px}
.dvh-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dvh-break{word-break:break-all}
.dvh-warn-text{color:var(--dsw-alias-state-warn-label,#b45309)}
.dvh-ok-text{color:var(--dsw-alias-state-success-primary,#15803d)}
.dvh-danger-text{color:var(--dsw-alias-state-error-primary,#b91c1c)}

.dvh-files-toolbar{display:flex;align-items:center;gap:4px;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06))}
.dvh-toolbar-hint{margin-left:auto;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px}
.dvh-tree{flex:1;overflow-y:auto;padding-top:4px}
.dvh-file-row{display:flex;align-items:center;gap:4px;height:28px;border-radius:6px;padding-right:6px}
.dvh-file-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dvh-tree-twist{width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border:none;background:transparent;color:inherit;cursor:pointer;border-radius:4px;flex:none}
.dvh-tree-spacer{cursor:default}
.dvh-file-icon{display:inline-flex;color:var(--dsw-alias-label-tertiary,#8b949e);flex:none}
.dvh-file-name{border:none;background:transparent;color:inherit;font:inherit;text-align:left;padding:2px 4px;border-radius:4px;cursor:pointer;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto}
.dvh-file-name:hover{text-decoration:underline}
.dvh-file-size{margin-left:auto;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px;flex:none}
.dvh-file-actions{display:none;align-items:center;gap:2px;margin-left:6px;flex:none}
.dvh-file-row:hover .dvh-file-actions{display:inline-flex}
.dvh-file-row:hover .dvh-file-size{display:none}
.dvh-tree-loading,.dvh-tree-error{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px;padding:4px 0}
.dvh-tree-error{color:var(--dsw-alias-state-error-primary,#b91c1c)}

.dvh-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);border-radius:6px;cursor:pointer}
.dvh-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:inherit}
.dvh-icon-btn:disabled{opacity:.4;cursor:default}
.dvh-btn{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent;color:inherit;font:inherit;font-size:12px;padding:4px 10px;border-radius:7px;cursor:pointer}
.dvh-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dvh-btn:disabled{opacity:.45;cursor:default}
.dvh-btn-primary{background:var(--dsw-alias-button-primary-bg,var(--dsw-alias-label-primary,#1f2328));color:var(--dsw-alias-button-primary-fg,#fff);border-color:transparent}
.dvh-btn-primary:hover{filter:brightness(1.08)}
.dvh-btn-danger{background:var(--dsw-alias-state-error-primary,#b91c1c);color:#fff;border-color:transparent}
.dvh-btn-mini{padding:2px 8px;font-size:11px}
.dvh-input{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:7px;padding:5px 9px;font:inherit;font-size:12px;background:transparent;color:inherit;min-width:0}
.dvh-input:focus{outline:1px solid var(--dsw-alias-label-tertiary,#8b949e)}
.dvh-select{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:7px;padding:4px 8px;font:inherit;font-size:12px;background:transparent;color:inherit}
.dvh-grow{flex:1}

.dvh-modal-mask{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;pointer-events:auto}
.dvh-modal{background:var(--dsw-specific-menu,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:12px;box-shadow:var(--dsw-shadow-lv3,0 12px 40px rgba(0,0,0,.25));display:flex;flex-direction:column;min-width:320px;max-width:min(760px,90vw);max-height:82vh}
.dvh-preview-modal{width:680px}
.dvh-name-modal,.dvh-confirm-modal{padding-bottom:10px}
.dvh-modal-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.07))}
.dvh-modal-title{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-flex;align-items:center;gap:4px}
.dvh-modal-sub{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px;flex:none}
.dvh-preview-body{margin:0;padding:12px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-all;flex:1;min-height:200px}
.dvh-name-modal .dvh-input{margin:10px 12px 0;width:calc(100% - 24px)}
.dvh-confirm-text{padding:10px 12px;font-size:12px;line-height:1.6}
.dvh-modal-actions{display:flex;justify-content:flex-end;gap:8px;padding:8px 12px 0}

.dvh-term{gap:8px}
.dvh-term-out{flex:1;min-height:0;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-radius:10px;padding:8px;background:var(--dsw-alias-markdown-code-bg,rgba(0,0,0,.03))}
.dvh-term-entry{margin-bottom:10px}
.dvh-term-cmd{display:flex;align-items:center;gap:6px;font-weight:600;flex-wrap:wrap}
.dvh-term-prompt{color:var(--dsw-alias-state-success-primary,#15803d);font-family:ui-monospace,Menlo,Consolas,monospace;flex:none}
.dvh-term-cmdtext{font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all}
.dvh-term-flag{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px;font-weight:400}
.dvh-term-pre{margin:4px 0 0;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-base,rgba(0,0,0,.02));font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all;max-height:280px;overflow-y:auto}
.dvh-term-error{color:var(--dsw-alias-state-error-primary,#b91c1c);font-size:12px;margin-top:4px}
.dvh-term-meta{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px;margin-top:2px}
.dvh-term-input-row{display:flex;align-items:center;gap:6px;flex:none}
.dvh-term-input{flex:1;font-family:ui-monospace,Menlo,Consolas,monospace}
.dvh-danger-bar{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;background:var(--dsw-alias-state-warn-bg,rgba(217,119,6,.10));color:var(--dsw-alias-state-warn-label,#b45309);flex:none;flex-wrap:wrap}
.dvh-wt-add{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,.06));flex:none;align-items:center}
.dvh-snap-create{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,.06));flex:none;align-items:center}
.dvh-snap-section{padding:4px 0}
.dvh-section-title{font-size:12px;font-weight:600;border-top:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,.06));padding-top:12px;margin:14px 0 8px;color:var(--dsw-alias-label-secondary,#57606a)}
.dvh-snap-row{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-radius:8px}
.dvh-snap-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dvh-snap-info{min-width:0}
.dvh-cp-file{border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,.04)}
.dvh-cp-summary{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-radius:8px;cursor:pointer}
.dvh-cp-summary:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dvh-cp-count{margin-left:6px;font-size:10px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-tertiary,#8b949e)}
.dvh-cp-versions{margin:2px 0 4px 18px;display:flex;flex-direction:column;gap:2px}
.dvh-cp-ver{display:flex;align-items:center;justify-content:space-between;padding:5px 10px;border-radius:6px}
.dvh-cp-ver:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dvh-cp-ver-info{display:flex;align-items:center;gap:8px;min-width:0}
.dvh-cp-source{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b949e);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));padding:1px 6px;border-radius:4px}
.dvh-cp-ts{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b949e)}
.dvh-wt-row{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-radius:8px}
.dvh-wt-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dvh-wt-main{opacity:.75}
.dvh-wt-tag{margin-left:6px;font-size:10px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-tertiary,#8b949e)}
.dvh-wt-info{min-width:0}
.dvh-danger{color:var(--dsw-alias-state-error-primary,#b91c1c)}
.dvh-danger:hover{background:var(--dsw-alias-state-error-bg,rgba(185,28,28,.12))}
.dvh-danger-armed{background:var(--dsw-alias-state-error-primary,#b91c1c);color:#fff}
.dvh-router-select{width:auto;padding:4px 8px}
.dvh-wt-toggle{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary,#57606a)}
.dvh-router-decision{padding:6px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b949e);border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,.06))}
.dvh-router-window{display:flex;gap:3px;margin-top:3px}
.dvh-dot{width:7px;height:7px;border-radius:999px;display:inline-block}
.dvh-dot-ok{background:var(--dsw-alias-state-success-primary,#15803d)}
.dvh-dot-bad{background:var(--dsw-alias-state-error-primary,#b91c1c)}
.dvh-danger-bar code{font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all}

.dvh-audit-list{display:flex;flex-direction:column}
.dvh-audit-row{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px;min-width:0}
.dvh-audit-ts{color:var(--dsw-alias-label-tertiary,#8b949e);flex:none;font-size:11px}
.dvh-audit-action{flex:none;width:44px;color:var(--dsw-alias-label-secondary,#57606a)}
.dvh-audit-target{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dvh-cp-list{display:flex;flex-direction:column}
.dvh-cp-row{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px;min-width:0}
.dvh-cp-path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}

.dvh-sidebar-btn{display:inline-flex;align-items:center;gap:7px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);font:inherit;font-size:13px;padding:6px 10px;border-radius:8px;cursor:pointer;max-width:100%}
.dvh-sidebar-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dvh-sidebar-btn.is-active{color:var(--dsw-alias-label-primary,#1f2328);font-weight:600}
.dvh-sidebar-btn-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.dvh-settings-page{padding:4px 2px 24px;display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-primary,#1f2328)}
.dvh-settings-heading{margin:14px 0 2px;font-size:13px;font-weight:700}
.dvh-settings-block{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.dvh-settings-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dvh-settings-label{font-size:12px;color:var(--dsw-alias-label-secondary,#57606a);min-width:64px}
.dvh-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer}
.dvh-toggle-text{display:flex;flex-direction:column;min-width:0}
.dvh-toggle-label{font-size:13px}
.dvh-toggle-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b949e);margin-top:1px;line-height:1.45}
.dvh-switch{flex:none;width:36px;height:20px;border-radius:999px;border:none;background:var(--dsw-alias-scrollbar-bg-l2,rgba(0,0,0,.18));position:relative;cursor:pointer;transition:background .15s}
.dvh-switch.is-on{background:var(--dsw-alias-state-success-primary,#15803d)}
.dvh-switch-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 3px rgba(0,0,0,.25)}
.dvh-switch.is-on .dvh-switch-knob{left:18px}
`;

		/* ================================================================ *
		 * apply
		 * ================================================================ */

		const inject = ["slots", "timer"];

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;

			hubTimer = ctx.get("timer") ?? null;
			stylesGuarded(ctx, CSS);

			// Seed dock state from persisted config once the first overview answers;
			// also keep the persisted values flowing into the store.
			let seeded = false;
			const seedOnce = (data) => {
				if (seeded || dockStore.userTouched || !data || !data.config || !data.config.dock) return;
				seeded = true;
				const dock = data.config.dock;
				dockStore.patch({
					visible: dock.visible === true,
					tab: typeof dock.tab === "string" ? dock.tab : "summary",
					width: Number(dock.widthPx) > 0 ? Number(dock.widthPx) : 400,
					ready: true,
				}, false);
			};
			api("GET", "/state/overview").then(seedOnce).catch(() => { seedOnce(null); });

			// Replace the module-scope setTimeout used by the persistence debounce
			// with a fiber-owned timer implementation.
			installTimer(ctx);

			slots.inject("sidebar.footer.action", () => slots.register(
				{ name: "sidebar.footer.action", id: PLUGIN_ID + "-toggle", order: 40, label: "DeverAI Hub" },
				HubToggleEntry,
			));

			slots.inject("shell.overlay", () => slots.register(
				{ name: "shell.overlay", id: PLUGIN_ID + "-dock", order: 90, label: "DeverAI Hub Dock" },
				WorkbenchDock,
			));

			slots.inject("settings.section", () => slots.register(
				{ name: "settings.section", id: PLUGIN_ID, order: 80, label: "DeverAI Hub" },
				HubSettingsPage,
			));

			// Global toggle shortcut: Ctrl+Alt+H. Fiber-owned listener, removed on stop.
			ctx.effect(() => {
				if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
				const onKey = (event) => {
					if (event.ctrlKey && event.altKey && (event.key === "h" || event.key === "H")) {
						event.preventDefault();
						dockStore.patch({ visible: !dockStore.getState().visible });
					}
				};
				window.addEventListener("keydown", onKey);

				// Black-box: any browser-side crash lands in the hub audit log so
				// failures stay diagnosable without devtools.
				const report = (message, stack) => {
					try { api("POST", "/client-error", { message, stack }).catch(() => {}); } catch { /* never loop */ }
				};
				const onError = (event) => {
					report(event.message || "window error", event.error && event.error.stack ? String(event.error.stack) : "");
				};
				const onRejection = (event) => {
					const reason = event.reason;
					report("unhandled rejection: " + (reason && reason.message ? reason.message : String(reason)),
						reason && reason.stack ? String(reason.stack) : "");
				};
				window.addEventListener("error", onError);
				window.addEventListener("unhandledrejection", onRejection);
				return () => {
					window.removeEventListener("keydown", onKey);
					window.removeEventListener("error", onError);
					window.removeEventListener("unhandledrejection", onRejection);
				};
			});
		}

		function stylesGuarded(ctx, css) {
			try {
				if (typeof styles !== "undefined" && styles && typeof styles.insert === "function") {
					ctx.effect(() => styles.insert(css));
					return;
				}
			} catch { /* fall through to manual style tag */ }
			if (typeof document === "undefined") return; // headless surface (tests, non-web)
			// Fallback: package-owned style tag removed on effect disposal.
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.setAttribute("data-plugin-css", PLUGIN_ID);
				tag.textContent = css;
				document.head.appendChild(tag);
				return () => { tag.remove(); };
			});
		}

		function installTimer(ctx) {
			// schedulePersist uses setTimeout at module scope; route it through the
			// timer service when present so stopping the plugin clears the debounce.
			const timerService = ctx.get("timer");
			if (!timerService || typeof timerService.timeout !== "function") return;
			schedulePersist = function (patch) {
				pendingPersist = { ...(pendingPersist ?? {}), ...patch };
				if (persistTimer !== null) return;
				let fired = false;
				const fire = () => {
					if (fired) return;
					fired = true;
					persistTimer = null;
					const body = pendingPersist;
					pendingPersist = null;
					api("POST", "/config", body).catch(() => {});
				};
				persistTimer = timerService.timeout(fire, 500);
			};
		}

		exports.name = PLUGIN_ID;
		exports.inject = inject;
		exports.apply = apply;
		exports.__dockStore = dockStore; // test seam

		return module.exports;
	},
});
