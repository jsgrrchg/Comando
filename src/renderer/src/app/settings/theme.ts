import {
    AGENTS_SIDEBAR_SCALE_DEFAULT,
    clampAgentsSidebarScale,
} from "@shared/agents-sidebar-scale";
import {
    CHROME_TRANSPARENCY_DEFAULT,
    clampChromeTransparency,
} from "@shared/chrome-transparency";
import { APP_ZOOM_FACTOR_DEFAULT, clampAppZoomFactor } from "@shared/app-zoom";
import {
    EDITOR_AUTOSAVE_DELAY_MS_DEFAULT,
    clampEditorAutosaveDelayMs,
} from "@shared/editor-autosave";
import {
    FILE_TREE_SCALE_DEFAULT,
    clampFileTreeScale,
} from "@shared/file-tree-scale";
import type {
    AppAiChatSettings,
    AppAppearanceSettings,
    AppEditorSettings,
    ChatFontFamily,
    EditorFontFamily,
    ThemeMode,
    ThemePreset,
} from "@shared/ipc";
import { DEFAULT_AI_DIFF_ZOOM } from "@renderer/app/ai/sessionReviewContracts";
import {
    DEFAULT_AI_CHAT_FONT_FAMILY,
    DEFAULT_AI_CHAT_FONT_SIZE,
    DEFAULT_AI_COMPOSER_FONT_FAMILY,
    DEFAULT_AI_COMPOSER_FONT_SIZE,
    DEFAULT_EDITOR_FONT_FAMILY,
    DEFAULT_EDITOR_FONT_SIZE,
} from "@shared/typography";
import type { ComandoCodeColorAnchors } from "@renderer/app/editor/monacoTextmateTheme";

export interface ThemePresetOption {
    readonly description: string;
    readonly id: ThemePreset;
    readonly label: string;
    readonly swatches: readonly [string, string, string];
}

export interface EditorFontFamilyOption {
    readonly description: string;
    readonly group: "Sans" | "Serif" | "Mono";
    readonly id: EditorFontFamily;
    readonly label: string;
    readonly primaryFamily: string;
    readonly preview: string;
    readonly source: "bundled" | "system";
}

interface ThemeColors {
    readonly accent: string;
    readonly bgElevated: string;
    readonly bgPrimary: string;
    readonly bgSecondary: string;
    readonly bgTertiary: string;
    readonly border: string;
    readonly iconMuted: string;
    readonly shadowSoft: string;
    readonly textPrimary: string;
    readonly textSecondary: string;
}

interface ThemePaletteCodeColors {
    readonly dark: ComandoCodeColorAnchors;
    readonly light: ComandoCodeColorAnchors;
}

interface ThemePalette {
    readonly dark: ThemeColors;
    readonly label: string;
    readonly light: ThemeColors;
}

export interface ComandoThemeTokens {
    readonly accent: string;
    readonly accentSoft: string;
    readonly accentStrong: string;
    readonly app: string;
    readonly bgChrome: string;
    readonly bgElevated: string;
    readonly bgPanel: string;
    readonly bgPrimary: string;
    readonly bgSecondary: string;
    readonly bgTertiary: string;
    readonly border: string;
    readonly borderStrong: string;
    readonly borderSubtle: string;
    readonly code: ComandoCodeColorAnchors;
    readonly editor: string;
    readonly editorText: string;
    readonly selection: string;
    readonly shadowSoft: string;
    readonly textPrimary: string;
    readonly textSecondary: string;
}

const THEME_PRESET_ORDER: readonly ThemePreset[] = [
    "default",
    "ocean",
    "forest",
    "rose",
    "amber",
    "lavender",
    "nord",
    "sunset",
    "catppuccin",
    "solarized",
    "tokyoNight",
    "gruvbox",
    "ayu",
    "nightOwl",
    "vesper",
    "rosePine",
    "kanagawa",
    "everforest",
    "synthwave84",
    "claude",
    "codex",
];

