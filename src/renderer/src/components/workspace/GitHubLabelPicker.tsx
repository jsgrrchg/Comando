import {
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";

import type { GitHubLabelSummary } from "@shared/ipc";

import { getViewportSafeMenuPosition } from "@renderer/app/utils/menu-position";

type GitHubLabelPickerItem = {
    readonly labels: readonly GitHubLabelSummary[];
    readonly number: number;
    readonly title: string;
};

export function GitHubLabelPicker({
    anchor,
    error,
    isLoading,
    isSaving,
    item,
    labels,
    leftBoundary,
    onClose,
    onSave,
    rightBoundary,
}: {
    readonly anchor: { readonly x: number; readonly y: number };
    readonly error: string | null;
    readonly isLoading: boolean;
    readonly isSaving: boolean;
    readonly item: GitHubLabelPickerItem;
    readonly labels: readonly GitHubLabelSummary[];
    readonly leftBoundary?: number;
    readonly onClose: () => void;
    readonly onSave: (labelNames: readonly string[]) => void;
    readonly rightBoundary?: number;
}) {
    const ref = useRef<HTMLDivElement | null>(null);
    const [query, setQuery] = useState("");
    const [position, setPosition] = useState(anchor);
    const [selectedNames, setSelectedNames] = useState<ReadonlySet<string>>(
        () => new Set(item.labels.map((label) => label.name)),
    );

    useEffect(() => {
        const handleMouseDown = (event: MouseEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node)) {
                onClose();
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                onClose();
            }
        };

        document.addEventListener("mousedown", handleMouseDown);
        document.addEventListener("keydown", handleKeyDown);

        return () => {
            document.removeEventListener("mousedown", handleMouseDown);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [onClose]);

    const labelOptions = useMemo(() => {
        const knownNames = new Set(labels.map((label) => label.name));
        return [
            ...labels,
            ...item.labels.filter((label) => !knownNames.has(label.name)),
        ];
    }, [item.labels, labels]);
    const normalizedQuery = query.trim().toLowerCase();
    const visibleLabels = labelOptions.filter(
        (label) =>
            !normalizedQuery ||
            label.name.toLowerCase().includes(normalizedQuery) ||
            (label.description?.toLowerCase().includes(normalizedQuery) ??
                false),
    );

    useLayoutEffect(() => {
        const element = ref.current;
        if (!element) {
            return;
        }

        const rect = element.getBoundingClientRect();
        const safePosition = getViewportSafeMenuPosition(
            anchor.x,
            anchor.y,
            rect.width,
            rect.height,
        );
        const rightClampedX =
            rightBoundary === undefined
                ? safePosition.x
                : Math.min(
                      safePosition.x,
                      Math.max(8, rightBoundary - rect.width - 8),
                  );
        setPosition({
            ...safePosition,
            x: Math.max(leftBoundary ?? 8, rightClampedX),
        });
    }, [
        anchor.x,
        anchor.y,
        error,
        isLoading,
        labelOptions.length,
        leftBoundary,
        rightBoundary,
        visibleLabels.length,
    ]);

    const toggleLabel = (labelName: string) => {
        setSelectedNames((current) => {
            const next = new Set(current);
            if (next.has(labelName)) {
                next.delete(labelName);
            } else {
                next.add(labelName);
            }
            return next;
        });
    };

    return createPortal(
        <div
            className="fixed w-[min(320px,calc(100vw-16px))] rounded-lg border border-border bg-bg-panel p-2 shadow-[0_18px_42px_rgba(0,0,0,0.34)]"
            data-context-menu-root="true"
            ref={ref}
            style={{
                left: position.x,
                maxWidth:
                    leftBoundary !== undefined && rightBoundary !== undefined
                        ? Math.max(200, rightBoundary - leftBoundary - 8)
                        : undefined,
                top: position.y,
                zIndex: 10020,
            }}
        >
            <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="text-[12px] font-semibold text-text-primary">
                        Edit Labels
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-text-secondary">
                        #{item.number} {item.title}
                    </div>
                </div>
                <button
                    className="review-action-btn"
                    onClick={onClose}
                    type="button"
                >
                    Close
                </button>
            </div>
            <input
                autoFocus
                className="mt-3 h-[24px] w-full rounded-md border border-border/70 bg-bg-primary px-2 font-mono text-[11px] text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))]"
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search labels..."
                value={query}
            />
            {error ? (
                <div className="mt-2 rounded-md border border-[color-mix(in_srgb,var(--diff-remove)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-remove)_8%,transparent)] px-2 py-1.5 text-[11px] text-text-primary">
                    {error}
                </div>
            ) : null}
            <div className="shell-scrollbar mt-2 max-h-64 space-y-1 overflow-y-auto pr-1">
                {isLoading ? (
                    <div className="px-1 py-2 text-[11px] text-text-secondary">
                        Loading labels...
                    </div>
                ) : null}
                {!isLoading && visibleLabels.length === 0 ? (
                    <div className="px-1 py-2 text-[11px] text-text-secondary">
                        No labels match this search.
                    </div>
                ) : null}
                {visibleLabels.map((label) => (
                    <label
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-text-primary hover:bg-bg-tertiary"
                        key={label.id || label.name}
                    >
                        <input
                            checked={selectedNames.has(label.name)}
                            className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                            onChange={() => toggleLabel(label.name)}
                            type="checkbox"
                        />
                        <span
                            aria-hidden="true"
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: `#${label.color}` }}
                        />
                        <span className="min-w-0 flex-1 truncate">
                            {label.name}
                        </span>
                    </label>
                ))}
            </div>
            <div className="mt-3 flex items-center justify-between gap-2">
                <button
                    className="review-action-btn"
                    disabled={isSaving || selectedNames.size === 0}
                    onClick={() => setSelectedNames(new Set())}
                    type="button"
                >
                    Clear
                </button>
                <div className="flex items-center gap-2">
                    <button
                        className="review-action-btn"
                        disabled={isSaving}
                        onClick={onClose}
                        type="button"
                    >
                        Cancel
                    </button>
                    <button
                        className="review-action-btn"
                        disabled={isSaving || isLoading}
                        onClick={() => onSave([...selectedNames])}
                        type="button"
                    >
                        {isSaving ? "Saving..." : "Save"}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
