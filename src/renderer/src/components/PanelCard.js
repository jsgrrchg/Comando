import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function PanelCard({ aside, children, className, eyebrow, title, }) {
    return (_jsxs("section", { className: [
            "rounded-lg border border-border bg-bg-secondary p-5",
            className,
        ]
            .filter(Boolean)
            .join(" "), children: [_jsxs("div", { className: "mb-4 flex items-start justify-between gap-3", children: [_jsxs("div", { className: "space-y-1", children: [eyebrow ? (_jsx("p", { className: "text-[11px] font-semibold uppercase tracking-[0.18em] text-text-secondary", children: eyebrow })) : null, _jsx("h2", { className: "text-lg font-semibold text-text-primary", children: title })] }), aside] }), children] }));
}