const THEME_PALETTES: Record<ThemePreset, ThemePalette> = {
    default: {
        label: "Default",
        light: {
            bgPrimary: "#ffffff",
            bgSecondary: "#f5f5f5",
            bgTertiary: "#ebebeb",
            bgElevated: "#fcfcfc",
            textPrimary: "#1c1c1c",
            textSecondary: "#737373",
            border: "#e5e5e5",
            accent: "#6366f1",
            iconMuted: "#737373",
            shadowSoft: "0 18px 48px rgba(15, 23, 42, 0.08)",
        },
        dark: {
            bgPrimary: "#1c1c1c",
            bgSecondary: "#252525",
            bgTertiary: "#2e2e2e",
            bgElevated: "#232323",
            textPrimary: "#e8e8e8",
            textSecondary: "#8a8a8a",
            border: "#383838",
            accent: "#818cf8",
            iconMuted: "#9a9a9a",
            shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.28)",
        },
    },
    ocean: {
        label: "Ocean",
        light: {
            bgPrimary: "#f8fafc",
            bgSecondary: "#f0f4f8",
            bgTertiary: "#e2e8f0",
            bgElevated: "#f9fbfd",
            textPrimary: "#0f172a",
            textSecondary: "#64748b",
            border: "#cbd5e1",
            accent: "#0ea5e9",
            iconMuted: "#64748b",
            shadowSoft: "0 18px 48px rgba(15, 23, 42, 0.07)",
        },
        dark: {
            bgPrimary: "#0f172a",
            bgSecondary: "#1e293b",
            bgTertiary: "#334155",
            bgElevated: "#162032",
            textPrimary: "#e2e8f0",
            textSecondary: "#94a3b8",
            border: "#334155",
            accent: "#38bdf8",
            iconMuted: "#8494a7",
            shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.35)",
        },
    },
    forest: {
        label: "Forest",
        light: {
            bgPrimary: "#fafaf9",
            bgSecondary: "#f0f0ec",
            bgTertiary: "#e4e4df",
            bgElevated: "#fcfcfb",
            textPrimary: "#1c1917",
            textSecondary: "#78716c",
            border: "#d6d3d1",
            accent: "#10b981",
            iconMuted: "#78716c",
            shadowSoft: "0 18px 48px rgba(28, 25, 23, 0.06)",
        },
        dark: {
            bgPrimary: "#1a1a18",
            bgSecondary: "#242422",
            bgTertiary: "#2e2e2b",
            bgElevated: "#20201e",
            textPrimary: "#e7e5e4",
            textSecondary: "#a8a29e",
            border: "#3a3a36",
            accent: "#34d399",
            iconMuted: "#958e88",
            shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.30)",
        },
    },
    rose: {
        label: "Rose",
        light: {
            bgPrimary: "#fefcfd",
            bgSecondary: "#f8f0f4",
            bgTertiary: "#f0e4ea",
            bgElevated: "#fffafc",
            textPrimary: "#1f1215",
            textSecondary: "#886f78",
            border: "#e8d5dc",
            accent: "#e11d48",
            iconMuted: "#886f78",
            shadowSoft: "0 18px 48px rgba(31, 18, 21, 0.06)",
        },
        dark: {
            bgPrimary: "#1a1215",
            bgSecondary: "#241a1e",
            bgTertiary: "#2e2228",
            bgElevated: "#1f161a",
            textPrimary: "#ede4e7",
            textSecondary: "#a8949b",
            border: "#3a2830",
            accent: "#fb7185",
            iconMuted: "#9e8a91",
            shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.32)",
        },
    },
    amber: {
        label: "Amber",
        light: {
            bgPrimary: "#fffbf5",
            bgSecondary: "#f7f0e4",
            bgTertiary: "#ede4d3",
            bgElevated: "#fffcf7",
            textPrimary: "#1c1408",
            textSecondary: "#8a7a60",
            border: "#e2d6c1",
            accent: "#d97706",
            iconMuted: "#8a7a60",
            shadowSoft: "0 18px 48px rgba(28, 20, 8, 0.07)",
        },
        dark: {
            bgPrimary: "#1a1710",
            bgSecondary: "#242018",
            bgTertiary: "#2e2a20",
            bgElevated: "#1f1c14",
            textPrimary: "#eae4d8",
            textSecondary: "#a89e8a",
            border: "#3a3528",
            accent: "#f59e0b",
            iconMuted: "#9e9278",
            shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.30)",
        },
    },
    lavender: {
        label: "Lavender",
        light: {
            bgPrimary: "#fcfaff",
            bgSecondary: "#f3eefb",
            bgTertiary: "#e8e0f5",
            bgElevated: "#fdfbff",
            textPrimary: "#1a1525",
            textSecondary: "#7c6f96",
            border: "#ddd4ec",
            accent: "#8b5cf6",
            iconMuted: "#7c6f96",
            shadowSoft: "0 18px 48px rgba(26, 21, 37, 0.07)",
        },
        dark: {
            bgPrimary: "#18141f",
            bgSecondary: "#211c2a",
            bgTertiary: "#2b2536",
            bgElevated: "#1c1825",
            textPrimary: "#e8e2f0",
            textSecondary: "#9b90ad",
            border: "#352e42",
            accent: "#a78bfa",
            iconMuted: "#8d82a3",
            shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.32)",
        },
    },
    nord: {
        label: "Nord",
        light: {
            bgPrimary: "#eceff4",
            bgSecondary: "#e5e9f0",
            bgTertiary: "#d8dee9",
            bgElevated: "#edf0f5",
            textPrimary: "#2e3440",
            textSecondary: "#4c566a",
            border: "#d0d6e1",
            accent: "#5e81ac",
            iconMuted: "#4c566a",
            shadowSoft: "0 18px 48px rgba(46, 52, 64, 0.08)",
        },
        dark: {
            bgPrimary: "#2e3440",
            bgSecondary: "#3b4252",
            bgTertiary: "#434c5e",
            bgElevated: "#333a47",
            textPrimary: "#eceff4",
            textSecondary: "#d8dee9",
            border: "#4c566a",
            accent: "#88c0d0",
            iconMuted: "#b0b8c8",
            shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.30)",
        },
    },
    sunset: {
        label: "Sunset",
        light: {
            bgPrimary: "#fefaf8",
            bgSecondary: "#f8efe8",
            bgTertiary: "#f0e2d6",
            bgElevated: "#fffbf9",
            textPrimary: "#21150e",
            textSecondary: "#8c6e5a",
            border: "#e6d4c4",
            accent: "#ea580c",
            iconMuted: "#8c6e5a",
            shadowSoft: "0 18px 48px rgba(33, 21, 14, 0.07)",
        },
        dark: {
            bgPrimary: "#1a1410",
            bgSecondary: "#251d17",
            bgTertiary: "#30261e",
            bgElevated: "#1f1914",
            textPrimary: "#ece2d8",
            textSecondary: "#a8917e",
            border: "#3c3028",
            accent: "#fb923c",
            iconMuted: "#9e8774",
            shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.32)",
        },
    },
    catppuccin: {
        label: "Catppuccin",
        light: {
            bgPrimary: "#eff1f5",
            bgSecondary: "#e6e9ef",
            bgTertiary: "#dce0e8",
            bgElevated: "#f2f4f8",
            textPrimary: "#4c4f69",
            textSecondary: "#6c6f85",
            border: "#ccd0da",
            accent: "#8839ef",
            iconMuted: "#6c6f85",
            shadowSoft: "0 18px 48px rgba(76, 79, 105, 0.08)",
        },
        dark: {
            bgPrimary: "#1e1e2e",
            bgSecondary: "#262637",
            bgTertiary: "#313244",
            bgElevated: "#232336",
            textPrimary: "#cdd6f4",
            textSecondary: "#a6adc8",
            border: "#45475a",
            accent: "#cba6f7",
            iconMuted: "#9399b2",
            shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.35)",
        },
    },
    solarized: {
        label: "Solarized",
        light: {
            bgPrimary: "#fdf6e3",
            bgSecondary: "#eee8d5",
            bgTertiary: "#e4dcc8",
            bgElevated: "#fef8e6",
            textPrimary: "#073642",
            textSecondary: "#586e75",
            border: "#d3c6a6",
            accent: "#268bd2",
            iconMuted: "#586e75",
            shadowSoft: "0 18px 48px rgba(7, 54, 66, 0.07)",
        },
        dark: {
            bgPrimary: "#002b36",
            bgSecondary: "#073642",
            bgTertiary: "#0d4150",
            bgElevated: "#013b48",
            textPrimary: "#fdf6e3",
            textSecondary: "#93a1a1",
            border: "#11505e",
            accent: "#2aa198",
            iconMuted: "#839496",
            shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.40)",
        },
    },
    tokyoNight: {
        label: "Tokyo Night",
        light: {
            bgPrimary: "#e1e2e7",
            bgSecondary: "#d5d6db",
            bgTertiary: "#c8c9ce",
            bgElevated: "#e8e9ee",
            textPrimary: "#343b59",
            textSecondary: "#6172b0",
            border: "#c0c1c6",
            accent: "#2e7de9",
            iconMuted: "#6172b0",
            shadowSoft: "0 18px 48px rgba(52, 59, 89, 0.08)",
        },
        dark: {
            bgPrimary: "#1a1b26",
            bgSecondary: "#222337",
            bgTertiary: "#292e42",
            bgElevated: "#1e1f30",
            textPrimary: "#c0caf5",
            textSecondary: "#7982a9",
            border: "#33384e",
            accent: "#7aa2f7",
            iconMuted: "#8891b3",
            shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.38)",
        },
    },
    gruvbox: {
        label: "Gruvbox",
        light: {
            bgPrimary: "#fbf1c7",
            bgSecondary: "#f2e5bc",
            bgTertiary: "#e4d5a0",
            bgElevated: "#fdf4d0",
            textPrimary: "#3c3836",
            textSecondary: "#7c6f64",
            border: "#d5c4a1",
            accent: "#427b58",
            iconMuted: "#7c6f64",
            shadowSoft: "0 18px 48px rgba(60, 56, 54, 0.07)",
        },
        dark: {
            bgPrimary: "#282828",
            bgSecondary: "#3c3836",
            bgTertiary: "#504945",
            bgElevated: "#32302f",
            textPrimary: "#ebdbb2",
            textSecondary: "#a89984",
            border: "#504945",
            accent: "#8ec07c",
            iconMuted: "#a89984",
            shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.35)",
        },
    },
    ayu: {
        label: "Ayu",
        light: {
            bgPrimary: "#fcfcfc",
            bgSecondary: "#f8f9fa",
            bgTertiary: "#eef0f2",
            bgElevated: "#ffffff",
            textPrimary: "#5c6166",
            textSecondary: "#828e9f",
            border: "#e8eaed",
            accent: "#f29718",
            iconMuted: "#828e9f",
            shadowSoft: "0 18px 48px rgba(92, 97, 102, 0.08)",
        },
        dark: {
            bgPrimary: "#10141c",
            bgSecondary: "#0d1017",
            bgTertiary: "#151a23",
            bgElevated: "#141821",
            textPrimary: "#bfbdb6",
            textSecondary: "#5a6378",
            border: "#1b1f29",
            accent: "#e6b450",
            iconMuted: "#6b7a90",
            shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.35)",
        },
    },
    nightOwl: {
        label: "Night Owl",
        light: {
            bgPrimary: "#fbfbfb",
            bgSecondary: "#f0f0f0",
            bgTertiary: "#e4e4e4",
            bgElevated: "#f6f6f6",
            textPrimary: "#403f53",
            textSecondary: "#7e8a9e",
            border: "#d9d9d9",
            accent: "#2aa298",
            iconMuted: "#7e8a9e",
            shadowSoft: "0 18px 48px rgba(64, 63, 83, 0.08)",
        },
        dark: {
            bgPrimary: "#011627",
            bgSecondary: "#01111d",
            bgTertiary: "#0b253a",
            bgElevated: "#021d32",
            textPrimary: "#d6deeb",
            textSecondary: "#5f7e97",
            border: "#122d42",
            accent: "#82aaff",
            iconMuted: "#6d849c",
            shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.40)",
        },
    },
    vesper: {
        label: "Vesper",
        light: {
            bgPrimary: "#faf8f5",
            bgSecondary: "#f3f0eb",
            bgTertiary: "#e8e4dc",
            bgElevated: "#fdfcfa",
            textPrimary: "#1a1a1a",
            textSecondary: "#7e7e7e",
            border: "#e0dbd3",
            accent: "#c87830",
            iconMuted: "#7e7e7e",
            shadowSoft: "0 18px 48px rgba(26, 26, 26, 0.08)",
        },
        dark: {
            bgPrimary: "#101010",
            bgSecondary: "#0c0c0c",
            bgTertiary: "#1c1c1c",
            bgElevated: "#161616",
            textPrimary: "#ffffff",
            textSecondary: "#a0a0a0",
            border: "#282828",
            accent: "#ffc799",
            iconMuted: "#909090",
            shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.45)",
        },
    },
    rosePine: {
        label: "Rose Pine",
        light: {
            bgPrimary: "#faf4ed",
            bgSecondary: "#f2e9e1",
            bgTertiary: "#e6ddd4",
            bgElevated: "#fffaf3",
            textPrimary: "#575279",
            textSecondary: "#9893a5",
            border: "#dfd8cf",
            accent: "#d7827e",
            iconMuted: "#9893a5",
            shadowSoft: "0 18px 48px rgba(87, 82, 121, 0.08)",
        },
        dark: {
            bgPrimary: "#191724",
            bgSecondary: "#1f1d2e",
            bgTertiary: "#26233a",
            bgElevated: "#211f30",
            textPrimary: "#e0def4",
            textSecondary: "#908caa",
            border: "#2a2740",
            accent: "#ebbcba",
            iconMuted: "#7e79a0",
            shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.35)",
        },
    },
    kanagawa: {
        label: "Kanagawa",
        light: {
            bgPrimary: "#f2ecbc",
            bgSecondary: "#e5ddb0",
            bgTertiary: "#dcd5ac",
            bgElevated: "#f5f0c8",
            textPrimary: "#545464",
            textSecondary: "#8a8980",
            border: "#d5cea3",
            accent: "#4d699b",
            iconMuted: "#8a8980",
            shadowSoft: "0 18px 48px rgba(84, 84, 100, 0.10)",
        },
        dark: {
            bgPrimary: "#1F1F28",
            bgSecondary: "#16161D",
            bgTertiary: "#2A2A37",
            bgElevated: "#1a1a22",
            textPrimary: "#DCD7BA",
            textSecondary: "#727169",
            border: "#363646",
            accent: "#7E9CD8",
            iconMuted: "#838275",
            shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.35)",
        },
    },
    everforest: {
        label: "Everforest",
        light: {
            bgPrimary: "#FDF6E3",
            bgSecondary: "#F4F0D9",
            bgTertiary: "#EFEBD4",
            bgElevated: "#f9f5de",
            textPrimary: "#5C6A72",
            textSecondary: "#829181",
            border: "#E6E2CC",
            accent: "#8da101",
            iconMuted: "#829181",
            shadowSoft: "0 18px 48px rgba(92, 106, 114, 0.08)",
        },
        dark: {
            bgPrimary: "#2D353B",
            bgSecondary: "#343F44",
            bgTertiary: "#3D484D",
            bgElevated: "#313a40",
            textPrimary: "#D3C6AA",
            textSecondary: "#859289",
            border: "#475258",
            accent: "#A7C080",
            iconMuted: "#7a8a7e",
            shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.30)",
        },
    },
    synthwave84: {
        label: "Synthwave '84",
        light: {
            bgPrimary: "#faf5ff",
            bgSecondary: "#f0eaf8",
            bgTertiary: "#e4dcf0",
            bgElevated: "#fdf9ff",
            textPrimary: "#2a2139",
            textSecondary: "#695d85",
            border: "#dbd2ec",
            accent: "#d946a8",
            iconMuted: "#695d85",
            shadowSoft: "0 18px 48px rgba(42, 33, 57, 0.10)",
        },
        dark: {
            bgPrimary: "#262335",
            bgSecondary: "#241b2f",
            bgTertiary: "#2a2139",
            bgElevated: "#1e1a2c",
            textPrimary: "#ffffff",
            textSecondary: "#848bbd",
            border: "#34294f",
            accent: "#ff7edb",
            iconMuted: "#7a73a6",
            shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.40)",
        },
    },
    claude: {
        label: "Claude",
        light: {
            bgPrimary: "#faf9f5",
            bgSecondary: "#f4f3ee",
            bgTertiary: "#e8e6dc",
            bgElevated: "#fdfcfa",
            textPrimary: "#141413",
            textSecondary: "#8a8780",
            border: "#dfdcd4",
            accent: "#c15f3c",
            iconMuted: "#8a8780",
            shadowSoft: "0 18px 48px rgba(20, 20, 19, 0.07)",
        },
        dark: {
            bgPrimary: "#1a1917",
            bgSecondary: "#23221f",
            bgTertiary: "#2d2c28",
            bgElevated: "#1f1e1b",
            textPrimary: "#f4f3ee",
            textSecondary: "#a09d95",
            border: "#3a3835",
            accent: "#d97757",
            iconMuted: "#908d86",
            shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.32)",
        },
    },
    codex: {
        label: "Codex",
        light: {
            bgPrimary: "#ffffff",
            bgSecondary: "#f7f7f8",
            bgTertiary: "#ececf1",
            bgElevated: "#fcfcfd",
            textPrimary: "#1a1a1a",
            textSecondary: "#6e6e80",
            border: "#e5e5ea",
            accent: "#10a37f",
            iconMuted: "#6e6e80",
            shadowSoft: "0 18px 48px rgba(0, 0, 0, 0.06)",
        },
        dark: {
            bgPrimary: "#1e1e20",
            bgSecondary: "#2a2a2d",
            bgTertiary: "#343537",
            bgElevated: "#252528",
            textPrimary: "#ececf1",
            textSecondary: "#8e8ea0",
            border: "#3c3c41",
            accent: "#10a37f",
            iconMuted: "#8e8ea0",
            shadowSoft: "0 24px 56px rgba(0, 0, 0, 0.35)",
        },
    },
};

