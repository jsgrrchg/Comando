import { resolveCatppuccinFileIcon } from "./FileTypeIcon";
import {
    getCatppuccinIcon,
    getCatppuccinViewBox,
    getThemedCatppuccinIconBody,
} from "./catppuccin-icons";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export function createFileTypeIconElement(
    fileName: string,
    size: number,
): SVGSVGElement | null {
    const { iconName } = resolveCatppuccinFileIcon(fileName);
    const icon = getCatppuccinIcon(iconName);
    if (!icon) {
        return null;
    }

    const svg = document.createElementNS(SVG_NAMESPACE, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", getCatppuccinViewBox(icon));
    svg.setAttribute("width", String(size));
    svg.dataset.composerFileIcon = "true";
    svg.style.display = "block";
    svg.style.flexShrink = "0";
    svg.innerHTML = getThemedCatppuccinIconBody(icon.body);
    return svg;
}
