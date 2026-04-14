import { useProjectsStore } from "../store/projects-store";
import { useResolvedAppearance } from "./use-resolved-appearance";

export function useSystemTheme(): void {
    const activeProjectId = useProjectsStore((state) => state.activeProjectId);

    useResolvedAppearance(activeProjectId);
}