// Per-preset syntax highlight palettes. Each preset defines 12 "anchor"
// tokens used by Monaco's TextMate theme: the 12 named code categories
// covered by `ComandoCodeColorAnchors`. Canonical presets (nord, gruvbox,
// catppuccin, etc.) mirror the colors published in their original repos;
// the in-house presets (default, ocean, forest, rose, amber, lavender,
// sunset, claude, codex) were curated to harmonize with each preset's
// accent and base surfaces.
const CODE_PALETTES: Record<ThemePreset, ThemePaletteCodeColors> = {
    default: {
        light: {
            comment: "#737373",
            constant: "#9A3412",
            escape: "#BE185D",
            function: "#1D4ED8",
            keyword: "#6D28D9",
            markup: "#B42318",
            parameter: "#B45309",
            property: "#1E3A8A",
            string: "#0B6B3A",
            type: "#8A5A00",
            typeParameter: "#15803D",
            variable: "#1F2937",
        },
        dark: {
            comment: "#8A8A8A",
            constant: "#FDBA74",
            escape: "#F472B6",
            function: "#93C5FD",
            keyword: "#C4B5FD",
            markup: "#FCA5A5",
            parameter: "#FED7AA",
            property: "#FDA4AF",
            string: "#A7F3D0",
            type: "#FDE68A",
            typeParameter: "#86EFAC",
            variable: "#E5E7EB",
        },
    },
    ocean: {
        light: {
            comment: "#64748B",
            constant: "#B45309",
            escape: "#BE185D",
            function: "#0284C7",
            keyword: "#1D4ED8",
            markup: "#0369A1",
            parameter: "#0E7490",
            property: "#0F766E",
            string: "#047857",
            type: "#065F46",
            typeParameter: "#155E75",
            variable: "#0F172A",
        },
        dark: {
            comment: "#64748B",
            constant: "#FBA17E",
            escape: "#F9A8D4",
            function: "#38BDF8",
            keyword: "#93C5FD",
            markup: "#7DD3FC",
            parameter: "#BAE6FD",
            property: "#5EEAD4",
            string: "#86EFAC",
            type: "#A5F3FC",
            typeParameter: "#67E8F9",
            variable: "#E2E8F0",
        },
    },
    forest: {
        light: {
            comment: "#78716C",
            constant: "#B45309",
            escape: "#BE185D",
            function: "#047857",
            keyword: "#7E22CE",
            markup: "#854D0E",
            parameter: "#166534",
            property: "#15803D",
            string: "#166534",
            type: "#854D0E",
            typeParameter: "#0369A1",
            variable: "#1C1917",
        },
        dark: {
            comment: "#A8A29E",
            constant: "#FDBA74",
            escape: "#F9A8D4",
            function: "#6EE7B7",
            keyword: "#C4B5FD",
            markup: "#FCD34D",
            parameter: "#D6F0A2",
            property: "#A7F3D0",
            string: "#BEF264",
            type: "#FDE68A",
            typeParameter: "#67E8F9",
            variable: "#E7E5E4",
        },
    },
    rose: {
        light: {
            comment: "#886F78",
            constant: "#9F1239",
            escape: "#BE185D",
            function: "#9F1239",
            keyword: "#BE123C",
            markup: "#9F1239",
            parameter: "#9D174D",
            property: "#831843",
            string: "#065F46",
            type: "#854D0E",
            typeParameter: "#0369A1",
            variable: "#1F1215",
        },
        dark: {
            comment: "#A8949B",
            constant: "#FCA5A5",
            escape: "#F9A8D4",
            function: "#FDA4AF",
            keyword: "#F472B6",
            markup: "#FECACA",
            parameter: "#FED7AA",
            property: "#FBCFE8",
            string: "#BEF264",
            type: "#FCD34D",
            typeParameter: "#86EFAC",
            variable: "#EDE4E7",
        },
    },
    amber: {
        light: {
            comment: "#8A7A60",
            constant: "#9A3412",
            escape: "#BE185D",
            function: "#B45309",
            keyword: "#7E22CE",
            markup: "#9F1239",
            parameter: "#854D0E",
            property: "#92400E",
            string: "#166534",
            type: "#78350F",
            typeParameter: "#1E40AF",
            variable: "#1C1408",
        },
        dark: {
            comment: "#A89E8A",
            constant: "#FB923C",
            escape: "#F9A8D4",
            function: "#FCD34D",
            keyword: "#C4B5FD",
            markup: "#FECACA",
            parameter: "#FED7AA",
            property: "#FDE68A",
            string: "#BEF264",
            type: "#FDBA74",
            typeParameter: "#86EFAC",
            variable: "#EAE4D8",
        },
    },
    lavender: {
        light: {
            comment: "#7C6F96",
            constant: "#9A3412",
            escape: "#BE185D",
            function: "#6D28D9",
            keyword: "#5B21B6",
            markup: "#7E22CE",
            parameter: "#7C2D12",
            property: "#5B21B6",
            string: "#047857",
            type: "#854D0E",
            typeParameter: "#0E7490",
            variable: "#1A1525",
        },
        dark: {
            comment: "#9B90AD",
            constant: "#FCA5A5",
            escape: "#F472B6",
            function: "#C4B5FD",
            keyword: "#A78BFA",
            markup: "#DDD6FE",
            parameter: "#FDE68A",
            property: "#F9A8D4",
            string: "#A7F3D0",
            type: "#FCD34D",
            typeParameter: "#67E8F9",
            variable: "#E8E2F0",
        },
    },
    nord: {
        light: {
            comment: "#4C566A",
            constant: "#B48EAD",
            escape: "#D08770",
            function: "#5E81AC",
            keyword: "#5E81AC",
            markup: "#5E81AC",
            parameter: "#2E3440",
            property: "#2E3440",
            string: "#587539",
            type: "#5E81AC",
            typeParameter: "#5E81AC",
            variable: "#2E3440",
        },
        dark: {
            comment: "#616E88",
            constant: "#B48EAD",
            escape: "#EBCB8B",
            function: "#88C0D0",
            keyword: "#81A1C1",
            markup: "#88C0D0",
            parameter: "#D8DEE9",
            property: "#D8DEE9",
            string: "#A3BE8C",
            type: "#8FBCBB",
            typeParameter: "#8FBCBB",
            variable: "#D8DEE9",
        },
    },
    sunset: {
        light: {
            comment: "#8C6E5A",
            constant: "#B45309",
            escape: "#BE123C",
            function: "#C2410C",
            keyword: "#7C2D12",
            markup: "#9F1239",
            parameter: "#78350F",
            property: "#854D0E",
            string: "#166534",
            type: "#4A044E",
            typeParameter: "#1E40AF",
            variable: "#21150E",
        },
        dark: {
            comment: "#A8917E",
            constant: "#FCD34D",
            escape: "#F472B6",
            function: "#FDBA74",
            keyword: "#FB923C",
            markup: "#FCA5A5",
            parameter: "#FED7AA",
            property: "#FBCFE8",
            string: "#BEF264",
            type: "#FACC15",
            typeParameter: "#67E8F9",
            variable: "#ECE2D8",
        },
    },
    catppuccin: {
        light: {
            comment: "#7C7F93",
            constant: "#FE640B",
            escape: "#EA76CB",
            function: "#1E66F5",
            keyword: "#8839EF",
            markup: "#1E66F5",
            parameter: "#E64553",
            property: "#179299",
            string: "#40A02B",
            type: "#DF8E1D",
            typeParameter: "#04A5E5",
            variable: "#4C4F69",
        },
        dark: {
            comment: "#9399B2",
            constant: "#FAB387",
            escape: "#F5C2E7",
            function: "#89B4FA",
            keyword: "#CBA6F7",
            markup: "#89B4FA",
            parameter: "#EBA0AC",
            property: "#94E2D5",
            string: "#A6E3A1",
            type: "#F9E2AF",
            typeParameter: "#89DCEB",
            variable: "#CDD6F4",
        },
    },
    solarized: {
        light: {
            comment: "#93A1A1",
            constant: "#CB4B16",
            escape: "#CB4B16",
            function: "#268BD2",
            keyword: "#859900",
            markup: "#268BD2",
            parameter: "#657B83",
            property: "#657B83",
            string: "#2AA198",
            type: "#CB4B16",
            typeParameter: "#CB4B16",
            variable: "#268BD2",
        },
        dark: {
            comment: "#586E75",
            constant: "#CB4B16",
            escape: "#CB4B16",
            function: "#268BD2",
            keyword: "#859900",
            markup: "#268BD2",
            parameter: "#839496",
            property: "#839496",
            string: "#2AA198",
            type: "#CB4B16",
            typeParameter: "#CB4B16",
            variable: "#268BD2",
        },
    },
    tokyoNight: {
        light: {
            comment: "#888B94",
            constant: "#965027",
            escape: "#363C4D",
            function: "#2959AA",
            keyword: "#65359D",
            markup: "#2959AA",
            parameter: "#8F5E15",
            property: "#0F4B6E",
            string: "#385F0D",
            type: "#006C86",
            typeParameter: "#006C86",
            variable: "#343B58",
        },
        dark: {
            comment: "#51597D",
            constant: "#FF9E64",
            escape: "#89DDFF",
            function: "#7AA2F7",
            keyword: "#BB9AF7",
            markup: "#7AA2F7",
            parameter: "#E0AF68",
            property: "#7DCFFF",
            string: "#9ECE6A",
            type: "#0DB9D7",
            typeParameter: "#0DB9D7",
            variable: "#C0CAF5",
        },
    },
    gruvbox: {
        light: {
            comment: "#928374",
            constant: "#8F3F71",
            escape: "#AF3A03",
            function: "#79740E",
            keyword: "#9D0006",
            markup: "#79740E",
            parameter: "#076678",
            property: "#427B58",
            string: "#79740E",
            type: "#B57614",
            typeParameter: "#B57614",
            variable: "#3C3836",
        },
        dark: {
            comment: "#928374",
            constant: "#D3869B",
            escape: "#FE8019",
            function: "#B8BB26",
            keyword: "#FB4934",
            markup: "#B8BB26",
            parameter: "#83A598",
            property: "#8EC07C",
            string: "#B8BB26",
            type: "#FABD2F",
            typeParameter: "#FABD2F",
            variable: "#EBDBB2",
        },
    },
    ayu: {
        light: {
            comment: "#ADAEB1",
            constant: "#A37ACC",
            escape: "#4CBF99",
            function: "#EBA400",
            keyword: "#FA8532",
            markup: "#86B300",
            parameter: "#A37ACC",
            property: "#F07171",
            string: "#86B300",
            type: "#22A4E6",
            typeParameter: "#55B4D4",
            variable: "#5C6166",
        },
        dark: {
            comment: "#5A6673",
            constant: "#D2A6FF",
            escape: "#95E6CB",
            function: "#FFB454",
            keyword: "#FF8F40",
            markup: "#AAD94C",
            parameter: "#D2A6FF",
            property: "#F07178",
            string: "#AAD94C",
            type: "#59C2FF",
            typeParameter: "#59C2FF",
            variable: "#BFBDB6",
        },
    },
    nightOwl: {
        light: {
            comment: "#989FB1",
            constant: "#4876D6",
            escape: "#AA0982",
            function: "#4876D6",
            keyword: "#994CC3",
            markup: "#4876D6",
            parameter: "#0C969B",
            property: "#0C969B",
            string: "#4876D6",
            type: "#4876D6",
            typeParameter: "#4876D6",
            variable: "#403F53",
        },
        dark: {
            comment: "#637777",
            constant: "#82AAFF",
            escape: "#F78C6C",
            function: "#82AAFF",
            keyword: "#C792EA",
            markup: "#82B1FF",
            parameter: "#7FDBCA",
            property: "#7FDBCA",
            string: "#ECC48D",
            type: "#C5E478",
            typeParameter: "#5F7E97",
            variable: "#D6DEEB",
        },
    },
    vesper: {
        light: {
            comment: "#6E6E6E",
            constant: "#B5530A",
            escape: "#595959",
            function: "#B5530A",
            keyword: "#595959",
            markup: "#B5530A",
            parameter: "#101010",
            property: "#595959",
            string: "#0F7A5E",
            type: "#B5530A",
            typeParameter: "#B5530A",
            variable: "#101010",
        },
        dark: {
            comment: "#8B8B8B",
            constant: "#FFC799",
            escape: "#A0A0A0",
            function: "#FFC799",
            keyword: "#A0A0A0",
            markup: "#FFC799",
            parameter: "#FFFFFF",
            property: "#A0A0A0",
            string: "#99FFE4",
            type: "#FFC799",
            typeParameter: "#FFC799",
            variable: "#FFFFFF",
        },
    },
    rosePine: {
        light: {
            comment: "#9893A5",
            constant: "#286983",
            escape: "#286983",
            function: "#D7827E",
            keyword: "#286983",
            markup: "#56949F",
            parameter: "#907AA9",
            property: "#56949F",
            string: "#EA9D34",
            type: "#56949F",
            typeParameter: "#56949F",
            variable: "#575279",
        },
        dark: {
            comment: "#6E6A86",
            constant: "#31748F",
            escape: "#31748F",
            function: "#EBBCBA",
            keyword: "#31748F",
            markup: "#9CCFD8",
            parameter: "#C4A7E7",
            property: "#9CCFD8",
            string: "#F6C177",
            type: "#9CCFD8",
            typeParameter: "#9CCFD8",
            variable: "#E0DEF4",
        },
    },
    kanagawa: {
        light: {
            comment: "#8A8980",
            constant: "#CC6D00",
            escape: "#4E8CA2",
            function: "#4D699B",
            keyword: "#624C83",
            markup: "#CC6D00",
            parameter: "#5D57A3",
            property: "#B35B79",
            string: "#6F894E",
            type: "#597B75",
            typeParameter: "#597B75",
            variable: "#545464",
        },
        dark: {
            comment: "#727169",
            constant: "#FFA066",
            escape: "#9CABCA",
            function: "#7E9CD8",
            keyword: "#957FB8",
            markup: "#FFA066",
            parameter: "#B8B4D0",
            property: "#7FB4CA",
            string: "#98BB6C",
            type: "#7AA89F",
            typeParameter: "#7AA89F",
            variable: "#DCD7BA",
        },
    },
    everforest: {
        light: {
            comment: "#939F91",
            constant: "#35A77C",
            escape: "#F57D26",
            function: "#8DA101",
            keyword: "#F85552",
            markup: "#F57D26",
            parameter: "#5C6A72",
            property: "#3A94C5",
            string: "#8DA101",
            type: "#DFA000",
            typeParameter: "#DFA000",
            variable: "#5C6A72",
        },
        dark: {
            comment: "#859289",
            constant: "#83C092",
            escape: "#E69875",
            function: "#A7C080",
            keyword: "#E67E80",
            markup: "#E69875",
            parameter: "#D3C6AA",
            property: "#7FBBB3",
            string: "#A7C080",
            type: "#DBBC7F",
            typeParameter: "#DBBC7F",
            variable: "#D3C6AA",
        },
    },
    synthwave84: {
        light: {
            comment: "#5A5F8A",
            constant: "#A02E22",
            escape: "#0A6B6A",
            function: "#0A6B6A",
            keyword: "#7A5C00",
            markup: "#1A7A52",
            parameter: "#9B1F7A",
            property: "#9B1F7A",
            string: "#8A3A00",
            type: "#A00E1A",
            typeParameter: "#A00E1A",
            variable: "#9B1F7A",
        },
        dark: {
            comment: "#848BBD",
            constant: "#F97E72",
            escape: "#36F9F6",
            function: "#36F9F6",
            keyword: "#FEDE5D",
            markup: "#72F1B8",
            parameter: "#FF7EDB",
            property: "#FF7EDB",
            string: "#FF8B39",
            type: "#FE4450",
            typeParameter: "#FE4450",
            variable: "#FF7EDB",
        },
    },
    claude: {
        light: {
            comment: "#8A8780",
            constant: "#9A3412",
            escape: "#BE185D",
            function: "#C2410C",
            keyword: "#991B1B",
            markup: "#7C2D12",
            parameter: "#B45309",
            property: "#BE123C",
            string: "#166534",
            type: "#854D0E",
            typeParameter: "#0E7490",
            variable: "#141413",
        },
        dark: {
            comment: "#A09D95",
            constant: "#F97316",
            escape: "#EC4899",
            function: "#FB923C",
            keyword: "#FCA5A5",
            markup: "#FCD34D",
            parameter: "#FED7AA",
            property: "#FBCFE8",
            string: "#BEF264",
            type: "#FACC15",
            typeParameter: "#67E8F9",
            variable: "#F4F3EE",
        },
    },
    codex: {
        light: {
            comment: "#6E6E80",
            constant: "#9A3412",
            escape: "#BE185D",
            function: "#047857",
            keyword: "#065F46",
            markup: "#166534",
            parameter: "#15803D",
            property: "#0E7490",
            string: "#854D0E",
            type: "#0F766E",
            typeParameter: "#1D4ED8",
            variable: "#1A1A1A",
        },
        dark: {
            comment: "#8E8EA0",
            constant: "#FBA17E",
            escape: "#F472B6",
            function: "#6EE7B7",
            keyword: "#86EFAC",
            markup: "#A7F3D0",
            parameter: "#BBF7D0",
            property: "#67E8F9",
            string: "#FDE68A",
            type: "#5EEAD4",
            typeParameter: "#93C5FD",
            variable: "#ECECF1",
        },
    },
};

