window.__ModuleLoader__.load({
	id: "@logictan/dsh-magpie-image",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		const { useEffect, useMemo, useState } = react;
		const h = react.createElement;

		// Kept in sync with src/protocol.js by hand; a build-time import of a
		// Node-only module is not available inside the browser bundle.
		const MAGPIE_IMAGE_API = "/api/dsh-magpie-image/image";

		/** The two tool names this view renders. */
		const TOOL_KEYS = ["mcp__magpie__generate_image", "mcp__magpie__generation_result"];

		function isSettled(block) {
			return block != null && typeof block === "object" && "kind" in block;
		}

		// Read the image references from the persisted presentation metadata.
		// The host does NOT promote `meta.images` into `content` image blocks on
		// current builds (measured 2026-11-07: content has only the JSON text
		// block while meta.images carries the refs), so a view that scanned
		// `content` alone rendered an empty card. Both spellings are normalized
		// to one camelCase shape so `imageUrl` has a single input.
		function imageRefsOf(block) {
			if (!isSettled(block)) return [];
			const metaImages = block.meta && Array.isArray(block.meta.images) ? block.meta.images : [];
			const fromMeta = metaImages.map((image) => ({
				attachmentId: String(image.attachment_id),
				mediaType: String(image.media_type),
				bytes: image.bytes,
				width: image.width,
				height: image.height,
				name: typeof image.name === "string" ? image.name : undefined,
			}));
			const fromContent = Array.isArray(block.content)
				? block.content.flatMap((part) =>
					part && part.type === "image" && part.attachment ? [part.attachment] : [])
				: [];
			const refs = fromMeta.length > 0 ? fromMeta : fromContent;
			return refs.filter((ref) => ref && ref.attachmentId !== "undefined" && ref.attachmentId !== ""
				&& Number.isFinite(ref.bytes) && Number.isFinite(ref.width) && Number.isFinite(ref.height));
		}

		function textOf(block) {
			if (!isSettled(block) || !Array.isArray(block.content)) return "";
			return block.content
				.filter((part) => part && part.type === "text" && typeof part.text === "string")
				.map((part) => part.text)
				.join("\n");
		}

		function resultInfo(block) {
			if (!isSettled(block)) return { status: "running", message: "正在生成图片…" };
			const text = textOf(block);
			try {
				const parsed = JSON.parse(text);
				return {
					status: typeof parsed.status === "string"
						? parsed.status
						: block.isError ? "failed" : "completed",
					message: typeof parsed.message === "string" ? parsed.message : "",
				};
			} catch {
				return { status: block.isError ? "failed" : "completed", message: text };
			}
		}

		function statusLabel(status) {
			if (status === "running" || status === "queued" || status === "pending") return "生成中";
			if (status === "failed") return "生成失败";
			if (status === "cancelled") return "已取消";
			return "生成图片";
		}

		function imageUrl(ref) {
			const query = new URLSearchParams({
				attachment_id: String(ref.attachmentId),
				media_type: String(ref.mediaType),
				bytes: String(ref.bytes),
				width: String(ref.width),
				height: String(ref.height),
			});
			return `${MAGPIE_IMAGE_API}?${query.toString()}`;
		}

		function useAttachmentImages(refs) {
			const key = useMemo(
				() => refs.map((ref) => String(ref.attachmentId)).join("|"),
				[refs],
			);
			const [images, setImages] = useState([]);
			const [error, setError] = useState(null);

			useEffect(() => {
				let disposed = false;
				const urls = [];
				setImages([]);
				setError(null);
				if (refs.length === 0) return () => {};

				void Promise.all(refs.map(async (ref) => {
					const response = await fetch(imageUrl(ref));
					if (!response.ok) throw new Error(`无法读取图片附件（HTTP ${response.status}）。`);
					const blob = await response.blob();
					const src = URL.createObjectURL(blob);
					urls.push(src);
					return { ref, src };
				}))
					.then((next) => { if (!disposed) setImages(next); })
					.catch((value) => {
						for (const url of urls) URL.revokeObjectURL(url);
						urls.length = 0;
						if (!disposed) setError(value instanceof Error ? value.message : String(value));
					});

				return () => {
					disposed = true;
					for (const url of urls) URL.revokeObjectURL(url);
					urls.length = 0;
				};
			}, [key]);

			return { images, error };
		}

		const S = {
			root: {
				display: "flex", flexDirection: "column", gap: "8px",
				border: "0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12))",
				borderRadius: "12px", padding: "12px 14px", margin: "4px 0 4px 4px",
				background: "var(--dsw-alias-bg-base, transparent)",
			},
			header: { display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" },
			tool: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			status: { marginLeft: "auto", color: "var(--dsw-alias-label-tertiary, #888)", fontSize: "12px", flex: "none" },
			message: { margin: 0, color: "var(--dsw-alias-label-secondary, #555)", fontSize: "12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
			images: { display: "flex", flexWrap: "wrap", gap: "8px" },
			link: { display: "block", lineHeight: 0 },
			image: { maxWidth: "320px", width: "100%", height: "auto", borderRadius: "8px", display: "block" },
			note: { margin: 0, color: "var(--dsw-alias-label-tertiary, #888)", fontSize: "12px" },
			error: { margin: 0, color: "var(--dsw-alias-state-error-primary, #d33)", fontSize: "12px" },
		};

		function MagpieImageView(props) {
			const refs = useMemo(() => imageRefsOf(props.block), [props.block]);
			const { status, message } = resultInfo(props.block);
			const { images, error } = useAttachmentImages(refs);

			return h("section", { style: S.root, "data-tool": props.toolName, "data-state": status },
				h("header", { style: S.header },
					h("strong", { style: S.tool }, props.toolName),
					h("span", { style: S.status }, statusLabel(status)),
				),
				message !== "" ? h("p", { style: S.message }, message) : null,
				images.length > 0 ? h("div", { style: S.images },
					images.map((image) => h("a", {
						key: String(image.ref.attachmentId),
						style: S.link, href: image.src, target: "_blank", rel: "noreferrer", title: "打开原图",
					}, h("img", { style: S.image, src: image.src, alt: image.ref.name ?? "生成图片" }))),
				) : null,
				refs.length > 0 && images.length === 0 && error === null
					? h("p", { style: S.note }, "正在加载图片…") : null,
				error !== null ? h("p", { style: S.error }, error) : null,
			);
		}

		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("tool.call.toolview", function* () {
				for (const key of TOOL_KEYS) {
					yield ctx.slots.register({
						name: "tool.call.toolview",
						key,
						inject: (sessionId) => ({ sessionId }),
					}, MagpieImageView);
				}
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