const THEME_DESCRIPTIONS: Record<ThemePreset, string> = {
    default: "The neutral baseline palette shared across Comando.",
    ocean: "Cool blues with a crisp shell and calmer contrast.",
    forest: "Muted greens built for long sessions and softer chrome.",
    rose: "Dusty pink-red accents with gentle contrast.",
    amber: "Warm earth tones that keep the workspace cozy.",
    lavender: "Soft violets with a quieter, paper-like light mode.",
    nord: "Arctic grays and icy blue accents from the Nord family.",
    sunset: "Burnt orange highlights over warm dusk surfaces.",
    catppuccin: "Pastel coding palette inspired by Catppuccin.",
    solarized: "Classic Solarized contrast with balanced warmth.",
    tokyoNight: "Tokyo Night blues with a more cinematic dark mode.",
    gruvbox: "Gruvbox warmth and contrast in both light and dark.",
    ayu: "Ayu's editorial neutrals with saffron accents.",
    nightOwl: "Night Owl contrast tuned around deep navy surfaces.",
    vesper: "A subdued studio palette with warm copper accents.",
    rosePine: "Rose Pine softness with mauve and cream surfaces.",
    kanagawa: "Japanese ink-inspired palette from Kanagawa.",
    everforest: "Everforest greens and parchment backgrounds.",
    synthwave84: "Retro magenta neon without going full glowstick.",
    claude: "Warm sandstone palette inspired by Claude's product feel.",
    codex: "The Codex green-on-neutral palette used in Comando.",
};

export const THEME_PRESET_OPTIONS: readonly ThemePresetOption[] =
    THEME_PRESET_ORDER.map((preset) => {
        const palette = THEME_PALETTES[preset];
        return {
            id: preset,
            label: palette.label,
            description: THEME_DESCRIPTIONS[preset],
            swatches: [
                palette.light.accent,
                palette.light.bgSecondary,
                palette.dark.bgPrimary,
            ],
        };
    });

export const EDITOR_FONT_FAMILY_OPTIONS: readonly EditorFontFamilyOption[] = [
    {
        id: "system",
        label: "System",
        description: "Use the platform default UI font stack.",
        group: "Sans",
        primaryFamily: "system-ui",
        preview:
            'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        source: "system",
    },
    {
        id: "sans",
        label: "Inter",
        description: "A neutral sans tuned for crisp app UI and long reading.",
        group: "Sans",
        primaryFamily: "Inter",
        preview:
            '"Inter", "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif',
        source: "bundled",
    },
    {
        id: "geist",
        label: "Geist",
        description: "A sharper modern sans with tighter spacing.",
        group: "Sans",
        primaryFamily: "Geist",
        preview: '"Geist", "Inter", system-ui, sans-serif',
        source: "bundled",
    },
    {
        id: "atkinson",
        label: "Atkinson Hyperlegible",
        description: "Optimized for legibility with distinctive letterforms.",
        group: "Sans",
        primaryFamily: "Atkinson Hyperlegible",
        preview: '"Atkinson Hyperlegible", system-ui, sans-serif',
        source: "bundled",
    },
    {
        id: "rounded",
        label: "Rounded (SF Pro)",
        description: "Softer, friendlier curves for casual writing.",
        group: "Sans",
        primaryFamily: "SF Pro Rounded",
        preview:
            '"SF Pro Rounded", "Nunito", "Avenir Next Rounded", "Hiragino Maru Gothic ProN", sans-serif',
        source: "system",
    },
    {
        id: "humanist",
        label: "Optima",
        description: "A humanist sans with warmer contrast.",
        group: "Sans",
        primaryFamily: "Optima",
        preview:
            '"Optima", "Gill Sans", "Trebuchet MS", "Segoe UI", sans-serif',
        source: "system",
    },
    {
        id: "condensed",
        label: "Condensed",
        description: "A narrower sans for denser layouts.",
        group: "Sans",
        primaryFamily: "Avenir Next Condensed",
        preview:
            '"Avenir Next Condensed", "Arial Narrow", "Roboto Condensed", "Helvetica Neue", sans-serif',
        source: "system",
    },
    {
        id: "literata",
        label: "Literata",
        description: "A literary serif built for immersive reading.",
        group: "Serif",
        primaryFamily: "Literata",
        preview: '"Literata", Georgia, serif',
        source: "bundled",
    },
    {
        id: "lora",
        label: "Lora",
        description: "A balanced serif with slightly more calligraphic rhythm.",
        group: "Serif",
        primaryFamily: "Lora",
        preview: '"Lora", "Palatino Linotype", Georgia, serif',
        source: "bundled",
    },
    {
        id: "merriweather",
        label: "Merriweather",
        description: "A sturdy serif that stays readable at small sizes.",
        group: "Serif",
        primaryFamily: "Merriweather",
        preview: '"Merriweather", Georgia, serif',
        source: "bundled",
    },
    {
        id: "reading",
        label: "Charter",
        description: "A bookish serif with a quiet editorial tone.",
        group: "Serif",
        primaryFamily: "Charter",
        preview: '"Charter", "Baskerville", "Georgia", serif',
        source: "system",
    },
    {
        id: "serif",
        label: "Palatino",
        description: "A classic serif stack that feels familiar on desktop.",
        group: "Serif",
        primaryFamily: "Iowan Old Style",
        preview:
            '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif',
        source: "system",
    },
    {
        id: "source-serif",
        label: "Source Serif",
        description: "A contemporary serif with clean contrast.",
        group: "Serif",
        primaryFamily: "Source Serif 4",
        preview: '"Source Serif 4", Georgia, "Iowan Old Style", serif',
        source: "bundled",
    },
    {
        id: "newspaper",
        label: "Times New Roman",
        description: "A sharper editorial serif for dense text blocks.",
        group: "Serif",
        primaryFamily: "Times New Roman",
        preview:
            '"Times New Roman", "Georgia", "Source Serif 4", "Iowan Old Style", serif',
        source: "system",
    },
    {
        id: "slab",
        label: "Rockwell Slab",
        description: "A slab serif with stronger weight and personality.",
        group: "Serif",
        primaryFamily: "Rockwell",
        preview:
            '"Rockwell", "Clarendon Text", "Roboto Slab", "Courier Prime", serif',
        source: "system",
    },
    {
        id: "mono",
        label: "Monospace (JetBrains)",
        description: "A versatile coding stack with JetBrains Mono first.",
        group: "Mono",
        primaryFamily: "JetBrains Mono",
        preview:
            '"JetBrains Mono", "SFMono-Regular", "Fira Code", Menlo, Monaco, Consolas, monospace',
        source: "bundled",
    },
    {
        id: "sf-mono",
        label: "SF Mono",
        description: "The native mono stack on Apple platforms.",
        group: "Mono",
        primaryFamily: "SF Mono",
        preview:
            '"SF Mono", "SFMono-Regular", "JetBrains Mono", Menlo, Monaco, Consolas, monospace',
        source: "system",
    },
    {
        id: "jetbrains",
        label: "JetBrains Mono",
        description: "A coding-first font with clean punctuation.",
        group: "Mono",
        primaryFamily: "JetBrains Mono",
        preview:
            '"JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace',
        source: "bundled",
    },
    {
        id: "geist-mono",
        label: "Geist Mono",
        description: "A tighter mono with a slightly more contemporary feel.",
        group: "Mono",
        primaryFamily: "Geist Mono",
        preview:
            '"Geist Mono", "JetBrains Mono", Menlo, Monaco, Consolas, monospace',
        source: "bundled",
    },
    {
        id: "ibm-plex-mono",
        label: "IBM Plex Mono",
        description: "A more editorial mono with softer contrast.",
        group: "Mono",
        primaryFamily: "IBM Plex Mono",
        preview:
            '"IBM Plex Mono", "JetBrains Mono", Menlo, Monaco, Consolas, monospace',
        source: "bundled",
    },
    {
        id: "courier",
        label: "Courier New",
        description: "A classic mono fallback with a familiar mechanical feel.",
        group: "Mono",
        primaryFamily: "Courier New",
        preview: '"Courier New", Courier, "Nimbus Mono PS", monospace',
        source: "system",
    },
    {
        id: "andale",
        label: "Andale Mono",
        description: "A compact mono that stays readable in denser UIs.",
        group: "Mono",
        primaryFamily: "Andale Mono",
        preview: '"Andale Mono", Menlo, Monaco, Consolas, monospace',
        source: "system",
    },
    {
        id: "typewriter",
        label: "Typewriter",
        description: "A warmer mono stack with analog typewriter character.",
        group: "Mono",
        primaryFamily: "American Typewriter",
        preview:
            '"American Typewriter", "Courier Prime", "Courier New", "Nimbus Mono PS", monospace',
        source: "system",
    },
    {
        id: "cascadia-code",
        label: "Cascadia Code",
        description: "A wider mono face that stays readable at smaller sizes.",
        group: "Mono",
        primaryFamily: "Cascadia Code",
        preview:
            '"Cascadia Code", "JetBrains Mono", "SFMono-Regular", Menlo, Monaco, Consolas, monospace',
        source: "system",
    },
];

function hexToRgba(hex: string, opacity: number): string {
    const normalized = hex.replace("#", "");
    if (normalized.length !== 6) {
        return hex;
    }

    const red = Number.parseInt(normalized.slice(0, 2), 16);
    const green = Number.parseInt(normalized.slice(2, 4), 16);
    const blue = Number.parseInt(normalized.slice(4, 6), 16);

    return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

// Minimum WCAG AA contrast for body text.
const MIN_AA_CONTRAST = 4.5;

function hexChannels(hex: string): readonly [number, number, number] {
    const normalized = hex.replace("#", "");
    return [
        Number.parseInt(normalized.slice(0, 2), 16),
        Number.parseInt(normalized.slice(2, 4), 16),
        Number.parseInt(normalized.slice(4, 6), 16),
    ];
}

function channelsToHex(
    channels: readonly [number, number, number],
): string {
    const clamp = (value: number) =>
        Math.max(0, Math.min(255, Math.round(value)))
            .toString(16)
            .padStart(2, "0")
            .toUpperCase();
    return `#${clamp(channels[0])}${clamp(channels[1])}${clamp(channels[2])}`;
}

function relativeLuminance(hex: string): number {
    const [red, green, blue] = hexChannels(hex).map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.03928
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(a: string, b: string): number {
    const aLum = relativeLuminance(a);
    const bLum = relativeLuminance(b);
    const lighter = Math.max(aLum, bLum);
    const darker = Math.min(aLum, bLum);
    return (lighter + 0.05) / (darker + 0.05);
}

// Shift a color toward the target contrast against `background` by moving it
// away from the background's luminance. Preserves hue/saturation by scaling
// RGB channels proportionally.
function boostContrast(color: string, background: string): string {
    if (contrastRatio(color, background) >= MIN_AA_CONTRAST) {
        return color;
    }
    const bgLum = relativeLuminance(background);
    const channels = hexChannels(color);
    const shouldDarken = bgLum > 0.5;
    // Try 20 increasing-intensity steps; stop at the first that clears AA.
    for (let step = 1; step <= 20; step += 1) {
        const factor = shouldDarken ? 1 - step * 0.05 : 1 + step * 0.08;
        const shifted = channels.map((channel) => {
            if (shouldDarken) {
                return channel * factor;
            }
            // Lighten by lerping toward white.
            return channel + (255 - channel) * (step * 0.06);
        }) as [number, number, number];
        const candidate = channelsToHex(shifted);
        if (contrastRatio(candidate, background) >= MIN_AA_CONTRAST) {
            return candidate;
        }
    }
    // Fallback: pick pure black or white depending on background luminance.
    return bgLum > 0.5 ? "#000000" : "#FFFFFF";
}

function applyCodeContrastBoost(
    anchors: ComandoCodeColorAnchors,
    background: string,
): ComandoCodeColorAnchors {
    return {
        comment: boostContrast(anchors.comment, background),
        constant: boostContrast(anchors.constant, background),
        escape: boostContrast(anchors.escape, background),
        function: boostContrast(anchors.function, background),
        keyword: boostContrast(anchors.keyword, background),
        markup: boostContrast(anchors.markup, background),
        parameter: boostContrast(anchors.parameter, background),
        property: boostContrast(anchors.property, background),
        string: boostContrast(anchors.string, background),
        type: boostContrast(anchors.type, background),
        typeParameter: boostContrast(anchors.typeParameter, background),
        variable: boostContrast(anchors.variable, background),
    };
}

function createThemeTokens(
    colors: ThemeColors,
    code: ComandoCodeColorAnchors,
    isDark: boolean,
): ComandoThemeTokens {
    return {
        accent: colors.accent,
        accentSoft: hexToRgba(colors.accent, isDark ? 0.16 : 0.12),
        accentStrong: colors.accent,
        app: colors.bgPrimary,
        bgChrome: colors.bgSecondary,
        bgElevated: colors.bgElevated,
        bgPanel: colors.bgSecondary,
        bgPrimary: colors.bgPrimary,
        bgSecondary: colors.bgSecondary,
        bgTertiary: colors.bgTertiary,
        border: colors.border,
        borderStrong: colors.border,
        borderSubtle: hexToRgba(colors.border, isDark ? 0.45 : 0.35),
        code,
        editor: colors.bgPrimary,
        editorText: colors.textPrimary,
        selection: hexToRgba(colors.accent, isDark ? 0.2 : 0.12),
        shadowSoft: colors.shadowSoft,
        textPrimary: colors.textPrimary,
        textSecondary: colors.textSecondary,
    };
}

export function resolveComandoThemeTokens(
    preset: ThemePreset,
    isDark: boolean,
    boostCodeContrast: boolean,
): ComandoThemeTokens {
    const palette = THEME_PALETTES[preset];
    const colors = isDark ? palette.dark : palette.light;
    const codePalette = CODE_PALETTES[preset];
    const rawCode = isDark ? codePalette.dark : codePalette.light;
    const code = boostCodeContrast
        ? applyCodeContrastBoost(rawCode, colors.bgPrimary)
        : rawCode;
    return createThemeTokens(colors, code, isDark);
}

export function getDefaultAppAppearance(): AppAppearanceSettings {
    return {
        agentsSidebarScale: AGENTS_SIDEBAR_SCALE_DEFAULT,
        boostCodeContrast: true,
        chromeTransparency: CHROME_TRANSPARENCY_DEFAULT,
        fileTreeScale: FILE_TREE_SCALE_DEFAULT,
        stickyFoldersEnabled: true,
        themeMode: "system",
        themePreset: "default",
        transparencyEnabled: true,
        zoomFactor: APP_ZOOM_FACTOR_DEFAULT,
    };
}

export function getDefaultAppEditorSettings(): AppEditorSettings {
    return {
        autoSaveDelayMs: EDITOR_AUTOSAVE_DELAY_MS_DEFAULT,
        fontFamily: DEFAULT_EDITOR_FONT_FAMILY,
        fontSize: DEFAULT_EDITOR_FONT_SIZE,
        lineHeight: 1.55,
        minimapEnabled: true,
        relativeLineNumbersEnabled: false,
        suggestionsEnabled: true,
        vimModeEnabled: false,
    };
}

export function getDefaultAiChatSettings(): AppAiChatSettings {
    return {
        chatFontFamily: DEFAULT_AI_CHAT_FONT_FAMILY,
        chatFontSize: DEFAULT_AI_CHAT_FONT_SIZE,
        composerFontFamily: DEFAULT_AI_COMPOSER_FONT_FAMILY,
        composerFontSize: DEFAULT_AI_COMPOSER_FONT_SIZE,
        reviewDiffZoom: DEFAULT_AI_DIFF_ZOOM,
        requireCmdEnterToSend: false,
        screenshotRetentionSeconds: 0,
        historyRetentionDays: 0,
        contextUsageBarEnabled: true,
        toolActivityDefaultExpansion: "collapsed",
    };
}

export interface ChatFontFamilyOption {
    readonly group?: "Sans" | "Serif" | "Mono";
    readonly id: ChatFontFamily;
    readonly label: string;
    readonly primaryFamily: string;
    readonly source: "bundled" | "system";
}

export const CHAT_FONT_FAMILY_OPTIONS: readonly ChatFontFamilyOption[] =
    EDITOR_FONT_FAMILY_OPTIONS.map((fontFamily) => ({
        group: fontFamily.group,
        id: fontFamily.id,
        label: fontFamily.label,
        primaryFamily: fontFamily.primaryFamily,
        source: fontFamily.source,
    }));

export function resolveAppearance(
    appAppearance: AppAppearanceSettings | null | undefined,
): AppAppearanceSettings {
    const defaults = getDefaultAppAppearance();

    return {
        agentsSidebarScale: clampAgentsSidebarScale(
            appAppearance?.agentsSidebarScale ?? defaults.agentsSidebarScale,
        ),
        boostCodeContrast:
            appAppearance?.boostCodeContrast ?? defaults.boostCodeContrast,
        chromeTransparency: clampChromeTransparency(
            appAppearance?.chromeTransparency ?? defaults.chromeTransparency,
        ),
        fileTreeScale: clampFileTreeScale(
            appAppearance?.fileTreeScale ?? defaults.fileTreeScale,
        ),
        stickyFoldersEnabled:
            appAppearance?.stickyFoldersEnabled ??
            defaults.stickyFoldersEnabled,
        themeMode: appAppearance?.themeMode ?? defaults.themeMode,
        themePreset: appAppearance?.themePreset ?? defaults.themePreset,
        transparencyEnabled:
            appAppearance?.transparencyEnabled ?? defaults.transparencyEnabled,
        zoomFactor: clampAppZoomFactor(
            appAppearance?.zoomFactor ?? defaults.zoomFactor,
        ),
    };
}

export function resolveEditorSettings(
    appEditor: AppEditorSettings | null | undefined,
): AppEditorSettings {
    const defaults = getDefaultAppEditorSettings();

    return {
        autoSaveDelayMs: clampEditorAutosaveDelayMs(
            appEditor?.autoSaveDelayMs ?? defaults.autoSaveDelayMs,
        ),
        fontFamily: appEditor?.fontFamily ?? defaults.fontFamily,
        fontSize: appEditor?.fontSize ?? defaults.fontSize,
        lineHeight: appEditor?.lineHeight ?? defaults.lineHeight,
        minimapEnabled: appEditor?.minimapEnabled ?? defaults.minimapEnabled,
        relativeLineNumbersEnabled:
            appEditor?.relativeLineNumbersEnabled ??
            defaults.relativeLineNumbersEnabled,
        suggestionsEnabled:
            appEditor?.suggestionsEnabled ?? defaults.suggestionsEnabled,
        vimModeEnabled: appEditor?.vimModeEnabled ?? defaults.vimModeEnabled,
    };
}

export function buildEditorFontFamily(fontFamily: EditorFontFamily): string {
    switch (fontFamily) {
        case "sans":
            return '"Inter", "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif';
        case "geist":
            return '"Geist", "Inter", system-ui, sans-serif';
        case "atkinson":
            return '"Atkinson Hyperlegible", system-ui, sans-serif';
        case "serif":
            return '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif';
        case "literata":
            return '"Literata", Georgia, serif';
        case "lora":
            return '"Lora", "Palatino Linotype", Georgia, serif';
        case "merriweather":
            return '"Merriweather", Georgia, serif';
        case "source-serif":
            return '"Source Serif 4", Georgia, "Iowan Old Style", serif';
        case "reading":
            return '"Charter", "Baskerville", "Georgia", serif';
        case "newspaper":
            return '"Times New Roman", "Georgia", "Source Serif 4", "Iowan Old Style", serif';
        case "slab":
            return '"Rockwell", "Clarendon Text", "Roboto Slab", "Courier Prime", serif';
        case "rounded":
            return '"SF Pro Rounded", "Nunito", "Avenir Next Rounded", "Hiragino Maru Gothic ProN", sans-serif';
        case "humanist":
            return '"Optima", "Gill Sans", "Trebuchet MS", "Segoe UI", sans-serif';
        case "condensed":
            return '"Avenir Next Condensed", "Arial Narrow", "Roboto Condensed", "Helvetica Neue", sans-serif';
        case "mono":
            return '"JetBrains Mono", "SFMono-Regular", "Fira Code", Menlo, Monaco, Consolas, monospace';
        case "jetbrains":
        case "jetbrains-mono":
            return '"JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace';
        case "geist-mono":
            return '"Geist Mono", "JetBrains Mono", Menlo, Monaco, Consolas, monospace';
        case "courier":
            return '"Courier New", Courier, "Nimbus Mono PS", monospace';
        case "andale":
            return '"Andale Mono", Menlo, Monaco, Consolas, monospace';
        case "typewriter":
            return '"American Typewriter", "Courier Prime", "Courier New", "Nimbus Mono PS", monospace';
        case "cascadia-code":
            return '"Cascadia Code", "JetBrains Mono", "SFMono-Regular", Menlo, Monaco, Consolas, monospace';
        case "ibm-plex-mono":
            return '"IBM Plex Mono", "JetBrains Mono", Menlo, Monaco, Consolas, monospace';
        case "sf-mono":
            return '"SF Mono", "SFMono-Regular", "JetBrains Mono", Menlo, Monaco, Consolas, monospace';
        case "system":
        default:
            return 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    }
}

export function buildChatFontFamily(fontFamily: ChatFontFamily): string {
    return buildEditorFontFamily(fontFamily);
}

export function resolveIsDark(
    themeMode: ThemeMode,
    systemIsDark: boolean,
): boolean {
    if (themeMode === "dark") {
        return true;
    }

    if (themeMode === "light") {
        return false;
    }

    return systemIsDark;
}

export function applyAppearance(
    appearance: AppAppearanceSettings,
    systemIsDark: boolean,
): void {
    const isDark = resolveIsDark(appearance.themeMode, systemIsDark);
    const palette = resolveComandoThemeTokens(
        appearance.themePreset,
        isDark,
        appearance.boostCodeContrast,
    );
    const root = document.documentElement;

    root.classList.toggle("dark", isDark);
    root.setAttribute(
        "data-transparency-enabled",
        appearance.transparencyEnabled ? "true" : "false",
    );
    root.style.setProperty(
        "--chrome-transparency",
        `${appearance.chromeTransparency}%`,
    );
    root.style.setProperty("--color-app", palette.app);
    root.style.setProperty("--color-bg-primary", palette.bgPrimary);
    root.style.setProperty("--color-bg-secondary", palette.bgSecondary);
    root.style.setProperty("--color-bg-tertiary", palette.bgTertiary);
    root.style.setProperty("--color-bg-elevated", palette.bgElevated);
    root.style.setProperty("--color-bg-panel", palette.bgPanel);
    root.style.setProperty("--color-bg-chrome", palette.bgChrome);
    root.style.setProperty("--color-editor", palette.editor);
    root.style.setProperty("--color-text-primary", palette.textPrimary);
    root.style.setProperty("--color-text-secondary", palette.textSecondary);
    root.style.setProperty("--color-editor-text", palette.editorText);
    root.style.setProperty("--color-border", palette.border);
    root.style.setProperty("--color-border-strong", palette.borderStrong);
    root.style.setProperty("--color-border-subtle", palette.borderSubtle);
    root.style.setProperty("--color-accent", palette.accent);
    root.style.setProperty("--color-accent-soft", palette.accentSoft);
    root.style.setProperty("--color-accent-strong", palette.accentStrong);
    root.style.setProperty("--color-selection", palette.selection);
    root.style.setProperty("--shadow-soft", palette.shadowSoft);
    root.style.setProperty("--code-color-comment", palette.code.comment);
    root.style.setProperty("--code-color-constant", palette.code.constant);
    root.style.setProperty("--code-color-escape", palette.code.escape);
    root.style.setProperty("--code-color-function", palette.code.function);
    root.style.setProperty("--code-color-keyword", palette.code.keyword);
    root.style.setProperty("--code-color-markup", palette.code.markup);
    root.style.setProperty("--code-color-parameter", palette.code.parameter);
    root.style.setProperty("--code-color-property", palette.code.property);
    root.style.setProperty("--code-color-string", palette.code.string);
    root.style.setProperty("--code-color-type", palette.code.type);
    root.style.setProperty(
        "--code-color-typeparameter",
        palette.code.typeParameter,
    );
    root.style.setProperty("--code-color-variable", palette.code.variable);
    root.style.setProperty(
        "--file-tree-scale",
        String(clampFileTreeScale(appearance.fileTreeScale)),
    );
    const sidebarListScale = String(
        clampAgentsSidebarScale(appearance.agentsSidebarScale),
    );
    root.style.setProperty("--sidebar-list-scale", sidebarListScale);
    root.style.setProperty("--agents-sidebar-scale", sidebarListScale);
}
